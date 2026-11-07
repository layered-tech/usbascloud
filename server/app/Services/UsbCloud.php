<?php

namespace App\Services;

use Closure;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\File;
use RuntimeException;
use Throwable;

class UsbCloud
{
    /** @return array<string, array<string, string>> */
    public function connections(): array
    {
        return config('usbcloud.devices') ?: [
            config('usbcloud.device_id') => [
                'name' => config('usbcloud.device_name'),
                'host' => config('pi-poc.host'),
                'directory' => config('pi-poc.directory'),
            ],
        ];
    }

    public function client(string $id): PiPocClient
    {
        $connection = $this->connections()[$id] ?? null;
        if ($connection === null) {
            throw new RuntimeException('Unknown device.');
        }

        return new PiPocClient($connection);
    }

    /** @return array<string, mixed> */
    public function settings(): array
    {
        return array_replace([
            'server_name' => config('usbcloud.server_name'),
            'pull_interval' => 30,
            'auto_pull' => false,
            'theme' => 'phosphor',
        ], $this->read($this->directory().'/settings.json'));
    }

    /** @param array<string, mixed> $settings */
    public function saveSettings(array $settings): void
    {
        $this->write($this->directory().'/settings.json', $settings);
        $this->log('server', 'ok', 'Server settings saved.');
    }

    /** @param list<string> $logDevices
     * @return array<string, mixed>
     */
    public function dashboard(array $logDevices = []): array
    {
        $devices = [];
        $files = [];
        foreach ($this->connections() as $id => $connection) {
            $client = $this->client($id);
            $operation = Cache::get('usbcloud.operation.'.$id);
            $status = ($operation ? Cache::get('usbcloud.status.'.$id) : null) ?? Cache::remember('usbcloud.status.'.$id, 15, fn (): array => [
                ...$client->status(), 'checked_at' => now()->toIso8601String(),
            ]);
            $inventory = $this->read($client->directory().'/inventory.json');
            $deviceFiles = $this->files($id, $client, $inventory);
            $files = array_merge($files, $deviceFiles);
            $runs = $client->runs(null);
            $lastSync = collect($runs)->first(fn (array $run): bool => ($run['kind'] ?? 'pull') === 'pull' && $run['success']);
            $state = $status['state'] ?? [];
            $fault = ! $status['online'] ? null : (! ($state['gadget_loaded'] ?? false) ? 'USB detached' : null);
            $lastRun = $runs[0] ?? null;
            if ($status['online'] && $lastRun && ! $lastRun['success']) {
                $fault = $lastRun['error'];
            }
            $filesystem = $inventory['filesystem'] ?? $state['inventory']['filesystem'] ?? null;
            $pending = isset($inventory['files']) ? count(array_filter($deviceFiles, fn (array $file): bool => $file['state'] === 'pending')) : null;
            $latest = null;
            foreach ($inventory['files'] ?? [] as $entry) {
                if ($latest === null || ($entry['modified_at'] ?? '') > ($latest['modified_at'] ?? '')) {
                    $latest = $entry;
                }
            }
            $devices[] = [
                'id' => $id, 'name' => $connection['name'] ?? $id, 'address' => $connection['host'] ?? config('pi-poc.host'),
                'status' => $operation === 'pull' ? 'syncing' : (! $status['online'] ? 'offline' : ($fault ? 'fault' : 'online')),
                'operation' => $operation, 'error' => $status['error'] ?? $fault,
                'gadget_loaded' => $state['gadget_loaded'] ?? null,
                'usb_state' => implode(', ', $state['usb_state'] ?? []),
                'firmware' => $state['version'] ?? null, 'uptime_seconds' => $state['uptime_seconds'] ?? null,
                'filesystem' => $filesystem, 'pending' => $pending,
                'last_sync' => $lastSync['at'] ?? null, 'scanned_at' => $inventory['at'] ?? null,
                'checked_at' => $status['checked_at'],
                'last_file' => $latest['name'] ?? null,
            ];
        }

        return [
            'devices' => $devices,
            'files' => collect($files)->sortByDesc(fn (array $file): string => $file['modified_at'] ?? $file['saved_at'] ?? '')->values()->all(),
            'logs' => $this->logs($logDevices),
            'settings' => $this->settings(),
            'server' => ['url' => config('app.url'), 'storage_root' => config('pi-poc.directory'), 'scheduler_last_seen' => Cache::get('usbcloud.scheduler_seen')],
        ];
    }

