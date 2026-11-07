<?php

use App\Services\UsbCloud;
use Illuminate\Process\PendingProcess;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Str;
use Inertia\Testing\AssertableInertia as Assert;

beforeEach(function () {
    $directory = storage_path('framework/testing/usbcloud-'.Str::uuid());
    config(['usbcloud.directory' => $directory.'/server', 'pi-poc.directory' => $directory.'/pi']);
});

afterEach(function () {
    File::deleteDirectory(dirname(config('usbcloud.directory')));
});

function fakeUsbDevice(array $files = [], bool $corruptTransfer = false): void
{
    Process::fake(function (PendingProcess $process) use ($files, $corruptTransfer) {
        if ($process->command[0] === 'scp') {
            File::put(end($process->command), $corruptTransfer ? 'bad' : 'clip');

            return Process::result();
        }
        $command = end($process->command);
        if (str_contains($command, 'snapshot-open')) {
            return Process::result(output: json_encode(['token' => str_repeat('a', 32), 'path' => '/srv/blink-poc/snapshot']));
        }
        if (str_contains($command, 'snapshot-manifest')) {
            return Process::result(output: json_encode(['files' => $files, 'filesystem' => ['type' => 'exfat', 'mount' => '/srv/blink-poc/snapshot', 'total_bytes' => 8000, 'used_bytes' => 1000, 'free_bytes' => 7000]]));
        }
        if ($command === 'sudo -n blink-poc logs') {
            return Process::result(output: json_encode(['entries' => [['at' => now()->toIso8601String(), 'level' => 'ok', 'message' => 'Manifest complete.']]]));
        }

        return Process::result(output: '{"gadget_loaded":true,"usb_state":{"usb":"configured"},"version":"0.2.0","uptime_seconds":3600}');
    });
}

function usbClip(string $name = 'clip.mp4'): array
{
    return ['name' => $name, 'bytes' => 4, 'sha256' => hash('sha256', 'clip'), 'modified_at' => '2026-11-07T10:00:00+00:00'];
}

function usbOperation(string $action, ?string $device = null): array
{
    $response = test()->postJson(route('usbcloud.operate'), ['action' => $action, 'device' => $device])->assertOk();

    return collect(explode("\n", trim($response->streamedContent())))->map(fn (string $line): array => json_decode($line, true))->where('type', 'result')->last();
}

it('renders the configured device with unknown inventory when offline', function () {
    Process::fake(['*' => Process::result(errorOutput: 'Connection timed out', exitCode: 255)]);

    $this->get(route('home'))->assertOk()->assertInertia(fn (Assert $page) => $page
        ->component('usbcloud')->has('cloud.devices', 1)->where('cloud.devices.0.id', 'BLINK-PI')
        ->where('cloud.devices.0.status', 'offline')->where('cloud.devices.0.pending', null)
        ->where('cloud.devices.0.filesystem', null)->has('cloud.files', 0));

    Process::assertRanTimes(fn (PendingProcess $process): bool => end($process->command) === 'sudo -n blink-poc status', 1);
});

it('scans pending files and filesystem telemetry without transferring contents', function () {
    fakeUsbDevice([usbClip()]);

    $result = usbOperation('scan', 'BLINK-PI');

    expect($result['success'])->toBeTrue();
    $this->get(route('home'))->assertOk()->assertInertia(fn (Assert $page) => $page
        ->where('cloud.devices.0.pending', 1)->where('cloud.devices.0.filesystem.free_bytes', 7000)
        ->where('cloud.devices.0.firmware', '0.2.0')->where('cloud.devices.0.uptime_seconds', 3600)
        ->where('cloud.files.0.state', 'pending')->where('cloud.files.0.modified_at', '2026-11-07T10:00:00+00:00'));
    Process::assertNotRan(fn (PendingProcess $process): bool => $process->command[0] === 'scp');
    Process::assertRan(fn (PendingProcess $process): bool => str_contains(end($process->command), 'snapshot-close'));
});

it('pulls content once and retains downloadable archives after source deletion', function () {
    fakeUsbDevice([usbClip()]);

    expect(usbOperation('pull')['success'])->toBeTrue();
    expect(usbOperation('pull')['message'])->toBe('0 new files saved; 1 already saved.');
    $file = app(UsbCloud::class)->dashboard()['files'][0];
    $this->get(route('usbcloud.file', $file['id']))->assertOk()->assertDownload('clip.mp4');
    Process::assertRanTimes(fn (PendingProcess $process): bool => $process->command[0] === 'scp', 1);
    fakeUsbDevice([]);

    usbOperation('scan');

    $this->get(route('home'))->assertOk()->assertInertia(fn (Assert $page) => $page
        ->where('cloud.devices.0.pending', 0)->has('cloud.files', 1)
        ->where('cloud.files.0.state', 'pulled')->where('cloud.files.0.on_device', false));
    $this->get(route('usbcloud.file', $file['id']))->assertOk();
    Process::assertRanTimes(fn (PendingProcess $process): bool => $process->command[0] === 'scp', 1);
});

