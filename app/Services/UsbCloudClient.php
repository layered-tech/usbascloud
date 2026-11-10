<?php

namespace App\Services;

use Closure;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Sleep;
use Illuminate\Support\Str;
use RuntimeException;
use Throwable;

class UsbCloudClient
{
    private ?Closure $onOutput = null;

    /** @param array<string, mixed> $connection */
    public function __construct(private array $connection = []) {}

    /** @return array<string, mixed> */
    public function control(string $action): array
    {
        if (! in_array($action, ['start', 'detach', 'logs'], true)) {
            throw new RuntimeException('Unsupported device command.');
        }

        $output = $this->ssh('sudo -n usbcloud-client '.$action);

        return $action === 'start' ? ['message' => $output] : json_decode($output, true, flags: JSON_THROW_ON_ERROR);
    }

    /** @return array<string, mixed> */
    public function status(?Closure $onOutput = null): array
    {
        $previous = $this->onOutput;
        $this->onOutput = $onOutput ?? $previous;
        try {
            return ['online' => true, 'state' => json_decode($this->ssh('sudo -n usbcloud-client status'), true, flags: JSON_THROW_ON_ERROR), 'error' => null];
        } catch (Throwable $e) {
            return ['online' => false, 'state' => null, 'error' => $e->getMessage()];
        } finally {
            $this->onOutput = $previous;
        }
    }

    /** @return array<int, array<string, mixed>> */
    public function runs(?int $limit = 10): array
    {
        $paths = collect(File::glob($this->directory().'/*/result.json'))->sortDesc();

        return ($limit === null ? $paths : $paths->take($limit))
            ->map(fn (string $path): array => json_decode(File::get($path), true, flags: JSON_THROW_ON_ERROR))->values()->all();
    }