    /** @return array<int, array<string, mixed>> */
    public function allFiles(): array
    {
        $files = [];
        foreach ($this->connections() as $id => $connection) {
            $client = $this->client($id);
            $files = array_merge($files, $this->files($id, $client, $this->read($client->directory().'/inventory.json')));
        }

        return $files;
    }

    /** @param array<string, mixed> $inventory
     * @return array<int, array<string, mixed>>
     */
    private function files(string $id, PiPocClient $client, array $inventory): array
    {
        $files = [];
        foreach ($client->runs(null) as $run) {
            foreach ($run['files'] as $entry) {
                $key = hash('sha256', $id."\0".$entry['name']."\0".$entry['sha256']);
                if (isset($files[$key]) || $client->filePath($run['id'], $entry) === null) {
                    continue;
                }
                $files[$key] = [
                    ...$entry, 'id' => $key, 'device' => $id, 'state' => 'pulled', 'on_device' => false,
                    'modified_at' => $entry['modified_at'] ?? null, 'saved_at' => $run['at'] ?? null,
                    'run' => $run['id'], 'entry_id' => $entry['id'],
                ];
            }
        }
        foreach ($inventory['files'] ?? [] as $entry) {
            $key = hash('sha256', $id."\0".$entry['name']."\0".$entry['sha256']);
            if (isset($files[$key])) {
                $files[$key]['on_device'] = true;
                $files[$key]['modified_at'] = $entry['modified_at'] ?? $files[$key]['modified_at'];

                continue;
            }
            $saved = $client->filePath('', $entry) !== null;
            $files[$key] = [
                ...$entry, 'id' => $key, 'device' => $id, 'state' => $saved ? 'pulled' : 'pending',
                'on_device' => true, 'modified_at' => $entry['modified_at'] ?? null, 'saved_at' => null,
                'run' => null, 'entry_id' => null,
            ];
        }

        return array_values($files);
    }

    /** @return array<string, mixed> */
    public function operate(string $id, string $action, ?Closure $output = null): array
    {
        $client = $this->client($id);
        if ($action === 'refresh') {
            $status = [...$client->status(), 'checked_at' => now()->toIso8601String()];
            Cache::put('usbcloud.status.'.$id, $status, 15);
            $logsError = $status['online'] ? $this->refreshDeviceLogs($id, force: true) : null;
            $message = ! $status['online'] ? $status['error'] : ($logsError ? 'Device status refreshed; client logs unavailable.' : 'Device status and logs refreshed.');
            $this->log($id, $status['online'] ? 'ok' : 'err', $message);

            return ['success' => $status['online'], 'message' => $message];
        }
        $lock = Cache::lock($client->directory() === config('pi-poc.directory') ? 'pi-poc-retrieval' : 'usbcloud.lock.'.$id, 600);
        if (! $lock->get()) {
            throw new RuntimeException('A device operation is already running. Wait for it to finish.');
        }
        Cache::put('usbcloud.operation.'.$id, $action, 600);
        $this->log($id, 'info', ucfirst($action).' started.');
        try {
            if (in_array($action, ['scan', 'pull'], true)) {
                $run = $client->retrieve(function (string $line) use ($id, $output): void {
                    if (str_starts_with($line, 'Transferring new file:') || str_starts_with($line, 'Skipping already saved:')) {
                        $this->log($id, 'info', trim($line));
                        $output?->__invoke(trim($line));
                    }
                }, copy: $action === 'pull');
                foreach ($run['log'] as $line) {
                    $this->log($id, 'info', $line);
                }
                if (! $run['success']) {
                    throw new RuntimeException($run['error'] ?? 'Device operation failed.');
                }
                $message = $action === 'pull'
                    ? count($run['files']).' new files saved; '.$run['already_saved'].' already saved.'
                    : 'Snapshot scanned. File inventory updated.';
            } else {
                $client->control($action === 'mount' ? 'start' : 'detach');
                $message = $action === 'mount' ? 'USB disk attached.' : 'USB disk detached.';
            }
            $this->refreshDeviceLogs($id, force: true);
            $this->log($id, 'ok', $message);

            return ['success' => true, 'message' => $message];
        } catch (Throwable $exception) {
            $this->log($id, 'err', $exception->getMessage());

            return ['success' => false, 'message' => $exception->getMessage()];
        } finally {
            Cache::forget('usbcloud.operation.'.$id);
            Cache::forget('usbcloud.status.'.$id);
            $lock->release();
        }
    }

