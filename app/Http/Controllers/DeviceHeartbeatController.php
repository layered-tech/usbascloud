<?php

namespace App\Http\Controllers;

use App\Services\DeviceHeartbeats;
use App\Services\UsbCloudDevices;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class DeviceHeartbeatController extends Controller
{
    public function __invoke(Request $request, UsbCloudDevices $devices, DeviceHeartbeats $heartbeats, string $device): JsonResponse
    {
        $connection = $devices->all()[$device] ?? null;
        $hash = $connection['heartbeat_token_hash'] ?? null;
        abort_unless($hash && $request->bearerToken() && hash_equals($hash, hash('sha256', $request->bearerToken())), 401);
        $state = $request->validate([
            'version' => ['required', 'string', 'max:32'],
            'hostname' => ['required', 'string', 'max:255'],
            'model' => ['nullable', 'string', 'max:255'],
            'uptime_seconds' => ['required', 'integer', 'min:0'],
            'gadget_loaded' => ['required', 'boolean'],
            'usb_state' => ['present', 'array', 'max:16'],
            'usb_state.*' => ['string', 'max:64'],
            'metrics' => ['required', 'array:cpu_temperature_c,load_1m,cpu_count,memory_used_percent,root_used_percent,root_free_bytes,throttled_flags'],
            'metrics.cpu_temperature_c' => ['nullable', 'numeric', 'between:-50,150'],
            'metrics.load_1m' => ['nullable', 'numeric', 'between:0,10000'],
            'metrics.cpu_count' => ['nullable', 'integer', 'between:1,4096'],
            'metrics.memory_used_percent' => ['nullable', 'numeric', 'between:0,100'],
            'metrics.root_used_percent' => ['nullable', 'numeric', 'between:0,100'],
            'metrics.root_free_bytes' => ['nullable', 'integer', 'min:0'],
            'metrics.throttled_flags' => ['nullable', 'integer', 'between:0,4294967295'],
        ]);
        $heartbeats->receive($device, $state);

        return response()->json(['interval_seconds' => DeviceHeartbeats::INTERVAL]);
    }
}
