<?php

namespace App\Jobs;

use App\Services\UsbCloud;
use App\Services\UsbCloudTransfers;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Throwable;

class PullUsbDevice implements ShouldQueue
{
    use Queueable;

    public int $timeout = 5400;

    public int $tries = 1;

    public function __construct(public string $device, public string $token) {}

    public function handle(UsbCloud $cloud, UsbCloudTransfers $transfers): void
    {
        $progress = $transfers->progress($this->device);
        if (($progress['token'] ?? null) !== $this->token || ($progress['state'] ?? '') !== 'queued') {
            return;
        }
        $cloud->operate($this->device, 'pull');
    }

    public function failed(?Throwable $exception): void
    {
        app(UsbCloudTransfers::class)->update($this->device, ['state' => 'failed', 'stage' => 'Worker stopped', 'error' => $exception?->getMessage() ?? 'Worker stopped. Retry to continue.']);
    }
}
