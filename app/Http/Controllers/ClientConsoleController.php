<?php

namespace App\Http\Controllers;

use App\Services\UsbCloudClient;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\File;
use Inertia\Inertia;
use Inertia\Response;
use Symfony\Component\HttpFoundation\BinaryFileResponse;
use Symfony\Component\HttpFoundation\StreamedResponse;
use Throwable;

class ClientConsoleController extends Controller
{
    public function index(UsbCloudClient $client): Response
    {
        return Inertia::render('client/console', [
            'host' => config('usbcloud-client.host'),
            'status' => fn () => $client->status(),
            'runs' => $client->runs(),
        ]);
    }

    public function refresh(UsbCloudClient $client): StreamedResponse
    {
        return response()->stream(function () use ($client): void {
            $send = function (string $type, mixed $data): void {
                echo json_encode(['type' => $type, 'data' => $data], JSON_THROW_ON_ERROR)."\n";
                if (ob_get_level() > 0) {
                    ob_flush();
                }
                flush();
            };
            $send('output', "Refreshing Pi status…\n");
            $status = $client->status(fn (string $output) => $send('output', $output));
            $send('status', $status);
        }, 200, ['Content-Type' => 'application/x-ndjson', 'Cache-Control' => 'no-cache, no-store', 'X-Accel-Buffering' => 'no']);
    }

    public function retrieve(UsbCloudClient $client): StreamedResponse|JsonResponse
    {
        set_time_limit(540);
        $lock = Cache::lock('usbcloud-client-retrieval', 600);
        if (! $lock->get()) {
            return response()->json(['message' => 'A retrieval is already running. Wait for it to finish, then refresh.'], 423);
        }

        return response()->stream(function () use ($client, $lock): void {
            $send = function (string $type, mixed $data): void {
                echo json_encode(['type' => $type, 'data' => $data], JSON_THROW_ON_ERROR)."\n";
                if (ob_get_level() > 0) {
                    ob_flush();
                }
                flush();
            };
            ignore_user_abort(true);
            try {
                $send('output', "Starting snapshot retrieval…\n");
                $run = $client->retrieve(fn (string $output) => $send('output', $output));
                $send('result', $run);
            } catch (Throwable $e) {
                $send('error', $e->getMessage());
            } finally {
                $lock->release();
            }
        }, 200, ['Content-Type' => 'application/x-ndjson', 'Cache-Control' => 'no-cache, no-store', 'X-Accel-Buffering' => 'no']);
    }

    public function file(UsbCloudClient $client, string $run, string $file): BinaryFileResponse
    {
        abort_unless(preg_match('/\A[0-9A-HJKMNP-TV-Z]{26}\z/', $run) && ctype_digit($file), 404);
        $directory = $client->directory().'/'.$run;
        abort_unless(File::exists($directory.'/result.json'), 404);
        $result = json_decode(File::get($directory.'/result.json'), true, flags: JSON_THROW_ON_ERROR);
        $entry = $result['files'][(int) $file] ?? null;
        abort_unless(is_array($entry), 404);
        $path = $client->filePath($run, $entry);
        abort_unless($path !== null, 404);

        return response()->file($path, ['Cache-Control' => 'no-store'])->setPrivate();
    }
}