it('keeps content versions and retrieves archives beyond the last ten runs', function () {
    $client = app(UsbCloud::class)->client('BLINK-PI');
    File::ensureDirectoryExists($client->directory().'/objects');
    foreach (range(1, 12) as $number) {
        $run = (string) Str::ulid();
        $digest = hash('sha256', 'version '.$number);
        File::ensureDirectoryExists($client->directory().'/'.$run);
        File::put($client->directory().'/objects/'.$digest, 'version '.$number);
        File::put($client->directory().'/'.$run.'/result.json', json_encode(['id' => $run, 'at' => now()->toIso8601String(), 'success' => true, 'files' => [['id' => 0, 'name' => 'same.mp4', 'bytes' => strlen('version '.$number), 'sha256' => $digest]]]));
    }
    fakeUsbDevice([]);

    $this->get(route('home'))->assertOk()->assertInertia(fn (Assert $page) => $page->has('cloud.files', 12));

    Process::assertRan(fn (PendingProcess $process): bool => end($process->command) === 'sudo -n blink-poc status');
});

it('records checksum failures and releases the operation for retry', function () {
    fakeUsbDevice([usbClip()], corruptTransfer: true);

    $result = usbOperation('pull');

    expect($result['success'])->toBeFalse();
    expect($result['message'])->toContain('does not match the Pi checksum');
    expect(app(UsbCloud::class)->dashboard()['files'][0]['state'])->toBe('pending');
    expect(Cache::get('usbcloud.operation.BLINK-PI'))->toBeNull();
    Process::assertRan(fn (PendingProcess $process): bool => str_contains(end($process->command), 'snapshot-close'));
    fakeUsbDevice([usbClip()]);

    expect(usbOperation('pull')['success'])->toBeTrue();
    Process::assertRan(fn (PendingProcess $process): bool => $process->command[0] === 'scp');
});

it('reports overlapping operations without contacting the Pi', function () {
    Process::fake();
    $lock = Cache::lock('pi-poc-retrieval', 600);
    $lock->get();
    try {
        $result = usbOperation('pull');

        expect($result['success'])->toBeFalse();
        expect($result['message'])->toContain('already running');
        Process::assertNothingRan();
    } finally {
        $lock->release();
    }
});

it('rejects unknown devices and commands with 422 before running a process', function () {
    Process::fake();

    $this->postJson(route('usbcloud.operate'), ['action' => 'pull', 'device' => 'pi; reboot'])->assertUnprocessable()->assertJsonValidationErrors('device');
    $this->postJson(route('usbcloud.operate'), ['action' => 'reboot'])->assertUnprocessable()->assertJsonValidationErrors('action');
    $this->postJson(route('usbcloud.operate'), ['action' => 'unmount'])->assertUnprocessable();

    Process::assertNothingRan();
});

it('detaches and attaches only the selected device using fixed commands', function () {
    fakeUsbDevice();

    expect(usbOperation('unmount', 'BLINK-PI')['success'])->toBeTrue();
    expect(usbOperation('mount', 'BLINK-PI')['success'])->toBeTrue();

    Process::assertRan(fn (PendingProcess $process): bool => end($process->command) === 'sudo -n blink-poc detach');
    Process::assertRan(fn (PendingProcess $process): bool => end($process->command) === 'sudo -n blink-poc start');
});

it('saves settings and rejects invalid values without changing saved configuration', function () {
    $settings = ['server_name' => 'usbcloud-local', 'pull_interval' => 10, 'auto_pull' => true, 'theme' => 'paper'];

    $this->putJson(route('usbcloud.settings'), $settings)->assertOk()->assertJsonPath('settings', $settings);
    $this->putJson(route('usbcloud.settings'), [...$settings, 'pull_interval' => 4, 'theme' => 'fake'])->assertUnprocessable()->assertJsonValidationErrors(['pull_interval', 'theme']);

    expect(app(UsbCloud::class)->settings())->toBe($settings);
});

