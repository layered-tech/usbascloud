<?php

use App\Services\UsbCloudClient;
use App\Services\UsbCloudDevices;
use Illuminate\Process\PendingProcess;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Str;

beforeEach(function () {
    $directory = storage_path('framework/testing/install-'.Str::uuid());
    config(['usbcloud.directory' => $directory, 'usbcloud.include_default_device' => false,
        'usbcloud-client.identity' => $directory.'/identity', 'app.url' => 'http://nas.test:8088',
        'usbcloud.heartbeat_url' => null]);
});

afterEach(function () {
    File::deleteDirectory(config('usbcloud.directory'));
});

function installationHostKey(string $byte = 'a'): string
{
    return 'ssh-ed25519 '.base64_encode(pack('N', 11).'ssh-ed25519'.pack('N', 32).str_repeat($byte, 32));
}

function installationToken(): string
{
    File::ensureDirectoryExists(config('usbcloud.directory'));
    File::put(config('usbcloud-client.identity').'.pub', installationHostKey());
    $response = test()->postJson(route('usbcloud.installations.store'), [
        'name' => 'Garage', 'host' => 'pi.local', 'port' => 22, 'user' => 'chris',
        'known_hosts_file' => '/etc/passwd', 'identity' => '/private/key',
    ])->assertCreated();
    preg_match('/[a-zA-Z0-9]{64}/', $response->json('command'), $matches);

    return $matches[0];
}

it('provides setup configuration without creating a device or accepting connection overrides', function () {
    $token = installationToken();

    $this->withToken($token)->postJson(route('client.installation.configuration'))
        ->assertOk()->assertJsonPath('user', 'chris')->assertJsonPath('host', 'pi.local')
        ->assertJsonPath('public_key', installationHostKey())->assertJsonMissingPath('identity')
        ->assertJsonMissingPath('known_hosts_file');
    expect(app(UsbCloudDevices::class)->all())->toBeEmpty();
});

it('registers a pinned host key and accepts its first heartbeat without interactive SSH', function () {
    $token = installationToken();
    $response = $this->withToken($token)->postJson(route('client.installation.enroll'), ['host_key' => installationHostKey().' pi@garage'])->assertCreated();
    $id = $response->json('device');
    $connection = app(UsbCloudDevices::class)->all()[$id];

    expect($connection['host'])->toBe('pi.local');
    expect($connection['user'])->toBe('chris');
    expect(File::get($connection['known_hosts_file']))->toBe($id.' '.installationHostKey()."\n");
    expect($connection['heartbeat_token_hash'])->toBe(hash('sha256', $response->json('token')));
    expect($response->json('url'))->toBe('http://nas.test:8088/api/v1/devices/'.$id.'/heartbeat');
    $this->withToken($response->json('token'))->postJson(route('devices.heartbeat', $id), [
        'version' => '0.4.0', 'hostname' => 'garage', 'uptime_seconds' => 10,
        'gadget_loaded' => false, 'usb_state' => [], 'metrics' => ['cpu_count' => 4],
    ])->assertOk();
    expect(File::exists(config('usbcloud.directory').'/heartbeats/'.$id.'.json'))->toBeTrue();
    Process::fake(['*' => Process::result(output: '{"version":"0.4.0"}')]);
    (new UsbCloudClient($connection))->status();
    Process::assertRan(fn (PendingProcess $process): bool => in_array('UserKnownHostsFile='.$connection['known_hosts_file'], $process->command, true)
        && in_array('StrictHostKeyChecking=yes', $process->command, true) && in_array('HostKeyAlias='.$id, $process->command, true));
});

it('allows the same Pi to retry without duplicating devices or rotating its heartbeat token', function () {
    $token = installationToken();
    $first = $this->withToken($token)->postJson(route('client.installation.enroll'), ['host_key' => installationHostKey()])->assertCreated()->json();

    $this->withToken($token)->postJson(route('client.installation.enroll'), ['host_key' => installationHostKey()])->assertCreated()->assertExactJson($first);
    expect(app(UsbCloudDevices::class)->all())->toHaveCount(1);
    $this->withToken($token)->postJson(route('client.installation.enroll'), ['host_key' => installationHostKey('b')])->assertConflict();
    expect(File::get(app(UsbCloudDevices::class)->all()[$first['device']]['known_hosts_file']))->toBe($first['device'].' '.installationHostKey()."\n");
});

it('rejects missing invalid and expired setup credentials with 401', function () {
    $this->postJson(route('client.installation.configuration'))->assertUnauthorized();
    $this->withToken(str_repeat('x', 64))->postJson(route('client.installation.enroll'), ['host_key' => installationHostKey()])->assertUnauthorized();
    $this->freezeTime();
    $token = installationToken();
    $this->travel(25)->hours();

    $this->withToken($token)->postJson(route('client.installation.configuration'))->assertUnauthorized();
    $this->withToken($token)->postJson(route('client.installation.enroll'), ['host_key' => installationHostKey()])->assertUnauthorized();
    expect(app(UsbCloudDevices::class)->all())->toBeEmpty();
});