    /** @return array<string, mixed> */
    public function retrieve(?Closure $onOutput = null, bool $copy = true, ?Closure $onProgress = null, ?Closure $control = null): array
    {
        $this->onOutput = $onOutput;
        $this->consolidateLegacyFiles();
        $id = (string) Str::ulid();
        $directory = $this->directory().'/'.$id;
        File::ensureDirectoryExists($directory.'/files');
        $run = ['id' => $id, 'at' => now()->toIso8601String(), 'kind' => $copy ? 'pull' : 'scan', 'success' => false, 'files' => [], 'already_saved' => 0, 'log' => [], 'error' => null];
        $token = null;
        try {
            $before = $this->status();
            $run['before'] = $before;
            if (! $before['online']) {
                throw new RuntimeException((string) $before['error']);
            }
            $run['log'][] = 'Opening a read-only snapshot on the Pi.';
            $timeout = (int) ($this->connection['snapshot_timeout'] ?? 600);
            $openCommand = 'sudo -n usbcloud-client snapshot-open'.(isset($this->connection['snapshot_timeout']) ? ' --timeout '.$timeout : '');
            $onProgress?->__invoke(['stage' => 'Opening snapshot']);
            $lease = json_decode($this->ssh($openCommand), true, flags: JSON_THROW_ON_ERROR);
            if (! is_string($lease['token'] ?? null) || ! preg_match('/\A[a-f0-9]{32}\z/', $lease['token'])) {
                throw new RuntimeException('The Pi returned an invalid snapshot token. Its expiry timer will clean up the snapshot.');
            }
            $token = $lease['token'];
            $snapshotPath = $lease['path'] ?? null;
            if (! in_array($snapshotPath, ['/srv/usbcloud-client/snapshot', '/srv/blink-poc/snapshot'], true)) {
                throw new RuntimeException('The Pi returned an unexpected snapshot path.');
            }
            $run['log'][] = 'Requesting SHA-256 checksums from the Pi snapshot.';
            $started = microtime(true);
            $onProgress?->__invoke(['stage' => 'Hashing files on Pi']);
            $manifest = json_decode($this->ssh('sudo -n usbcloud-client snapshot-manifest --token '.$token), true, flags: JSON_THROW_ON_ERROR);
            if (! is_array($manifest['files'] ?? null) || ! array_is_list($manifest['files'])) {
                throw new RuntimeException('The Pi returned an invalid file manifest.');
            }
            foreach ($manifest['files'] as $entry) {
                if (! is_array($entry) || ! is_string($entry['name'] ?? null)
                    || ! is_string($entry['sha256'] ?? null) || ! preg_match('/\A[a-f0-9]{64}\z/', $entry['sha256'])
                    || ! is_int($entry['bytes'] ?? null) || $entry['bytes'] < 0
                    || preg_match('/[\x00-\x1f\x7f\\\\]/', $entry['name'])
                    || str_starts_with($entry['name'], '/')
                    || collect(explode('/', $entry['name']))->contains(fn (string $part): bool => in_array($part, ['', '.', '..'], true))) {
                    throw new RuntimeException('The Pi returned an unsafe or invalid manifest entry.');
                }
            }
            $inventory = ['at' => now()->toIso8601String(), 'files' => $manifest['files'], 'filesystem' => $manifest['filesystem'] ?? null];
            File::replace($this->directory().'/inventory.json', json_encode($inventory, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR));
            $newFiles = array_filter($manifest['files'], fn (array $entry): bool => ! (File::isFile($this->directory().'/objects/'.$entry['sha256']) && File::size($this->directory().'/objects/'.$entry['sha256']) === $entry['bytes'] && hash_file('sha256', $this->directory().'/objects/'.$entry['sha256']) === $entry['sha256']));
            $totalBytes = array_sum(array_column($newFiles, 'bytes'));
            $doneBytes = 0;
            $onProgress?->__invoke(['stage' => 'Transferring', 'total_files' => count($newFiles), 'total_bytes' => $totalBytes, 'done_files' => 0, 'done_bytes' => 0, 'skipped' => count($manifest['files']) - count($newFiles)]);
            foreach ($manifest['files'] as $entry) {
                if ($control && $control()) {
                    throw new RuntimeException('Transfer interrupted.');
                }
                if (! $copy) {
                    continue;
                }
                $digest = $entry['sha256'];
                $destination = $this->directory().'/objects/'.$digest;
                if (File::isFile($destination) && File::size($destination) === $entry['bytes'] && hash_file('sha256', $destination) === $digest) {
                    $run['already_saved']++;
                    $this->onOutput?->__invoke('Skipping already saved: '.$entry['name']."\n");

                    continue;
                }
                if (microtime(true) - $started > $timeout - 5) {
                    throw new RuntimeException('Transfer window exhausted. Retry to retrieve the remaining new files.');
                }
                $temporary = $directory.'/files/'.$digest.'.partial';
                $this->onOutput?->__invoke('Transferring new file: '.$entry['name']."\n");
                $onProgress?->__invoke(['current_file' => $entry['name'], 'current_bytes' => 0, 'current_total' => $entry['bytes']]);
                $limit = (float) ($this->connection['bandwidth'] ?? 0);
                $streaming = ($this->connection['transfer_protocol'] ?? config('usbcloud-client.transfer_protocol')) === 'stream';
                $command = ['scp', ...($limit > 0 ? ['-l', (string) max(1, (int) ($limit * 8000))] : []), ...$this->options(), $this->target().':'.$snapshotPath.'/'.$entry['name'], $temporary];
                if ($streaming) {
                    $encoded = strtr(base64_encode($entry['name']), '+/', '-_');
                    $command = ['ssh', ...$this->options(), $this->target(), 'sudo -n usbcloud-client snapshot-read --token '.$token.' --path '.$encoded];
                }
                $this->transferFile($command, $temporary, $entry['bytes'], $doneBytes, $totalBytes, $timeout, $onProgress, $control, $streaming, $limit);
                clearstatcache(true, $temporary);
                if (File::size($temporary) !== $entry['bytes'] || hash_file('sha256', $temporary) !== $digest) {
                    throw new RuntimeException('Downloaded file does not match the Pi checksum: '.$entry['name']);
                }
                File::move($temporary, $destination);
                $doneBytes += $entry['bytes'];
                $onProgress?->__invoke(['done_bytes' => $doneBytes, 'current_bytes' => 0, 'current_total' => 0, 'current_file' => null, 'done_files' => count($run['files']) + 1]);
                $run['files'][] = [
                    'id' => count($run['files']), 'name' => $entry['name'],
                    'bytes' => $entry['bytes'], 'sha256' => $digest,
                    'modified_at' => $entry['modified_at'] ?? null,
                    'video' => strtolower(pathinfo($entry['name'], PATHINFO_EXTENSION)) === 'mp4',
                ];
            }
            $run['success'] = true;
            $run['log'][] = $copy
                ? count($run['files']).' new files saved; '.$run['already_saved'].' already saved files skipped. SHA-256 hashes calculated on the Pi; downloaded files verified on this server.'
                : count($manifest['files']).' files scanned. No file contents transferred.';
        } catch (Throwable $e) {
            if ($control && $control()) {
                $run['interrupted'] = $control();
            }
            $run['error'] = $e->getMessage();
        } finally {
            File::deleteDirectory($directory.'/files');
            if ($token !== null) {
                try {
                    $this->ssh('sudo -n usbcloud-client snapshot-close --token '.$token);
                    $run['log'][] = 'Snapshot closed.';
                } catch (Throwable $e) {
                    $run['success'] = false;
                    $run['error'] = trim(($run['error'] ?? '').' Snapshot cleanup failed: '.$e->getMessage());
                }
            }
        }
        $run['after'] = $this->status();
        $run['log'][] = 'Pi status checked after retrieval.';
        File::put($directory.'/result.json', json_encode($run, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR));

        return $run;
    }