    private function refreshDeviceLogs(string $id, bool $force = false): ?string
    {
        if (! $force && ! Cache::add('usbcloud.logs_poll.'.$id, true, 4)) {
            return Cache::get('usbcloud.logs_error.'.$id);
        }
        $lock = Cache::lock('usbcloud.logs_read.'.$id, 20);
        if (! $lock->get()) {
            return Cache::get('usbcloud.logs_error.'.$id);
        }
        try {
            $entries = $this->client($id)->control('logs')['entries'] ?? [];
            $this->write($this->directory().'/'.$id.'-logs.json', ['entries' => $entries]);
            Cache::forget('usbcloud.logs_error.'.$id);

            return null;
        } catch (Throwable $exception) {
            $error = $exception->getMessage();
            if (Cache::get('usbcloud.logs_error.'.$id) !== $error) {
                $this->log($id, 'warn', 'Client logs unavailable: '.$error);
            }
            Cache::put('usbcloud.logs_error.'.$id, $error, 60);

            return $error;
        } finally {
            $lock->release();
        }
    }

    /** @param list<string> $refreshDevices
     * @return array{server: list<array<string, mixed>>, devices: array<string, list<array<string, mixed>>>, errors: array<string, string>}
     */
    public function logs(array $refreshDevices = []): array
    {
        foreach (array_unique($refreshDevices) as $id) {
            $this->refreshDeviceLogs($id);
        }
        $entries = [];
        $path = $this->directory().'/events.jsonl';
        if (File::isFile($path)) {
            foreach (array_slice(file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [], -500) as $line) {
                $entry = json_decode($line, true);
                if (is_array($entry)) {
                    $device = $entry['device'] ?? (($entry['source'] ?? 'server') !== 'server' ? $entry['source'] : null);
                    $entries[] = [...$entry, 'source' => 'server', 'device' => $device, 'origin' => 'server'];
                }
            }
        }
        $devices = [];
        $errors = [];
        foreach ($this->connections() as $id => $connection) {
            $devices[$id] = [];
            foreach ($this->read($this->directory().'/'.$id.'-logs.json')['entries'] ?? [] as $entry) {
                $devices[$id][] = [...$entry, 'source' => $id, 'origin' => 'client'];
            }
            $error = Cache::get('usbcloud.logs_error.'.$id);
            if (is_string($error)) {
                $errors[$id] = $error;
            }
        }

        return ['server' => array_values(collect($entries)->sortBy('at')->take(-500)->all()), 'devices' => $devices, 'errors' => $errors];
    }

    public function log(string $source, string $level, string $message): void
    {
        File::ensureDirectoryExists($this->directory());
        $path = $this->directory().'/events.jsonl';
        file_put_contents($path, json_encode([
            'at' => now()->toIso8601String(), 'source' => 'server', 'device' => $source === 'server' ? null : $source,
            'level' => $level, 'message' => $message, 'origin' => 'server',
        ], JSON_THROW_ON_ERROR)."\n", FILE_APPEND | LOCK_EX);
    }

    /** @return array<string, mixed> */
    private function read(string $path): array
    {
        return File::isFile($path) ? json_decode(File::get($path), true, flags: JSON_THROW_ON_ERROR) : [];
    }

    /** @param array<string, mixed> $data */
    private function write(string $path, array $data): void
    {
        File::ensureDirectoryExists(dirname($path));
        File::replace($path, json_encode($data, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR));
    }

    private function directory(): string
    {
        return (string) config('usbcloud.directory');
    }
}