it('rejects malformed or injected host keys with 422 without registering a device', function (string $key) {
    $token = installationToken();

    $this->withToken($token)->postJson(route('client.installation.enroll'), ['host_key' => $key])->assertUnprocessable();
    expect(app(UsbCloudDevices::class)->all())->toBeEmpty();
    expect(File::isDirectory(config('usbcloud.directory').'/known-hosts'))->toBeFalse();
})->with(['ssh-ed25519 aaaa', "ssh-ed25519 AAAA\nother-host ssh-ed25519 AAAA", 'command="id" ssh-ed25519 AAAA']);

it('rejects reused commands after removal or token rotation with 409', function (bool $remove) {
    $token = installationToken();
    $id = $this->withToken($token)->postJson(route('client.installation.enroll'), ['host_key' => installationHostKey()])->assertCreated()->json('device');
    app(UsbCloudDevices::class)->save($id, $remove ? ['removed' => true] : ['heartbeat_token_hash' => hash('sha256', 'rotated')]);

    $this->withToken($token)->postJson(route('client.installation.enroll'), ['host_key' => installationHostKey()])->assertConflict();
    expect(app(UsbCloudDevices::class)->all(true)[$id]['removed'])->toBe($remove);
})->with([true, false]);

it('prevents competing setup commands from replacing an enrolled device with 409', function () {
    $first = installationToken();
    $second = installationToken();
    $this->withToken($first)->postJson(route('client.installation.enroll'), ['host_key' => installationHostKey()])->assertCreated();

    $this->withToken($second)->postJson(route('client.installation.enroll'), ['host_key' => installationHostKey('b')])->assertConflict();
    expect(app(UsbCloudDevices::class)->all())->toHaveCount(1);
    $this->postJson(route('usbcloud.installations.store'), ['host' => 'pi.local', 'port' => 22, 'user' => 'chris', 'name' => 'New'])->assertConflict();
});

it('validates setup inputs and reports a missing server identity before issuing a command', function () {
    $this->postJson(route('usbcloud.installations.store'), [])->assertUnprocessable()->assertJsonValidationErrors(['host', 'name', 'port', 'user']);
    $this->postJson(route('usbcloud.installations.store'), ['host' => 'pi.local', 'port' => 22, 'user' => 'pi', 'name' => 'Pi'])
        ->assertUnprocessable()->assertJsonPath('message', 'The server SSH public key is missing. Configure the server SSH identity first.');
    $this->postJson(route('usbcloud.installations.store'), ['host' => 'pi.local', 'port' => 22, 'user' => 'root', 'name' => 'Pi'])->assertUnprocessable();
    $this->postJson(route('usbcloud.installations.store'), ['host' => 'pi.local', 'port' => 2222, 'user' => 'pi', 'name' => 'Pi'])->assertUnprocessable();
});

it('serves only the three installation assets', function () {
    foreach (['install.sh', 'install_client.py', 'usbcloud_client.py'] as $file) {
        $this->get(route('client.installation.asset', $file))->assertOk()->assertHeader('Content-Type', 'text/plain; charset=utf-8');
    }
    $this->get(route('client.installation.asset', '.env'))->assertNotFound();
});

it('accepts a public identity file used with an SSH agent', function () {
    File::ensureDirectoryExists(config('usbcloud.directory'));
    $path = config('usbcloud.directory').'/agent.pub';
    File::put($path, installationHostKey());
    config(['usbcloud-client.identity' => $path]);

    $this->postJson(route('usbcloud.installations.store'), ['host' => 'pi.local', 'port' => 22, 'user' => 'pi', 'name' => 'Pi'])->assertCreated();
});

it('pulls through the restricted protocol even when the server defaults to SFTP', function () {
    config(['usbcloud-client.transfer_protocol' => 'sftp', 'usbcloud.archive_directory' => null]);
    $token = installationToken();
    $id = $this->withToken($token)->postJson(route('client.installation.enroll'), ['host_key' => installationHostKey()])->assertCreated()->json('device');
    Process::fake(function (PendingProcess $process) {
        $command = end($process->command);
        if (str_contains($command, 'snapshot-open')) {
            return Process::result(output: json_encode(['token' => str_repeat('a', 32), 'path' => '/srv/usbcloud-client/snapshot']));
        }
        if (str_contains($command, 'snapshot-manifest')) {
            return Process::result(output: json_encode(['files' => [['name' => 'clip.mp4', 'bytes' => 4, 'sha256' => hash('sha256', 'clip')]]]));
        }
        if (str_contains($command, 'snapshot-read')) {
            $description = Process::describe();
            $description->output = [['type' => 'out', 'buffer' => 'clip']];

            return $description;
        }

        return Process::result(output: '{}');
    });
    $connection = app(UsbCloudDevices::class)->all()[$id];

    $result = (new UsbCloudClient($connection))->retrieve();

    expect($result['success'])->toBeTrue();
    expect(File::get($connection['directory'].'/objects/'.hash('sha256', 'clip')))->toBe('clip');
    Process::assertNotRan(fn (PendingProcess $process): bool => in_array($process->command[0], ['scp', 'sftp'], true));
});
