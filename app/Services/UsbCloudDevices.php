<?php

namespace App\Services;

use Illuminate\Process\Exceptions\ProcessTimedOutException;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Str;
use RuntimeException;

class UsbCloudDevices
{
    /** @return array<string, array<string, mixed>> */
    public function all(bool $includeRemoved = false): array
    {
        $devices = config('usbcloud.devices') ?: (config('usbcloud.include_default_device') ? [config('usbcloud.device_id') => [
            'name' => config('usbcloud.device_name'), 'host' => config('usbcloud-client.host'),
            'directory' => config('usbcloud-client.directory'), 'host_key_alias' => config('usbcloud-client.host_key_alias'),
        ]] : []);
        foreach ($this->saved() as $id => $settings) {
            $devices[$id] = array_replace($devices[$id] ?? [], $settings);
        }
        foreach ($devices as $id => &$device) {
            $device = array_replace([
                'name' => $id, 'host' => '', 'port' => 22, 'user' => config('usbcloud-client.user'),
                'site' => '', 'auto_sync' => null, 'interval' => 60, 'bandwidth' => 0,
                'snapshot_timeout' => 600, 'retry_count' => 0, 'retry_delay' => 15,
                'directory' => config('usbcloud.directory').'/devices/'.$id,
                'removed' => false,
            ], $device);
            if ($archive = config('usbcloud.archive_directory')) {
                $device['archive_directory'] = rtrim($archive, '/').'/devices/'.$id;
            }
            $device['site'] ??= '';
            $device['name'] = $device['name'] ?: $id;
        }
        unset($device);

        return $includeRemoved ? $devices : array_filter($devices, fn (array $device): bool => ! $device['removed']);
    }

    /** @param array<string, mixed> $settings
     * @return array<string, mixed>
     */
    public function save(string $id, array $settings): array
    {
        $lock = Cache::lock('usbcloud.registry', 15);

        return $lock->block(5, function () use ($id, $settings): array {
            $all = $this->saved();
            $all[$id] = array_replace($all[$id] ?? [], $settings);
            File::ensureDirectoryExists(dirname($this->path()));
            File::replace($this->path(), json_encode($all, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR));
            Cache::forget('usbcloud.status.'.$id);

            return $this->all(true)[$id];
        });
    }

    /** @param array<string, mixed> $connection
     * @return array<string, mixed>
     */
    public function test(array $connection): array
    {
        $started = microtime(true);
        $status = (new UsbCloudClient($connection))->status();
        if (! $status['online']) {
            throw new RuntimeException($status['error']);
        }
        if (! isset($status['state']['version'])) {
            throw new RuntimeException('SSH connected, but the USBCloud client did not report a version.');
        }

        return ['success' => true, 'milliseconds' => (int) round((microtime(true) - $started) * 1000), 'state' => $status['state']];
    }

    /** @param array<string, mixed> $connection */
    public function add(array $connection): string
    {
        foreach ($this->all(true) as $id => $device) {
            if (strtolower($device['host']) === strtolower($connection['host']) && (int) $device['port'] === (int) $connection['port']) {
                if (! $device['removed']) {
                    throw new RuntimeException('This address is already in the fleet as '.$id.'.');
                }
                $this->test(array_replace($device, $connection));
                $this->save($id, [...$connection, 'removed' => false]);
                try {
                    app(DeviceHeartbeats::class)->pair($id);
                } catch (\Throwable $exception) {
                    $this->save($id, ['removed' => true]);
                    throw $exception;
                }

                return $id;
            }
        }
        $result = $this->test($connection);
        $id = strtoupper(Str::slug($result['state']['hostname'] ?? $connection['host']));
        $id = substr($id ?: 'USB-PI', 0, 48);
        if (isset($this->all(true)[$id])) {
            $id .= '-'.strtoupper(Str::random(6));
        }
        $this->save($id, [...$connection, 'name' => $connection['name'] ?: $id, 'removed' => false]);
        try {
            app(DeviceHeartbeats::class)->pair($id);
        } catch (\Throwable $exception) {
            $this->save($id, ['removed' => true]);
            throw $exception;
        }

        return $id;
    }

    /** @return array{devices: list<array<string, mixed>>, message: string} */
    public function discover(): array
    {
        $found = [];
        $message = 'Local discovery complete. SSH key access and a trusted host key are required to add a device.';
        try {
            $command = PHP_OS_FAMILY === 'Darwin' ? ['/usr/bin/script', '-q', '/dev/null', '/usr/bin/dns-sd', '-Z', '_usbcloud._tcp', 'local.'] : ['avahi-browse', '-rtp', '_usbcloud._tcp'];
            try {
                $result = Process::timeout(5)->run($command);
            } catch (ProcessTimedOutException $exception) {
                $result = $exception->result;
            }
            foreach (explode("\n", $result->output()) as $line) {
                if (preg_match('/\sSRV\s+\d+\s+\d+\s+(\d+)\s+([^\s;]+)/', $line, $match)) {
                    $found[] = ['host' => rtrim($match[2], '.'), 'port' => (int) $match[1]];
                } elseif (str_starts_with($line, '=;')) {
                    $fields = explode(';', $line);
                    if (count($fields) >= 9) {
                        $found[] = ['host' => $fields[6], 'port' => (int) $fields[8]];
                    }
                }
            }
        } catch (\Throwable) {
            $message = 'Discovery is unavailable on this server. Add a client by hostname or IP.';
        }
        foreach ($this->all() as $id => $device) {
            $found[] = ['host' => $device['host'], 'port' => $device['port'], 'id' => $id, 'name' => $device['name']];
        }
        $devices = [];
        foreach ($found as $entry) {
            foreach ($this->all() as $id => $device) {
                $hostname = Cache::get('usbcloud.status.'.$id)['state']['hostname'] ?? '';
                $hosts = [strtolower($device['host']), strtolower($device['host_key_alias'] ?? ''), strtolower($hostname.'.local')];
                if (in_array(strtolower($entry['host']), $hosts, true)) {
                    $entry = [...$entry, 'id' => $id, 'name' => $device['name']];
                    break;
                }
            }
            $key = $entry['id'] ?? strtolower($entry['host']).':'.$entry['port'];
            $devices[$key] ??= $entry;
        }

        return ['devices' => array_values($devices), 'message' => $message];
    }

    /** @return array<string, array<string, mixed>> */
    private function saved(): array
    {
        return File::isFile($this->path()) ? json_decode(File::get($this->path()), true, flags: JSON_THROW_ON_ERROR) : [];
    }

    private function path(): string
    {
        return config('usbcloud.directory').'/devices.json';
    }
}