    /** @param list<string> $command */
    private function transferFile(array $command, string $temporary, int $size, int $done, int $total, int $timeout, ?Closure $progress, ?Closure $control, bool $streaming = false, float $limit = 0): void
    {
        $started = microtime(true);
        $received = 0;
        $stream = $streaming ? fopen($temporary, 'wb') : null;
        if ($streaming && ! is_resource($stream)) {
            throw new RuntimeException('Cannot create the downloaded file.');
        }
        $process = null;
        try {
            $process = Process::timeout($timeout)->start($command, function (string $type, string $data) use ($stream, $streaming, $limit, $started, $progress, $control, $done, $total, &$received): void {
                if ($streaming && $type === 'out' && is_resource($stream)) {
                    $length = strlen($data);
                    $offset = 0;
                    while ($offset < $length) {
                        $written = fwrite($stream, substr($data, $offset));
                        if ($written === false || $written === 0) {
                            throw new RuntimeException('Cannot save the downloaded file.');
                        }
                        $offset += $written;
                    }
                    $received += $length;
                    if ($limit > 0) {
                        $delay = $received / ($limit * 1000000) - (microtime(true) - $started);
                        while ($delay > 0) {
                            if ($control && $control()) {
                                throw new RuntimeException('Transfer interrupted.');
                            }
                            $rate = (int) ($received / max(0.1, microtime(true) - $started));
                            $progress?->__invoke(['current_bytes' => $received, 'rate' => $rate, 'eta' => $rate > 0 ? (int) ceil(($total - $done - $received) / $rate) : null]);
                            Sleep::for((int) min(200000, $delay * 1000000))->microseconds();
                            $delay = $received / ($limit * 1000000) - (microtime(true) - $started);
                        }
                    }
                }
            });
            while ($process->running()) {
                if ($control && $control()) {
                    $process->signal(15);
                    $process->wait();
                    throw new RuntimeException('Transfer interrupted.');
                }
                clearstatcache(true, $temporary);
                $current = is_file($temporary) ? min($size, filesize($temporary)) : 0;
                $rate = (int) ($current / max(0.1, microtime(true) - $started));
                $progress?->__invoke(['current_bytes' => $current, 'rate' => $rate, 'eta' => $rate > 0 ? (int) ceil(($total - $done - $current) / $rate) : null]);
                Sleep::for(20)->milliseconds();
            }
            $result = $process->wait();
            if ($result->failed()) {
                throw new RuntimeException(trim($result->errorOutput()) ?: 'File transfer failed.');
            }
        } finally {
            if (is_resource($stream)) {
                fclose($stream);
            }
            if ($process !== null && $process->running()) {
                $process->signal(15);
                $process->wait();
            }
        }
    }

    /** @param array<string, mixed> $entry */
    public function filePath(string $run, array $entry): ?string
    {
        $digest = $entry['sha256'] ?? '';
        if (is_string($digest) && preg_match('/\A[a-f0-9]{64}\z/', $digest)) {
            $object = $this->directory().'/objects/'.$digest;
            if (is_file($object)) {
                return $object;
            }
        }
        $base = realpath($this->directory().'/'.$run.'/files');
        $path = realpath($this->directory().'/'.$run.'/files/'.($entry['name'] ?? ''));

        return $base && $path && str_starts_with($path, $base.DIRECTORY_SEPARATOR) && is_file($path) ? $path : null;
    }

