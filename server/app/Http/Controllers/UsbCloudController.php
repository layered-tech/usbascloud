<?php

namespace App\Http\Controllers;

use App\Http\Requests\UpdateUsbCloudSettingsRequest;
use App\Services\UsbCloud;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
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
        $preview = $request->boolean('preview') && in_array(strtolower(pathinfo($name, PATHINFO_EXTENSION)), ['mp4', 'webm', 'mp3', 'wav', 'jpg', 'jpeg', 'png', 'gif'], true);
        $response = $preview ? response()->file($path) : response()->download($path, $name);

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
