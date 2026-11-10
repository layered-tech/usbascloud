<?php

namespace App\Console\Commands;

use App\Services\DeviceHeartbeats;
use App\Services\UsbCloudDevices;
use Illuminate\Console\Command;

class PairDeviceHeartbeat extends Command
{
    protected $signature = 'usbcloud:pair-heartbeat {device}';

    protected $description = 'Provision or rotate an existing device heartbeat token over SSH';

    public function handle(UsbCloudDevices $devices, DeviceHeartbeats $heartbeats): int
    {
        $id = $this->argument('device');
        if (! isset($devices->all()[$id])) {
            $this->error('Unknown device.');

            return self::FAILURE;
        }
        try {
            $heartbeats->pair($id);
        } catch (\Throwable $exception) {
            $this->error($exception->getMessage());

            return self::FAILURE;
        }
        $this->info('Heartbeat credentials provisioned. Waiting for the client to report.');

        return self::SUCCESS;
    }
}
