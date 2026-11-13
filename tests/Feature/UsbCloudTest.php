<?php

use App\Jobs\PullUsbDevice;
use App\Services\DeviceHeartbeats;
use App\Services\UsbCloud;
use App\Services\UsbCloudDevices;
use App\Services\UsbCloudTransfers;
use Illuminate\Process\PendingProcess;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Sleep;
use Illuminate\Support\Str;
use Inertia\Testing\AssertableInertia as Assert;

beforeEach(function () {
    $directory = storage_path('framework/testing/usbcloud-'.Str::uuid());
    config(['usbcloud.directory' => $directory.'/server', 'usbcloud-client.directory' => $directory.'/pi', 'usbcloud-client.transfer_protocol' => 'sftp']);
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
        if (str_contains($command, 'snapshot-read')) {
            $description = Process::describe();
            $description->output = [['type' => 'out', 'buffer' => $corruptTransfer ? 'bad' : 'clip']];

            return $description;
        }
        if (str_contains($command, 'snapshot-open')) {
            return Process::result(output: json_encode(['token' => str_repeat('a', 32), 'path' => '/srv/usbcloud-client/snapshot']));
        }
        if (str_contains($command, 'snapshot-manifest')) {
            return Process::result(output: json_encode(['files' => $files, 'filesystem' => ['type' => 'exfat', 'mount' => '/srv/usbcloud-client/snapshot', 'total_bytes' => 8000, 'used_bytes' => 1000, 'free_bytes' => 7000]]));
        }
        if ($command === 'sudo -n usbcloud-client logs') {
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

    Process::assertRanTimes(fn (PendingProcess $process): bool => end($process->command) === 'sudo -n usbcloud-client status', 1);
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

    Process::assertRan(fn (PendingProcess $process): bool => end($process->command) === 'sudo -n usbcloud-client status');
});

it('records checksum failures and releases the operation for retry', function () {
    fakeUsbDevice([usbClip()], corruptTransfer: true);

    $result = usbOperation('pull');

    expect($result['success'])->toBeFalse();
    expect($result['message'])->toContain('does not match the Pi checksum');
    expect(app(UsbCloud::class)->dashboard()['files'][0]['state'])->toBe('failed');
    expect(Cache::get('usbcloud.operation.BLINK-PI'))->toBeNull();
    Process::assertRan(fn (PendingProcess $process): bool => str_contains(end($process->command), 'snapshot-close'));
    fakeUsbDevice([usbClip()]);

    expect(usbOperation('pull')['success'])->toBeTrue();
    Process::assertRan(fn (PendingProcess $process): bool => $process->command[0] === 'scp');
});

it('reports overlapping operations without contacting the Pi', function () {
    Process::fake();
    $lock = Cache::lock('usbcloud-client-retrieval', 600);
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

    Process::assertRan(fn (PendingProcess $process): bool => end($process->command) === 'sudo -n usbcloud-client detach');
    Process::assertRan(fn (PendingProcess $process): bool => end($process->command) === 'sudo -n usbcloud-client start');
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
        'BLINK-PI' => ['host' => '192.168.87.62', 'directory' => config('usbcloud-client.directory')],
        'SECOND-PI' => ['host' => '192.168.87.63', 'directory' => config('usbcloud-client.directory').'-second'],
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

    Process::assertNotRan(fn (PendingProcess $process): bool => str_contains(end($process->command), 'usbcloud-client logs'));
});

it('refreshes status and client logs during a pull without scanning or syncing files', function () {
    fakeUsbDevice();
    Cache::put('usbcloud.operation.BLINK-PI', 'pull', 600);
    $lock = Cache::lock('usbcloud-client-retrieval', 600);
    $lock->get();
    try {
        $result = usbOperation('refresh', 'BLINK-PI');

        expect($result['success'])->toBeTrue();
        expect(Cache::get('usbcloud.operation.BLINK-PI'))->toBe('pull');
        expect(File::glob(config('usbcloud-client.directory').'/*/result.json'))->toBe([]);
        expect(File::exists(config('usbcloud-client.directory').'/inventory.json'))->toBeFalse();
        Process::assertRan(fn (PendingProcess $process): bool => end($process->command) === 'sudo -n usbcloud-client status');
        Process::assertRan(fn (PendingProcess $process): bool => end($process->command) === 'sudo -n usbcloud-client logs');
        Process::assertNotRan(fn (PendingProcess $process): bool => str_contains(end($process->command), 'snapshot-') || $process->command[0] === 'scp');
    } finally {
        $lock->release();
    }
});

it('refreshes every configured device without starting a fleet pull', function () {
    config(['usbcloud.devices' => [
        'BLINK-PI' => ['host' => '192.168.87.62', 'directory' => config('usbcloud-client.directory')],
        'SECOND-PI' => ['host' => '192.168.87.63', 'directory' => config('usbcloud-client.directory').'-second'],
    ]]);
    fakeUsbDevice();

    $response = $this->postJson(route('usbcloud.operate'), ['action' => 'refresh'])->assertOk();
    $results = collect(explode("\n", trim($response->streamedContent())))->map(fn (string $line): array => json_decode($line, true))->where('type', 'result');

    expect($results->pluck('device')->all())->toBe(['BLINK-PI', 'SECOND-PI']);
    expect($results->pluck('success')->all())->toBe([true, true]);
    Process::assertRanTimes(fn (PendingProcess $process): bool => end($process->command) === 'sudo -n usbcloud-client status', 2);
    Process::assertNotRan(fn (PendingProcess $process): bool => str_contains(end($process->command), 'snapshot-') || $process->command[0] === 'scp');
});

it('polls only the client logs selected for display without performing a sync', function () {
    fakeUsbDevice();

    $this->get(route('home', ['log_devices' => ['BLINK-PI']]))->assertOk()->assertInertia(fn (Assert $page) => $page
        ->has('cloud.logs.devices.BLINK-PI', 1)->where('cloud.logs.devices.BLINK-PI.0.message', 'Manifest complete.')->has('cloud.logs.errors', 0));

    Process::assertRan(fn (PendingProcess $process): bool => end($process->command) === 'sudo -n usbcloud-client logs');
    Process::assertNotRan(fn (PendingProcess $process): bool => str_contains(end($process->command), 'snapshot-') || $process->command[0] === 'scp');
});

it('retains cached client logs and reports stream failures only as server diagnostics', function () {
    $this->freezeTime();
    File::ensureDirectoryExists(config('usbcloud.directory'));
    File::put(config('usbcloud.directory').'/BLINK-PI-logs.json', json_encode(['entries' => [
        ['at' => now()->toIso8601String(), 'level' => 'ok', 'message' => 'Device attached USB.'],
    ]]));
    Process::fake(fn (PendingProcess $process) => end($process->command) === 'sudo -n usbcloud-client logs'
        ? Process::result(errorOutput: 'Device log connection interrupted', exitCode: 255)
        : Process::result(output: '{"gadget_loaded":true}'));

    $this->get(route('home', ['log_devices' => ['BLINK-PI']]))->assertOk()->assertInertia(fn (Assert $page) => $page
        ->where('cloud.logs.errors.BLINK-PI', 'Device log connection interrupted')
        ->has('cloud.logs.devices.BLINK-PI', 1)->where('cloud.logs.devices.BLINK-PI.0.message', 'Device attached USB.')
        ->where('cloud.logs.server.0.message', 'Client logs unavailable: Device log connection interrupted'));
    Process::assertRan(fn (PendingProcess $process): bool => end($process->command) === 'sudo -n usbcloud-client logs');
    fakeUsbDevice();
    $this->travel(5)->seconds();

    $this->get(route('home', ['log_devices' => ['BLINK-PI']]))->assertOk()->assertInertia(fn (Assert $page) => $page
        ->has('cloud.logs.errors', 0)->where('cloud.logs.devices.BLINK-PI.0.message', 'Manifest complete.'));
    Process::assertRanTimes(fn (PendingProcess $process): bool => end($process->command) === 'sudo -n usbcloud-client logs', 2);
});

it('returns 422 for unknown device log subscriptions without contacting any client', function () {
    Process::fake();

    $this->getJson(route('home', ['log_devices' => ['UNKNOWN-PI']]))->assertUnprocessable()->assertJsonValidationErrors('log_devices.0');

    Process::assertNothingRan();
});

it('queues a background pull once and cancels it before any device access', function () {
    Queue::fake([PullUsbDevice::class]);
    Process::fake();

    $this->postJson(route('usbcloud.transfer'), ['action' => 'start', 'device' => 'BLINK-PI'])->assertAccepted()->assertJsonPath('results.BLINK-PI.transfer.state', 'queued');
    $this->postJson(route('usbcloud.transfer'), ['action' => 'start', 'device' => 'BLINK-PI'])->assertConflict();
    $progress = app(UsbCloudTransfers::class)->progress('BLINK-PI');
    $this->postJson(route('usbcloud.transfer'), ['action' => 'cancel', 'device' => 'BLINK-PI'])->assertAccepted()->assertJsonPath('results.BLINK-PI.transfer.state', 'cancelled');
    (new PullUsbDevice('BLINK-PI', $progress['token']))->handle(app(UsbCloud::class), app(UsbCloudTransfers::class));

    Queue::assertPushed(PullUsbDevice::class, 1);
    Process::assertNothingRan();
});

it('pauses after a manifest and closes the snapshot before resuming remaining files', function () {
    fakeUsbDevice([usbClip()]);
    app(UsbCloudTransfers::class)->update('BLINK-PI', ['state' => 'running']);
    Cache::put('usbcloud.control.BLINK-PI', 'pause', 60);

    expect(usbOperation('pull')['success'])->toBeTrue();
    expect(app(UsbCloudTransfers::class)->progress('BLINK-PI')['state'])->toBe('paused');
    Process::assertNotRan(fn (PendingProcess $process): bool => $process->command[0] === 'scp');
    Process::assertRan(fn (PendingProcess $process): bool => str_contains(end($process->command), 'snapshot-close'));
    Queue::fake([PullUsbDevice::class]);

    $this->postJson(route('usbcloud.transfer'), ['action' => 'resume', 'device' => 'BLINK-PI'])->assertAccepted();
    $progress = app(UsbCloudTransfers::class)->progress('BLINK-PI');
    (new PullUsbDevice('BLINK-PI', $progress['token']))->handle(app(UsbCloud::class), app(UsbCloudTransfers::class));

    expect(app(UsbCloudTransfers::class)->progress('BLINK-PI'))->toMatchArray(['state' => 'completed', 'done_files' => 1, 'done_bytes' => 4]);
    Queue::assertPushed(PullUsbDevice::class, 1);
});

it('rejects invalid transfer commands and controls without an active transfer', function () {
    Process::fake();

    $this->postJson(route('usbcloud.transfer'), ['action' => 'pause', 'device' => 'BLINK-PI'])->assertConflict();
    $this->postJson(route('usbcloud.transfer'), ['action' => 'reboot'])->assertUnprocessable()->assertJsonValidationErrors('action');
    $this->postJson(route('usbcloud.transfer'), ['action' => 'start', 'device' => '../server'])->assertUnprocessable()->assertJsonValidationErrors('device');

    Process::assertNothingRan();
});

it('persists device settings and applies port bandwidth snapshot and retry limits', function () {
    fakeUsbDevice([usbClip()]);
    $settings = ['name' => 'Garage', 'host' => 'pi-garage.local', 'port' => 2222, 'user' => 'pi', 'site' => 'Garage', 'auto_sync' => false, 'interval' => 300, 'bandwidth' => 0.5, 'snapshot_timeout' => 900, 'retry_count' => 2, 'retry_delay' => 5];

    $this->putJson(route('usbcloud.devices.update', 'BLINK-PI'), [...$settings, 'identity' => '/tmp/untrusted', 'directory' => '/tmp/untrusted'])->assertOk()->assertJsonPath('settings.name', 'Garage');
    expect(app(UsbCloud::class)->connections()['BLINK-PI'])->toMatchArray($settings);
    expect(app(UsbCloud::class)->client('BLINK-PI')->directory())->toBe(config('usbcloud-client.directory'));
    usbOperation('pull');

    Process::assertRan(fn (PendingProcess $process): bool => str_contains(end($process->command), 'snapshot-open --timeout 900'));
    Process::assertRan(fn (PendingProcess $process): bool => $process->command[0] === 'scp' && in_array('4000', $process->command, true) && in_array('Port=2222', $process->command, true));
    $this->putJson(route('usbcloud.devices.update', 'BLINK-PI'), [...$settings, 'host' => 'pi;reboot', 'port' => 0])->assertUnprocessable()->assertJsonValidationErrors(['host', 'port']);
    expect(app(UsbCloud::class)->connections()['BLINK-PI']['host'])->toBe('pi-garage.local');
});

it('adds a reachable client and restores it without losing its archive on removal', function () {
    fakeUsbDevice([usbClip()]);
    $connection = ['name' => 'Garage', 'host' => 'garage.local', 'port' => 22, 'user' => 'pi'];
    $response = $this->postJson(route('usbcloud.devices.add'), $connection)->assertCreated();
    $id = $response->json('device');
    expect(app(UsbCloud::class)->connections())->toHaveKey($id);
    usbOperation('pull', $id);
    $file = collect(app(UsbCloud::class)->allFiles())->firstWhere('device', $id);

    $this->deleteJson(route('usbcloud.devices.remove', $id))->assertOk();
    expect(app(UsbCloud::class)->connections())->not->toHaveKey($id);
    $this->get(route('usbcloud.file', $file['id']))->assertOk()->assertDownload('clip.mp4');
    $this->get(route('home'))->assertOk()->assertInertia(fn (Assert $page) => $page->has('cloud.files', 1));
    $this->postJson(route('usbcloud.devices.add'), $connection)->assertCreated()->assertJsonPath('device', $id);
    $this->postJson(route('usbcloud.devices.add'), $connection)->assertUnprocessable()->assertJsonPath('message', 'This address is already in the fleet as '.$id.'.');
});

it('rejects unreachable pairing without saving a device and prevents removal during a transfer', function () {
    Process::fake(['*' => Process::result(errorOutput: 'Host key verification failed', exitCode: 255)]);

    $this->postJson(route('usbcloud.devices.add'), ['name' => '', 'host' => 'new.local', 'port' => 22, 'user' => 'pi'])->assertUnprocessable()->assertJsonPath('message', 'Host key verification failed');
    expect(app(UsbCloud::class)->connections())->toHaveCount(1);
    app(UsbCloudTransfers::class)->update('BLINK-PI', ['state' => 'running']);
    $this->deleteJson(route('usbcloud.devices.remove', 'BLINK-PI'))->assertConflict();
    expect(app(UsbCloud::class)->connections())->toHaveKey('BLINK-PI');
});

it('tests draft connection settings without persisting them', function () {
    fakeUsbDevice();

    $this->postJson(route('usbcloud.devices.test', 'BLINK-PI'), ['name' => 'Draft', 'host' => 'draft.local', 'port' => 2222, 'user' => 'pi'])->assertOk()->assertJsonPath('success', true)->assertJsonPath('state.version', '0.2.0');
    expect(app(UsbCloud::class)->connections()['BLINK-PI']['name'])->toBe('Blink USB storage');
    Process::assertRan(fn (PendingProcess $process): bool => in_array('pi@draft.local', $process->command, true) && in_array('Port=2222', $process->command, true));
});

it('discovers service advertisements and marks configured clients as already paired', function () {
    Process::fake(['*' => Process::result(output: "Garage._usbcloud._tcp.local. IN SRV 0 0 22 garage.local. ; Replace with unicast FQDN of target host\n")]);

    $this->getJson(route('usbcloud.discover'))->assertOk()->assertJsonPath('devices.0.host', 'garage.local')->assertJsonPath('devices.0.port', 22)->assertJsonPath('devices.1.id', 'BLINK-PI');

    Process::assertRanTimes(fn (PendingProcess $process): bool => str_contains(implode(' ', $process->command), '_usbcloud._tcp'), 1);
});

it('uses per device automatic sync settings independently from server defaults', function () {
    $this->freezeTime();
    fakeUsbDevice();
    app(UsbCloudDevices::class)->save('BLINK-PI', ['auto_sync' => true, 'interval' => 30]);

    $this->artisan('usbcloud:sync')->assertSuccessful();
    $this->artisan('usbcloud:sync')->assertSuccessful();
    $this->travel(30)->seconds();
    $this->artisan('usbcloud:sync')->assertSuccessful();

    Process::assertRanTimes(fn (PendingProcess $process): bool => str_contains(end($process->command), 'snapshot-open'), 2);
});

it('retries failed transfers under the device policy and leaves unverified data out of the archive', function () {
    Sleep::fake();
    fakeUsbDevice([usbClip()], corruptTransfer: true);
    app(UsbCloudDevices::class)->save('BLINK-PI', ['retry_count' => 1, 'retry_delay' => 5]);

    expect(usbOperation('pull')['success'])->toBeFalse();
    expect(File::glob(config('usbcloud-client.directory').'/objects/*'))->toBe([]);
    expect(app(UsbCloudTransfers::class)->progress('BLINK-PI')['state'])->toBe('failed');
    Process::assertRanTimes(fn (PendingProcess $process): bool => $process->command[0] === 'scp', 2);
    Sleep::assertSleptTimes(5);
});

it('cancels a paused pull without reopening the device snapshot', function () {
    Process::fake();
    app(UsbCloudTransfers::class)->update('BLINK-PI', ['state' => 'paused']);

    $this->postJson(route('usbcloud.transfer'), ['action' => 'cancel'])->assertAccepted()->assertJsonPath('results.BLINK-PI.transfer.state', 'cancelled');

    Process::assertNothingRan();
});

it('extracts clip metadata once and serves video previews with the correct content type', function () {
    fakeUsbDevice([usbClip()]);
    usbOperation('pull');
    Process::fake(function (PendingProcess $process) {
        return str_contains($process->command[0], 'ffprobe')
            ? Process::result(output: '{"format":{"duration":"12.5"},"streams":[{"codec_type":"video","width":1920,"height":1080}]}')
            : Process::result(output: '{"gadget_loaded":true}');
    });
    $cloud = app(UsbCloud::class);
    $file = $cloud->dashboard()['files'][0];

    expect($file['media'])->toBe(['duration' => 12.5, 'width' => 1920, 'height' => 1080]);
    $cloud->dashboard();
    $this->get(route('usbcloud.file', ['file' => $file['id'], 'preview' => true]))->assertOk()->assertHeader('Content-Type', 'video/mp4');
    Process::assertRanTimes(fn (PendingProcess $process): bool => str_contains($process->command[0], 'ffprobe'), 1);
});

it('streams verified file contents through the restricted client protocol without SFTP access', function () {
    config(['usbcloud-client.transfer_protocol' => 'stream']);
    fakeUsbDevice([usbClip('folder/clip with spaces.mp4')]);

    $result = usbOperation('pull');
    $this->assertTrue($result['success'], $result['message']);
    $file = app(UsbCloud::class)->allFiles()[0];
    $this->get(route('usbcloud.file', $file['id']))->assertOk()->assertDownload('clip with spaces.mp4');
    expect(File::get(config('usbcloud-client.directory').'/objects/'.hash('sha256', 'clip')))->toBe('clip');
    Process::assertNotRan(fn (PendingProcess $process): bool => $process->command[0] === 'scp');
    Process::assertRan(fn (PendingProcess $process): bool => str_contains(end($process->command), 'snapshot-read --token '.str_repeat('a', 32).' --path '.strtr(base64_encode('folder/clip with spaces.mp4'), '+/', '-_')));
});

it('matches a discovered hostname to the paired client and keeps one discovery result', function () {
    Process::fake(['*' => Process::result(output: "USBCloud\\032on\\032blink-pi._usbcloud._tcp SRV 0 0 22 blink-pi.local. ; Replace with unicast FQDN of target host\n")]);

    $this->getJson(route('usbcloud.discover'))->assertOk()->assertJsonCount(1, 'devices')->assertJsonPath('devices.0.id', 'BLINK-PI')->assertJsonPath('devices.0.host', 'blink-pi.local');

    Process::assertRanTimes(fn (PendingProcess $process): bool => str_contains(implode(' ', $process->command), '_usbcloud._tcp'), 1);
});

function heartbeatState(): array
{
    return ['version' => '0.4.0', 'hostname' => 'blink-pi', 'uptime_seconds' => 3600,
        'gadget_loaded' => true, 'usb_state' => ['usb' => 'configured'],
        'metrics' => ['cpu_temperature_c' => 48.5, 'load_1m' => 0.25, 'cpu_count' => 4,
            'memory_used_percent' => 42, 'root_used_percent' => 30, 'root_free_bytes' => 9000000, 'throttled_flags' => 0]];
}

it('uses authenticated heartbeats without SSH and marks stale clients offline while retaining metrics', function () {
    $this->freezeTime();
    Process::fake();
    app(UsbCloudDevices::class)->save('BLINK-PI', ['heartbeat_token_hash' => hash('sha256', 'secret')]);
    $url = route('devices.heartbeat', 'BLINK-PI');
    $this->withToken('secret')->postJson($url, heartbeatState())->assertOk()->assertJsonPath('interval_seconds', 30);
    $this->get(route('home'))->assertInertia(fn (Assert $page) => $page
        ->where('cloud.devices.0.status', 'online')->where('cloud.devices.0.metrics.cpu_temperature_c', 48.5)
        ->where('cloud.devices.0.status_source', 'heartbeat')->missing('cloud.devices.0.config.heartbeat_token_hash'));
    $this->travel(90)->seconds();
    $this->get(route('home'))->assertInertia(fn (Assert $page) => $page
        ->where('cloud.devices.0.status', 'offline')->where('cloud.devices.0.metrics.cpu_temperature_c', 48.5));
    $this->withToken('secret')->postJson($url, heartbeatState())->assertOk();
    expect(app(UsbCloud::class)->dashboard()['devices'][0]['status'])->toBe('online');
    Process::assertNothingRan();
});

it('rejects missing wrong cross-device and revoked heartbeat credentials with 401', function () {
    app(UsbCloudDevices::class)->save('BLINK-PI', ['heartbeat_token_hash' => hash('sha256', 'secret')]);
    app(UsbCloudDevices::class)->save('OTHER', ['host' => 'other.local', 'heartbeat_token_hash' => hash('sha256', 'other')]);
    $url = route('devices.heartbeat', 'BLINK-PI');
    $this->postJson($url, heartbeatState())->assertUnauthorized();
    $this->withToken('wrong')->postJson($url, heartbeatState())->assertUnauthorized();
    $this->withToken('secret')->postJson(route('devices.heartbeat', 'OTHER'), heartbeatState())->assertUnauthorized();
    $this->withToken('secret')->postJson(route('devices.heartbeat', 'UNKNOWN'), heartbeatState())->assertUnauthorized();
    $this->deleteJson(route('usbcloud.devices.remove', 'BLINK-PI'))->assertOk();
    $this->withToken('secret')->postJson($url, heartbeatState())->assertUnauthorized();
});

it('validates metrics and prevents clients setting backend fields', function () {
    app(UsbCloudDevices::class)->save('BLINK-PI', ['heartbeat_token_hash' => hash('sha256', 'secret')]);
    $state = heartbeatState();
    $state['metrics']['memory_used_percent'] = 101;
    $this->withToken('secret')->postJson(route('devices.heartbeat', 'BLINK-PI'), $state)->assertUnprocessable()->assertJsonValidationErrors('metrics.memory_used_percent');
    $state = heartbeatState();
    $state['metrics']['injected'] = 'bad';
    $this->postJson(route('devices.heartbeat', 'BLINK-PI'), $state)->assertUnprocessable()->assertJsonValidationErrors('metrics');
    $this->postJson(route('devices.heartbeat', 'BLINK-PI'), [...heartbeatState(), 'checked_at' => '2099-01-01', 'heartbeat_token_hash' => 'bad'])->assertOk();
    expect(app(DeviceHeartbeats::class)->status('BLINK-PI')['state'])->not->toHaveKeys(['checked_at', 'heartbeat_token_hash']);
});

it('reports health warnings and waiting state independently from heartbeat connectivity', function () {
    app(UsbCloudDevices::class)->save('BLINK-PI', ['heartbeat_token_hash' => hash('sha256', 'secret')]);
    expect(app(UsbCloud::class)->dashboard()['devices'][0])->toMatchArray(['status' => 'offline', 'checked_at' => null, 'metrics' => null]);
    $state = heartbeatState();
    $state['metrics'] = ['cpu_temperature_c' => 80, 'memory_used_percent' => 90, 'root_used_percent' => 90, 'throttled_flags' => 1];
    $this->withToken('secret')->postJson(route('devices.heartbeat', 'BLINK-PI'), $state)->assertOk();
    $device = app(UsbCloud::class)->dashboard()['devices'][0];
    expect($device['status'])->toBe('fault');
    expect($device['health_warnings'])->toHaveCount(4);
});

it('rotates heartbeat credentials without exposing their plaintext and rolls back failed setup', function () {
    fakeUsbDevice();
    $heartbeats = app(DeviceHeartbeats::class);
    $heartbeats->pair('BLINK-PI');
    $hash = app(UsbCloudDevices::class)->all()['BLINK-PI']['heartbeat_token_hash'];
    expect(strlen($hash))->toBe(64);
    $heartbeats->pair('BLINK-PI');
    $rotated = app(UsbCloudDevices::class)->all()['BLINK-PI']['heartbeat_token_hash'];
    expect($rotated)->not->toBe($hash);
    Process::assertRan(fn (PendingProcess $process): bool => end($process->command) === 'sudo -n usbcloud-client heartbeat-configure');
    Process::fake(['*' => Process::result(exitCode: 1)]);
    expect(fn () => $heartbeats->pair('BLINK-PI'))->toThrow(RuntimeException::class);
    expect(app(UsbCloudDevices::class)->all()['BLINK-PI']['heartbeat_token_hash'])->toBe($rotated);
});

it('starts with an empty fleet in containers and stores new device archives in the mapped share', function () {
    config(['usbcloud.include_default_device' => false, 'usbcloud.archive_directory' => '/archive']);
    Process::fake();
    $this->get(route('home'))->assertInertia(fn (Assert $page) => $page->has('cloud.devices', 0)->where('cloud.server.storage_root', '/archive'));
    app(UsbCloudDevices::class)->save('GARAGE', ['host' => 'garage.local']);
    expect(app(UsbCloudDevices::class)->all()['GARAGE']['directory'])->toBe(config('usbcloud.directory').'/devices/GARAGE');
    expect(app(UsbCloudDevices::class)->all()['GARAGE']['archive_directory'])->toBe('/archive/devices/GARAGE');
    Process::assertNothingRan();
});

it('opens each fleet location directly with the matching navigation', function (string $path, string $screen, ?string $device, string $section) {
    fakeUsbDevice();

    $this->get($path)->assertOk()->assertInertia(fn (Assert $page) => $page
        ->component('usbcloud')
        ->where('navigation.screen', $screen)
        ->where('navigation.device', $device)
        ->where('navigation.section', $section)
        ->has('cloud.devices', 1));
})->with([
    'home' => ['/', 'devices', null, 'overview'],
    'fleet' => ['/usbcloud/devices?status=offline&selected=BLINK-PI', 'devices', null, 'overview'],
    'device' => ['/usbcloud/devices/BLINK-PI', 'device', 'BLINK-PI', 'overview'],
    'device overview' => ['/usbcloud/devices/BLINK-PI/overview', 'device', 'BLINK-PI', 'overview'],
    'device files' => ['/usbcloud/devices/BLINK-PI/files', 'device', 'BLINK-PI', 'files'],
    'device logs' => ['/usbcloud/devices/BLINK-PI/log', 'device', 'BLINK-PI', 'log'],
    'device settings' => ['/usbcloud/devices/BLINK-PI/settings', 'device', 'BLINK-PI', 'settings'],
    'files' => ['/usbcloud/files?tab=all&filter_device=BLINK-PI', 'files', null, 'overview'],
    'gallery' => ['/usbcloud/gallery?filter_q=recording', 'gallery', null, 'overview'],
    'server logs' => ['/usbcloud/logs', 'log', null, 'overview'],
    'server settings' => ['/usbcloud/settings', 'settings', null, 'overview'],
]);

it('returns an Inertia page when navigating between fleet locations', function () {
    fakeUsbDevice();

    $version = $this->get('/')->viewData('page')['version'];

    $this->withHeaders(['X-Inertia' => 'true', 'X-Inertia-Version' => $version])
        ->get('/usbcloud/devices/BLINK-PI/settings')
        ->assertOk()
        ->assertHeader('X-Inertia', 'true')
        ->assertJsonPath('component', 'usbcloud')
        ->assertJsonPath('url', '/usbcloud/devices/BLINK-PI/settings')
        ->assertJsonPath('props.navigation.section', 'settings');
});

it('returns 404 for unavailable device locations', function (string $path) {
    Process::fake();

    $this->get($path)->assertNotFound();

    Process::assertNothingRan();
})->with([
    '/usbcloud/devices/UNKNOWN',
    '/usbcloud/devices/BLINK-PI/unknown',
]);

it('keeps fleet locations accessible when no devices are configured', function () {
    config(['usbcloud.include_default_device' => false]);
    Process::fake();

    $this->get('/usbcloud/files?tab=pulled')->assertOk()->assertInertia(fn (Assert $page) => $page
        ->where('navigation.screen', 'files')->has('cloud.devices', 0)->has('cloud.files', 0));

    Process::assertNothingRan();
});
