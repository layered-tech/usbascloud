<?php

namespace App\Console\Commands;

use App\Services\UsbCloud;
use App\Services\UsbCloudExports;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Cache;
use Throwable;

class ExportUsbFiles extends Command
{
    protected $signature = 'usbcloud:export {--device= : Export only this device}';

    protected $description = 'Create readable copies of verified archived files without contacting clients';

    public function handle(UsbCloud $cloud, UsbCloudExports $exports): int
    {
        $count = 0;
        foreach ($cloud->allFiles() as $file) {
            if ($file['state'] !== 'pulled' || ($this->option('device') && $this->option('device') !== $file['device'])) {
                continue;
            }
            $client = $cloud->client($file['device']);
            $lock = Cache::lock($client->directory() === config('usbcloud-client.directory') ? 'usbcloud-client-retrieval' : 'usbcloud.lock.'.$file['device'], 5500);
            if (! $lock->get()) {
                $this->error('Device is busy: '.$file['device']);

                return self::FAILURE;
            }
            try {
                $object = $client->filePath($file['run'] ?? '', $file);
                if ($object !== null && $exports->save($client->directory(), $object, $file) !== null) {
                    $count++;
                }
            } catch (Throwable $exception) {
                $this->error($exception->getMessage());

                return self::FAILURE;
            } finally {
                $lock->release();
            }
        }
        $this->info($count.' readable files exported.');

        return self::SUCCESS;
    }
}
