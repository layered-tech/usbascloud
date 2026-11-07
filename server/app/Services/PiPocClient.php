<?php

namespace App\Services;

use Closure;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Str;
use RuntimeException;
use Throwable;

class PiPocClient
{
    private ?Closure $onOutput = null;

    /** @param array<string, string> $connection */
    public function __construct(private array $connection = []) {}

    /** @return array<string, mixed> */
    public function control(string $action): array
    {
        if (! in_array($action, ['start', 'detach', 'logs'], true)) {
            throw new RuntimeException('Unsupported device command.');
        }

        $output = $this->ssh('sudo -n blink-poc '.$action);

        return $action === 'start' ? ['message' => $output] : json_decode($output, true, flags: JSON_THROW_ON_ERROR);
    }

    /** @return array<string, mixed> */
    public function status(?Closure $onOutput = null): array
    {
        $previous = $this->onOutput;
        $this->onOutput = $onOutput ?? $previous;
        try {
            return ['online' => true, 'state' => json_decode($this->ssh('sudo -n blink-poc status'), true, flags: JSON_THROW_ON_ERROR), 'error' => null];
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
    public function retrieve(?Closure $onOutput = null, bool $copy = true): array
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
            $lease = json_decode($this->ssh('sudo -n blink-poc snapshot-open'), true, flags: JSON_THROW_ON_ERROR);
            if (! is_string($lease['token'] ?? null) || ! preg_match('/\A[a-f0-9]{32}\z/', $lease['token'])) {
                throw new RuntimeException('The Pi returned an invalid snapshot token. Its expiry timer will clean up the snapshot.');
            }
            $token = $lease['token'];
            if (($lease['path'] ?? null) !== '/srv/blink-poc/snapshot') {
                throw new RuntimeException('The Pi returned an unexpected snapshot path.');
            }
            $run['log'][] = 'Requesting SHA-256 checksums from the Pi snapshot.';
            $started = microtime(true);
            $manifest = json_decode($this->ssh('sudo -n blink-poc snapshot-manifest --token '.$token), true, flags: JSON_THROW_ON_ERROR);
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
            foreach ($manifest['files'] as $entry) {
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
                if (microtime(true) - $started > 300) {
                    throw new RuntimeException('Transfer window exhausted. Retry to retrieve the remaining new files.');
                }
                $temporary = $directory.'/files/'.$digest.'.partial';
                $this->onOutput?->__invoke('Transferring new file: '.$entry['name']."\n");
                $this->execute(['scp', '-v', ...$this->options(), $this->target().':/srv/blink-poc/snapshot/'.$entry['name'], $temporary]);
                if (File::size($temporary) !== $entry['bytes'] || hash_file('sha256', $temporary) !== $digest) {
                    throw new RuntimeException('Downloaded file does not match the Pi checksum: '.$entry['name']);
                }
                File::move($temporary, $destination);
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
            $run['error'] = $e->getMessage();
        } finally {
            File::deleteDirectory($directory.'/files');
            if ($token !== null) {
                try {
                    $this->ssh('sudo -n blink-poc snapshot-close --token '.$token);
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
        return $this->connection['directory'] ?? (string) config('pi-poc.directory');
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
        $result = Process::timeout($command[0] === 'scp' ? 90 : (str_contains(end($command), 'snapshot-manifest') ? 120 : (in_array(end($command), ['sudo -n blink-poc status', 'sudo -n blink-poc logs'], true) ? 12 : 30)))->run($command, function (string $type, string $output): void {
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
        $agent = getenv('SSH_AUTH_SOCK') ? ['-o', 'IdentityAgent=SSH_AUTH_SOCK'] : [];

        return [...$agent, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=yes', '-o', 'IdentitiesOnly=yes', '-o', 'HostKeyAlias='.($this->connection['host_key_alias'] ?? config('pi-poc.host_key_alias')), '-i', $this->connection['identity'] ?? (string) config('pi-poc.identity')];
    }

    private function target(): string
    {
        return ($this->connection['user'] ?? config('pi-poc.user')).'@'.($this->connection['host'] ?? config('pi-poc.host'));
    }
}