    private function consolidateLegacyFiles(): void
    {
        File::ensureDirectoryExists($this->directory().'/objects');
        foreach (File::glob($this->directory().'/*/result.json') as $manifest) {
            $result = json_decode(File::get($manifest), true, flags: JSON_THROW_ON_ERROR);
            foreach ($result['files'] as $entry) {
                $legacy = dirname($manifest).'/files/'.$entry['name'];
                $base = realpath(dirname($manifest).'/files');
                $path = realpath($legacy);
                if (! $base || ! $path || ! str_starts_with($path, $base.DIRECTORY_SEPARATOR) || ! is_file($path)) {
                    continue;
                }
                $digest = hash_file('sha256', $path);
                if ($digest !== $entry['sha256']) {
                    throw new RuntimeException('A saved file no longer matches its recorded checksum: '.$entry['name']);
                }
                $object = $this->directory().'/objects/'.$digest;
                if (File::exists($object)) {
                    if (hash_file('sha256', $object) !== $digest) {
                        throw new RuntimeException('A saved object failed checksum verification.');
                    }
                    File::delete($path);
                } else {
                    File::move($path, $object);
                }
            }
            File::deleteDirectory(dirname($manifest).'/files');
        }
    }

    public function directory(): string
    {
        return $this->connection['directory'] ?? (string) config('usbcloud-client.directory');
    }

    /** @param array<string, string> $configuration */
    public function configureHeartbeat(array $configuration): void
    {
        $result = Process::timeout(30)->input(json_encode($configuration, JSON_THROW_ON_ERROR))
            ->run(['ssh', ...$this->options(), $this->target(), 'sudo -n usbcloud-client heartbeat-configure']);
        if (! $result->successful()) {
            throw new RuntimeException('Heartbeat setup failed. Install the latest client and check its service.');
        }
    }

    private function ssh(string $command): string
    {
        return $this->execute(['ssh', ...$this->options(), $this->target(), $command]);
    }

    /** @param array<int, string> $command */
    private function execute(array $command): string
    {
        if ($this->onOutput !== null) {
            ($this->onOutput)('$ '.implode(' ', array_map(escapeshellarg(...), $command))."\n");
        }
        $result = Process::timeout($command[0] === 'scp' ? 90 : (str_contains(end($command), 'snapshot-manifest') ? 120 : (in_array(end($command), ['sudo -n usbcloud-client status', 'sudo -n usbcloud-client logs'], true) ? 12 : 30)))->run($command, function (string $type, string $output): void {
            if ($this->onOutput !== null) {
                ($this->onOutput)($output);
            }
        });
        if ($result->failed()) {
            throw new RuntimeException(trim($result->errorOutput().' '.$result->output()) ?: 'The Pi command failed.');
        }

        return trim($result->output());
    }

    /** @return array<int, string> */
    private function options(): array
    {
        $identity = $this->connection['identity'] ?? (string) config('usbcloud-client.identity');
        $agent = $identity === storage_path('app/private/usbcloud/ssh/id_ed25519') ? ['-o', 'IdentityAgent=none'] : (getenv('SSH_AUTH_SOCK') ? ['-o', 'IdentityAgent=SSH_AUTH_SOCK'] : []);
        if (isset($this->connection['known_hosts_file'])) {
            $agent = [...$agent, '-o', 'UserKnownHostsFile='.$this->connection['known_hosts_file'], '-o', 'GlobalKnownHostsFile=/dev/null'];
        }

        return [...$agent, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=yes', '-o', 'IdentitiesOnly=yes', '-o', 'Port='.(int) ($this->connection['port'] ?? 22), '-o', 'HostKeyAlias='.($this->connection['host_key_alias'] ?? $this->connection['host'] ?? config('usbcloud-client.host_key_alias')), '-i', $this->connection['identity'] ?? (string) config('usbcloud-client.identity')];
    }

    private function target(): string
    {
        return ($this->connection['user'] ?? config('usbcloud-client.user')).'@'.($this->connection['host'] ?? config('usbcloud-client.host'));
    }
}
