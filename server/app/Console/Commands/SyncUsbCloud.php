<?php

namespace App\Console\Commands;

use App\Services\UsbCloud;
use App\Services\UsbCloudTransfers;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Cache;
use RuntimeException;

class SyncUsbCloud extends Command
{
    protected $signature = 'usbcloud:sync {--force : Pull now, regardless of the schedule}';

    protected $description = 'Pull pending USB files on the configured interval';

    public function handle(UsbCloud $cloud): int
    {
        Cache::put('usbcloud.scheduler_seen', now()->toIso8601String(), 120);
        $settings = $cloud->settings();
        $failed = false;
        foreach ($cloud->connections() as $id => $connection) {
            $enabled = $connection['auto_sync'] ?? $settings['auto_pull'];
            $interval = $connection['auto_sync'] === null ? $settings['pull_interval'] : $connection['interval'];
            if (! $this->option('force') && (! $enabled || ! Cache::add('usbcloud.scheduled.'.$id, true, $interval))) {
                continue;
            }
            if (app(UsbCloudTransfers::class)->active($id) || (app(UsbCloudTransfers::class)->progress($id)['state'] ?? '') === 'paused') {
                continue;
            }
            Cache::put('usbcloud.next_sync.'.$id, now()->addSeconds($interval)->toIso8601String(), $interval + 120);
            try {
                $result = $cloud->operate($id, 'pull');
                $this->line($id.': '.$result['message']);
                $failed = $failed || ! $result['success'];
            } catch (RuntimeException $exception) {
                $this->warn($exception->getMessage());
                $failed = true;
            }
        }

        return $failed ? self::FAILURE : self::SUCCESS;
    }
}