it('does not run automatic pulls when disabled and respects the saved interval', function () {
    $this->freezeTime();
    Process::fake();

    $this->artisan('usbcloud:sync')->assertSuccessful();

    Process::assertNothingRan();
    app(UsbCloud::class)->saveSettings(['server_name' => 'test', 'pull_interval' => 10, 'auto_pull' => true, 'theme' => 'phosphor']);
    fakeUsbDevice([]);

    $this->artisan('usbcloud:sync')->assertSuccessful();
    $this->artisan('usbcloud:sync')->assertSuccessful();
    $this->travel(10)->seconds();
    $this->artisan('usbcloud:sync')->assertSuccessful();

    Process::assertRanTimes(fn (PendingProcess $process): bool => str_contains(end($process->command), 'snapshot-open'), 2);
});

it('returns 404 for pending downloads and builds a zip of selected saved files', function () {
    fakeUsbDevice([usbClip('a.mp4'), usbClip('b.mp4')]);
    usbOperation('scan');
    $files = app(UsbCloud::class)->dashboard()['files'];

    $this->get(route('usbcloud.file', $files[0]['id']))->assertNotFound();
    $this->get(route('usbcloud.file', str_repeat('a', 64)))->assertNotFound();
    usbOperation('pull');
    $response = $this->get(route('usbcloud.download', ['files' => array_column($files, 'id')]))->assertOk()->assertDownload('usbcloud-files.zip');

    $path = $response->baseResponse->getFile()->getPathname();
    $zip = new ZipArchive;
    $zip->open($path);
    expect($zip->numFiles)->toBe(2);
    expect($zip->getFromIndex(0))->toBe('clip');
    $zip->close();
    File::delete($path);
    Process::assertRanTimes(fn (PendingProcess $process): bool => $process->command[0] === 'scp', 1);
});

it('enriches older archived entries with source modification times after a scan', function () {
    fakeUsbDevice([array_diff_key(usbClip(), ['modified_at' => true])]);
    usbOperation('pull');
    fakeUsbDevice([usbClip()]);

    usbOperation('scan');

    $this->get(route('home'))->assertOk()->assertInertia(fn (Assert $page) => $page
        ->where('cloud.files.0.modified_at', '2026-11-07T10:00:00+00:00')->where('cloud.files.0.on_device', true));
    Process::assertRanTimes(fn (PendingProcess $process): bool => $process->command[0] === 'scp', 1);
});

it('keeps server and individual client log streams separate', function () {
    config(['usbcloud.devices' => [
        'BLINK-PI' => ['host' => '192.168.87.62', 'directory' => config('pi-poc.directory')],
        'SECOND-PI' => ['host' => '192.168.87.63', 'directory' => config('pi-poc.directory').'-second'],
    ]]);
    fakeUsbDevice();
    $cloud = app(UsbCloud::class);
    $cloud->log('BLINK-PI', 'info', 'Server copied a recording from BLINK-PI.');
    File::put(config('usbcloud.directory').'/BLINK-PI-logs.json', json_encode(['entries' => [
        ['at' => now()->toIso8601String(), 'level' => 'ok', 'message' => 'First device opened a snapshot.'],
    ]]));
    File::put(config('usbcloud.directory').'/SECOND-PI-logs.json', json_encode(['entries' => [
        ['at' => now()->toIso8601String(), 'level' => 'ok', 'message' => 'Second device attached USB.'],
    ]]));

    $this->get(route('home'))->assertOk()->assertInertia(fn (Assert $page) => $page
        ->has('cloud.logs.server', 1)->where('cloud.logs.server.0.message', 'Server copied a recording from BLINK-PI.')
        ->where('cloud.logs.server.0.source', 'server')->where('cloud.logs.server.0.device', 'BLINK-PI')
        ->has('cloud.logs.devices.BLINK-PI', 1)->where('cloud.logs.devices.BLINK-PI.0.message', 'First device opened a snapshot.')
        ->where('cloud.logs.devices.BLINK-PI.0.origin', 'client')
        ->has('cloud.logs.devices.SECOND-PI', 1)->where('cloud.logs.devices.SECOND-PI.0.message', 'Second device attached USB.'));

    Process::assertNotRan(fn (PendingProcess $process): bool => str_contains(end($process->command), 'blink-poc logs'));
});

