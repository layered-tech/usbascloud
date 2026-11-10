<?php

namespace App\Http\Controllers;

use App\Http\Requests\SaveUsbCloudDeviceRequest;
use App\Http\Requests\UpdateUsbCloudSettingsRequest;
use App\Services\UsbCloud;
use App\Services\UsbCloudDevices;
use App\Services\UsbCloudTransfers;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;
use Inertia\Inertia;
use Inertia\Response;
use RuntimeException;
use Symfony\Component\HttpFoundation\BinaryFileResponse;
use Symfony\Component\HttpFoundation\StreamedResponse;
use ZipArchive;

class UsbCloudController extends Controller
{
    public function index(Request $request, UsbCloud $cloud): Response
    {
        $data = $request->validate(['log_devices' => ['sometimes', 'array', 'max:100'], 'log_devices.*' => ['string', Rule::in(array_keys($cloud->connections()))]]);

        return Inertia::render('usbcloud', ['cloud' => fn (): array => $cloud->dashboard($data['log_devices'] ?? [])]);
    }

    public function operate(Request $request, UsbCloud $cloud): StreamedResponse
    {
        $data = $request->validate([
            'device' => ['nullable', Rule::in(array_keys($cloud->connections()))],
            'action' => ['required', Rule::in(['refresh', 'scan', 'pull', 'mount', 'unmount'])],
        ]);
        abort_if(empty($data['device']) && in_array($data['action'], ['mount', 'unmount']), 422, 'Select a device.');
        set_time_limit(0);

        return response()->stream(function () use ($data, $cloud): void {
            ignore_user_abort(true);
            $send = function (array $event): void {
                echo json_encode($event, JSON_THROW_ON_ERROR)."\n";
                if (ob_get_level() > 0) {
                    ob_flush();
                }
                flush();
            };
            $ids = empty($data['device']) ? array_keys($cloud->connections()) : [$data['device']];
            foreach ($ids as $id) {
                $send(['type' => 'output', 'message' => $id.': '.ucfirst($data['action']).' started.']);
                try {
                    $result = $cloud->operate($id, $data['action'], fn (string $message) => $send(['type' => 'output', 'message' => $message]));
                } catch (RuntimeException $exception) {
                    $result = ['success' => false, 'message' => $exception->getMessage()];
                }
                $send(['type' => 'result', 'device' => $id, ...$result]);
            }
        }, 200, ['Content-Type' => 'application/x-ndjson', 'Cache-Control' => 'no-store', 'X-Accel-Buffering' => 'no']);
    }

    public function discover(UsbCloudDevices $devices): JsonResponse
    {
        return response()->json($devices->discover());
    }

    public function addDevice(SaveUsbCloudDeviceRequest $request, UsbCloudDevices $devices, UsbCloud $cloud): JsonResponse
    {
        try {
            $id = $devices->add($request->validated());
            $cloud->log($id, 'ok', 'Device added to fleet.');

            return response()->json(['device' => $id], 201);
        } catch (RuntimeException $exception) {
            return response()->json(['message' => $exception->getMessage()], 422);
        }
    }

    public function updateDevice(SaveUsbCloudDeviceRequest $request, UsbCloudDevices $devices, string $device): JsonResponse
    {
        abort_unless(isset($devices->all()[$device]), 404);
        $settings = $devices->save($device, $request->validated());
        app(UsbCloud::class)->log($device, 'ok', 'Device settings saved.');

        return response()->json(['settings' => array_diff_key($settings, array_flip(['directory', 'identity', 'host_key_alias', 'known_hosts_file', 'removed', 'heartbeat_token_hash']))]);
    }

    public function testDevice(SaveUsbCloudDeviceRequest $request, UsbCloudDevices $devices, string $device): JsonResponse
    {
        $connection = $devices->all()[$device] ?? null;
        abort_unless($connection !== null, 404);
        try {
            return response()->json($devices->test(array_replace($connection, $request->validated())));
        } catch (RuntimeException $exception) {
            return response()->json(['message' => $exception->getMessage()], 422);
        }
    }

    public function removeDevice(UsbCloudDevices $devices, UsbCloudTransfers $transfers, string $device): JsonResponse
    {
        abort_unless(isset($devices->all()[$device]), 404);
        abort_if($transfers->active($device) || Cache::has('usbcloud.operation.'.$device), 409, 'Stop the transfer before removing this device.');
        $devices->save($device, ['removed' => true, 'heartbeat_token_hash' => null]);
        app(UsbCloud::class)->log($device, 'warn', 'Device removed from fleet. Saved files retained.');

        return response()->json(['message' => 'Device removed. Saved files are retained.']);
    }

