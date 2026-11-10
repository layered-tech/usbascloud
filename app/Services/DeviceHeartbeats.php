<?php

namespace App\Services;

use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;

class DeviceHeartbeats
{
    public const INTERVAL = 30;

    public const STALE_AFTER = 90;

    public function pair(string $id): void
    {
        $devices = app(UsbCloudDevices::class);
        $connection = $devices->all()[$id];
        $token = Str::random(64);
        $previous = $connection['heartbeat_token_hash'] ?? null;
        $devices->save($id, ['heartbeat_token_hash' => hash('sha256', $token)]);
        try {
            (new UsbCloudClient($connection))->configureHeartbeat([
                'url' => rtrim(config('usbcloud.heartbeat_url') ?: config('app.url'), '/').'/api/v1/devices/'.rawurlencode($id).'/heartbeat',
                'token' => $token,
            ]);
        } catch (\Throwable $exception) {
            $devices->save($id, ['heartbeat_token_hash' => $previous]);
            throw $exception;
        }
    }

    /** @param array<string, mixed> $state */
    public function receive(string $id, array $state): void
    {
        File::ensureDirectoryExists($this->directory());
        File::replace($this->directory().'/'.$id.'.json', json_encode([
            'checked_at' => now()->toIso8601String(), 'state' => $state,
        ], JSON_THROW_ON_ERROR));
    }

    /** @return array<string, mixed> */
    public function status(string $id): array
    {
        $path = $this->directory().'/'.$id.'.json';
        $last = File::isFile($path) ? json_decode(File::get($path), true, flags: JSON_THROW_ON_ERROR) : null;
        $online = $last && now()->diffInSeconds($last['checked_at'], absolute: true) < self::STALE_AFTER;

        return [
            'online' => (bool) $online, 'state' => $last['state'] ?? null,
            'checked_at' => $last['checked_at'] ?? null,
            'error' => $online ? null : ($last ? 'Heartbeat overdue.' : 'Waiting for first heartbeat.'),
        ];
    }

    /** @param array<string, mixed> $metrics
     * @return list<string>
     */
    public function warnings(array $metrics): array
    {
        $warnings = [];
        if (($metrics['cpu_temperature_c'] ?? 0) >= 80) {
            $warnings[] = 'CPU temperature ≥ 80°C';
        }
        if (($metrics['memory_used_percent'] ?? 0) >= 90) {
            $warnings[] = 'Memory usage ≥ 90%';
        }
        if (($metrics['root_used_percent'] ?? 0) >= 90) {
            $warnings[] = 'System disk usage ≥ 90%';
        }
        if (($metrics['throttled_flags'] ?? 0) & 0xF) {
            $warnings[] = 'Power or thermal throttling active';
        }

        return $warnings;
    }

    private function directory(): string
    {
        return config('usbcloud.directory').'/heartbeats';
    }
}
