<?php

namespace App\Services;

use App\Jobs\PullUsbDevice;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;
use RuntimeException;

class UsbCloudTransfers
{
    /** @return array<string, mixed>|null */
    public function progress(string $id): ?array
    {
        $path = $this->path($id);

        return File::isFile($path) ? json_decode(File::get($path), true, flags: JSON_THROW_ON_ERROR) : null;
    }

    /** @param array<string, mixed> $values
     * @return array<string, mixed>
     */
    public function update(string $id, array $values): array
    {
        $progress = array_replace($this->progress($id) ?? [], $values, ['updated_at' => now()->toIso8601String()]);
        File::ensureDirectoryExists(dirname($this->path($id)));
        File::replace($this->path($id), json_encode($progress, JSON_THROW_ON_ERROR));

        return $progress;
    }

    public function active(string $id): bool
    {
        return in_array($this->progress($id)['state'] ?? '', ['queued', 'running', 'pausing', 'cancelling'], true);
    }

    /** @return array<string, mixed> */
    public function queue(string $id): array
    {
        return Cache::lock('usbcloud.enqueue.'.$id, 15)->block(5, function () use ($id): array {
            if ($this->active($id) || Cache::has('usbcloud.operation.'.$id)) {
                throw new RuntimeException('A transfer is already running for '.$id.'.');
            }
            $token = (string) Str::uuid();
            Cache::forget('usbcloud.control.'.$id);
            $progress = $this->update($id, [
                'token' => $token, 'state' => 'queued', 'stage' => 'Waiting for worker', 'started_at' => now()->toIso8601String(),
                'current_file' => null, 'current_bytes' => 0, 'current_total' => 0,
                'done_bytes' => 0, 'total_bytes' => 0, 'done_files' => 0, 'total_files' => 0,
                'skipped' => 0, 'rate' => 0, 'eta' => null, 'error' => null,
            ]);
            PullUsbDevice::dispatch($id, $token)->onConnection('usbcloud')->onQueue('usbcloud');

            return $progress;
        });
    }

    /** @return array<string, mixed> */
    public function control(string $id, string $action): array
    {
        $progress = $this->progress($id);
        if ($action === 'resume') {
            if (! in_array($progress['state'] ?? '', ['paused', 'failed', 'cancelled'], true)) {
                throw new RuntimeException('This transfer cannot be resumed.');
            }

            return $this->queue($id);
        }
        if ($action === 'cancel' && ($progress['state'] ?? '') === 'paused') {
            Cache::forget('usbcloud.control.'.$id);

            return $this->update($id, ['state' => 'cancelled', 'stage' => 'Cancelled']);
        }
        if (! $this->active($id)) {
            throw new RuntimeException('There is no active transfer to control.');
        }
        Cache::put('usbcloud.control.'.$id, $action, 7200);
        $state = $progress['state'] === 'queued' ? ($action === 'pause' ? 'paused' : 'cancelled') : ($action === 'pause' ? 'pausing' : 'cancelling');

        return $this->update($id, ['state' => $state, 'stage' => ucfirst($state)]);
    }

    private function path(string $id): string
    {
        $connection = app(UsbCloudDevices::class)->all(true)[$id] ?? throw new RuntimeException('Unknown device.');

        return $connection['directory'].'/transfer.json';
    }
}