it('refreshes status and client logs during a pull without scanning or syncing files', function () {
    fakeUsbDevice();
    Cache::put('usbcloud.operation.BLINK-PI', 'pull', 600);
    $lock = Cache::lock('pi-poc-retrieval', 600);
    $lock->get();
    try {
        $result = usbOperation('refresh', 'BLINK-PI');

        expect($result['success'])->toBeTrue();
        expect(Cache::get('usbcloud.operation.BLINK-PI'))->toBe('pull');
        expect(File::glob(config('pi-poc.directory').'/*/result.json'))->toBe([]);
        expect(File::exists(config('pi-poc.directory').'/inventory.json'))->toBeFalse();
        Process::assertRan(fn (PendingProcess $process): bool => end($process->command) === 'sudo -n blink-poc status');
        Process::assertRan(fn (PendingProcess $process): bool => end($process->command) === 'sudo -n blink-poc logs');
        Process::assertNotRan(fn (PendingProcess $process): bool => str_contains(end($process->command), 'snapshot-') || $process->command[0] === 'scp');
    } finally {
        $lock->release();
    }
});

it('refreshes every configured device without starting a fleet pull', function () {
    config(['usbcloud.devices' => [
        'BLINK-PI' => ['host' => '192.168.87.62', 'directory' => config('pi-poc.directory')],
        'SECOND-PI' => ['host' => '192.168.87.63', 'directory' => config('pi-poc.directory').'-second'],
    ]]);
    fakeUsbDevice();

    $response = $this->postJson(route('usbcloud.operate'), ['action' => 'refresh'])->assertOk();
    $results = collect(explode("\n", trim($response->streamedContent())))->map(fn (string $line): array => json_decode($line, true))->where('type', 'result');

    expect($results->pluck('device')->all())->toBe(['BLINK-PI', 'SECOND-PI']);
    expect($results->pluck('success')->all())->toBe([true, true]);
    Process::assertRanTimes(fn (PendingProcess $process): bool => end($process->command) === 'sudo -n blink-poc status', 2);
    Process::assertNotRan(fn (PendingProcess $process): bool => str_contains(end($process->command), 'snapshot-') || $process->command[0] === 'scp');
});

it('polls only the client logs selected for display without performing a sync', function () {
    fakeUsbDevice();

    $this->get(route('home', ['log_devices' => ['BLINK-PI']]))->assertOk()->assertInertia(fn (Assert $page) => $page
        ->has('cloud.logs.devices.BLINK-PI', 1)->where('cloud.logs.devices.BLINK-PI.0.message', 'Manifest complete.')->has('cloud.logs.errors', 0));

    Process::assertRan(fn (PendingProcess $process): bool => end($process->command) === 'sudo -n blink-poc logs');
    Process::assertNotRan(fn (PendingProcess $process): bool => str_contains(end($process->command), 'snapshot-') || $process->command[0] === 'scp');
});

it('retains cached client logs and reports stream failures only as server diagnostics', function () {
    $this->freezeTime();
    File::ensureDirectoryExists(config('usbcloud.directory'));
    File::put(config('usbcloud.directory').'/BLINK-PI-logs.json', json_encode(['entries' => [
        ['at' => now()->toIso8601String(), 'level' => 'ok', 'message' => 'Device attached USB.'],
    ]]));
    Process::fake(fn (PendingProcess $process) => end($process->command) === 'sudo -n blink-poc logs'
        ? Process::result(errorOutput: 'Device log connection interrupted', exitCode: 255)
        : Process::result(output: '{"gadget_loaded":true}'));

    $this->get(route('home', ['log_devices' => ['BLINK-PI']]))->assertOk()->assertInertia(fn (Assert $page) => $page
        ->where('cloud.logs.errors.BLINK-PI', 'Device log connection interrupted')
        ->has('cloud.logs.devices.BLINK-PI', 1)->where('cloud.logs.devices.BLINK-PI.0.message', 'Device attached USB.')
        ->where('cloud.logs.server.0.message', 'Client logs unavailable: Device log connection interrupted'));
    Process::assertRan(fn (PendingProcess $process): bool => end($process->command) === 'sudo -n blink-poc logs');
    fakeUsbDevice();
    $this->travel(5)->seconds();

    $this->get(route('home', ['log_devices' => ['BLINK-PI']]))->assertOk()->assertInertia(fn (Assert $page) => $page
        ->has('cloud.logs.errors', 0)->where('cloud.logs.devices.BLINK-PI.0.message', 'Manifest complete.'));
    Process::assertRanTimes(fn (PendingProcess $process): bool => end($process->command) === 'sudo -n blink-poc logs', 2);
});

it('returns 422 for unknown device log subscriptions without contacting any client', function () {
    Process::fake();

    $this->getJson(route('home', ['log_devices' => ['UNKNOWN-PI']]))->assertUnprocessable()->assertJsonValidationErrors('log_devices.0');

    Process::assertNothingRan();
});