    public function transfer(Request $request, UsbCloud $cloud, UsbCloudTransfers $transfers): JsonResponse
    {
        $data = $request->validate([
            'device' => ['nullable', Rule::in(array_keys($cloud->connections()))],
            'action' => ['required', Rule::in(['start', 'pause', 'resume', 'cancel'])],
        ]);
        $ids = empty($data['device']) ? array_keys($cloud->connections()) : [$data['device']];
        $results = [];
        foreach ($ids as $id) {
            try {
                if (empty($data['device']) && $data['action'] !== 'start' && ! ($data['action'] === 'resume' ? in_array($transfers->progress($id)['state'] ?? '', ['paused', 'failed', 'cancelled'], true) : ($transfers->active($id) || ($data['action'] === 'cancel' && ($transfers->progress($id)['state'] ?? '') === 'paused')))) {
                    continue;
                }
                $results[$id] = ['success' => true, 'transfer' => $data['action'] === 'start' ? $transfers->queue($id) : $transfers->control($id, $data['action'])];
            } catch (RuntimeException $exception) {
                $results[$id] = ['success' => false, 'message' => $exception->getMessage()];
            }
        }

        return response()->json(['results' => $results], collect($results)->contains(fn (array $result): bool => ! $result['success']) ? 409 : 202);
    }

    public function settings(UpdateUsbCloudSettingsRequest $request, UsbCloud $cloud): JsonResponse
    {
        $cloud->saveSettings($request->validated());

        return response()->json(['settings' => $cloud->settings()]);
    }

    public function file(Request $request, UsbCloud $cloud, string $file): BinaryFileResponse
    {
        $entry = collect($cloud->allFiles())->firstWhere('id', $file);
        abort_unless($entry && $entry['state'] === 'pulled', 404);
        $path = $cloud->client($entry['device'])->filePath($entry['run'] ?? '', $entry);
        abort_unless($path !== null, 404);
        $name = basename($entry['name']);
        $preview = $request->boolean('preview') && in_array(strtolower(pathinfo($name, PATHINFO_EXTENSION)), ['mp4', 'webm', 'mov', 'm4v', 'mp3', 'wav', 'ogg', 'm4a', 'jpg', 'jpeg', 'png', 'gif', 'webp'], true);
        $response = $preview ? response()->file($path) : response()->download($path, $name);

        if ($preview) {
            $extension = strtolower(pathinfo($name, PATHINFO_EXTENSION));
            $mime = ['mp4' => 'video/mp4', 'm4v' => 'video/mp4', 'webm' => 'video/webm', 'mov' => 'video/quicktime', 'mp3' => 'audio/mpeg', 'wav' => 'audio/wav', 'ogg' => 'audio/ogg', 'm4a' => 'audio/mp4', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'png' => 'image/png', 'gif' => 'image/gif', 'webp' => 'image/webp'][$extension];
            $response->headers->set('Content-Type', $mime);
        }
        $response->headers->set('Cache-Control', 'no-store, private');
        $response->headers->set('X-Content-Type-Options', 'nosniff');

        return $response;
    }

    public function download(Request $request, UsbCloud $cloud): BinaryFileResponse
    {
        $data = $request->validate(['files' => ['required', 'array', 'min:1', 'max:100'], 'files.*' => ['required', 'string', 'regex:/\A[a-f0-9]{64}\z/', 'distinct']]);
        $entries = collect($cloud->allFiles())->whereIn('id', $data['files'])->where('state', 'pulled');
        abort_unless($entries->count() === count($data['files']), 404);
        $directory = storage_path('app/private/usbcloud-downloads');
        File::ensureDirectoryExists($directory);
        $path = $directory.'/'.Str::uuid().'.zip';
        $zip = new ZipArchive;
        abort_unless($zip->open($path, ZipArchive::CREATE) === true, 500, 'Could not prepare the download.');
        foreach ($entries as $entry) {
            $source = $cloud->client($entry['device'])->filePath($entry['run'] ?? '', $entry);
            if ($source === null) {
                $zip->close();
                File::delete($path);
                abort(404);
            }
            $name = $entry['device'].'/'.$entry['id'].'/'.basename($entry['name']);
            $zip->addFile($source, $name);
        }
        $zip->close();

        return response()->download($path, 'usbcloud-files.zip', ['Cache-Control' => 'no-store, private'])->deleteFileAfterSend();
    }
}
