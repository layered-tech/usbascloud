<?php

namespace App\Console\Commands;

use App\Services\UsbCloud;
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
        if (! $this->option('force') && (! $settings['auto_pull'] || ! Cache::add('usbcloud.scheduled', true, $settings['pull_interval']))) {
            return self::SUCCESS;
        }
        $failed = false;
        foreach (array_keys($cloud->connections()) as $id) {
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
