<?php

use App\Services\UsbCloud;
use App\Services\UsbCloudClient;
use App\Services\UsbCloudDevices;
use App\Services\UsbCloudExports;
use App\Services\UsbCloudTransfers;
use Illuminate\Process\PendingProcess;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Str;

beforeEach(function () {
    $directory = storage_path('framework/testing/volumes-'.Str::uuid());
    config(['usbcloud.directory' => $directory.'/server', 'usbcloud-client.directory' => $directory.'/device', 'usbcloud-client.transfer_protocol' => 'stream', 'usbcloud.readable_exports' => true]);
});

afterEach(function () {
    File::deleteDirectory(dirname(config('usbcloud.directory')));
});

function volumeManifest(string $generation = 'a', string $contents = 'clip'): array
{
    return ['protocol' => 2, 'volumes' => [
        ['id' => 'p1', 'generation' => str_repeat($generation, 64), 'type' => 'exfat', 'mounted' => true],
        ['id' => 'p2', 'generation' => str_repeat('c', 64), 'type' => 'ext4', 'mounted' => true],
    ], 'volume_changes' => [['volume_id' => 'p1', 'kind' => $generation === 'a' ? 'added' : 'reformatted']], 'files' => array_map(fn (string $volume): array => [
        'name' => 'volumes/'.$volume.'/DCIM/clip.mp4', 'source_path' => 'DCIM/clip.mp4', 'volume_id' => $volume,
        'volume_generation' => str_repeat($volume === 'p1' ? $generation : 'c', 64),
        'sha256' => hash('sha256', $contents), 'bytes' => strlen($contents), 'modified_at' => '2026-11-11T10:00:00+00:00',
    ], ['p1', 'p2'])];
}

function fakeVolumeClient(array $manifest, string $contents = 'clip'): void
{
    Process::fake(function (PendingProcess $process) use ($manifest, $contents) {
        $command = end($process->command);
        if (str_contains($command, 'snapshot-manifest')) {
            return Process::result(output: json_encode($manifest));
        }
        if (str_contains($command, 'snapshot-open')) {
            return Process::result(output: json_encode(['token' => str_repeat('a', 32), 'path' => '/srv/usbcloud-client/snapshot']));
        }
        if (str_contains($command, 'snapshot-read')) {
            $description = Process::describe();
            $description->output = [['type' => 'out', 'buffer' => $contents]];

            return $description;
        }

        return Process::result(output: '{"gadget_loaded":true}');
    });
}

it('retrieves matching filenames from multiple volumes into separate readable exports', function () {
    config(['usbcloud-client.transfer_protocol' => 'sftp']);
    fakeVolumeClient(volumeManifest());
    $client = new UsbCloudClient;

    $result = $client->retrieve();

    expect($result['success'])->toBeTrue()->and($result['reused_files'])->toHaveCount(1);
    $paths = File::glob($client->directory().'/exports/2026/11/11/*/DCIM/clip.mp4');
    expect($paths)->toHaveCount(2)->and(File::get($paths[0]))->toBe('clip')->and(File::get($paths[1]))->toBe('clip');
    expect(File::glob($client->directory().'/objects/*'))->toHaveCount(1);
    Process::assertRanTimes(fn (PendingProcess $process): bool => str_contains(end($process->command), 'snapshot-read'), 1);
    expect(json_decode(File::get($client->directory().'/inventory.json'), true)['volumes'])->toHaveCount(2);
});

it('keeps archived occurrences after reformatting even when names and contents are reused', function () {
    fakeVolumeClient(volumeManifest());
    $client = new UsbCloudClient;
    expect($client->retrieve()['success'])->toBeTrue();
    fakeVolumeClient(volumeManifest('b'));

    $result = $client->retrieve();

    expect($result['success'])->toBeTrue()->and($result['volume_changes'][0]['kind'])->toBe('reformatted');
    $files = app(UsbCloud::class)->allFiles();
    expect($files)->toHaveCount(3)->and(collect($files)->where('on_device', true))->toHaveCount(2)
        ->and(collect($files)->where('on_device', false)->first()['volume_generation'])->toBe(str_repeat('a', 64));
    expect(File::glob($client->directory().'/exports/2026/11/11/*/DCIM/clip.mp4'))->toHaveCount(3);
    Process::assertRanTimes(fn (PendingProcess $process): bool => str_contains(end($process->command), 'snapshot-read'), 1);
});

it('preserves older readable files when the same source name gets different content', function () {
    fakeVolumeClient(volumeManifest());
    $client = new UsbCloudClient;
    expect($client->retrieve()['success'])->toBeTrue();
    fakeVolumeClient(volumeManifest(contents: 'changed'), 'changed');

    expect($client->retrieve()['success'])->toBeTrue();

    $base = $client->directory().'/exports/2026/11/11/p1-'.str_repeat('a', 64).'/DCIM/';
    expect(File::get($base.'clip.mp4'))->toBe('clip')
        ->and(File::get($base.hash('sha256', 'changed').'--clip.mp4'))->toBe('changed');
});

it('archives readable siblings and reports unsupported volumes without discarding inventory', function () {
    $manifest = volumeManifest();
    $manifest['volumes'][1] = [...$manifest['volumes'][1], 'type' => 'crypto_LUKS', 'mounted' => false, 'error' => 'Unsupported filesystem: crypto_LUKS'];
    array_pop($manifest['files']);
    fakeVolumeClient($manifest);
    $client = new UsbCloudClient;

    $result = $client->retrieve();

    expect($result['success'])->toBeFalse()->and($result['files'])->toHaveCount(1)
        ->and($result['error'])->toContain('Unsupported filesystem');
    expect(File::glob($client->directory().'/exports/2026/11/11/*/DCIM/clip.mp4'))->toHaveCount(1);
    Process::assertRan(fn (PendingProcess $process): bool => str_contains(end($process->command), 'snapshot-close'));
});

it('rejects mismatched volume references and unsafe source paths before transferring', function (string $field, string $value) {
    $manifest = volumeManifest();
    $manifest['files'][0][$field] = $value;
    fakeVolumeClient($manifest);

    $result = (new UsbCloudClient)->retrieve();

    expect($result['success'])->toBeFalse()->and($result['error'])->toContain('volume');
    Process::assertNotRan(fn (PendingProcess $process): bool => str_contains(end($process->command), 'snapshot-read'));
})->with([
    ['volume_id', 'p999'], ['volume_generation', str_repeat('f', 64)],
    ['source_path', '../outside.mp4'], ['source_path', '/absolute.mp4'],
]);

it('rejects export directory symlinks and never modifies the canonical object', function () {
    $directory = config('usbcloud-client.directory');
    File::ensureDirectoryExists($directory);
    File::ensureDirectoryExists($outside = dirname($directory).'/outside');
    symlink($outside, $directory.'/exports');
    File::put($object = $directory.'/object', 'clip');

    expect(fn () => app(UsbCloudExports::class)->save($directory, $object, volumeManifest()['files'][0]))
        ->toThrow(RuntimeException::class, 'symlink');
    expect(File::allFiles($outside))->toBe([])->and(File::get($object))->toBe('clip');
});

it('can disable readable exports and backfill them later without contacting clients', function () {
    config(['usbcloud.readable_exports' => false]);
    fakeVolumeClient(volumeManifest());
    $client = new UsbCloudClient;
    expect($client->retrieve()['success'])->toBeTrue();
    expect(File::exists($client->directory().'/exports'))->toBeFalse();
    config(['usbcloud.readable_exports' => true]);
    Process::fake();

    $this->artisan('usbcloud:export')->expectsOutput('2 readable files exported.')->assertSuccessful();

    expect(File::glob($client->directory().'/exports/2026/11/11/*/DCIM/clip.mp4'))->toHaveCount(2);
    Process::assertRanTimes(fn (PendingProcess $process): bool => $process->command[0] === 'ssh', 6);
});

it('exports independent copies and preserves user edits when rebuilding exports', function () {
    $directory = config('usbcloud-client.directory');
    File::ensureDirectoryExists($directory);
    File::put($object = $directory.'/object', 'clip');
    $entry = volumeManifest()['files'][0];
    $exports = app(UsbCloudExports::class);
    $path = $exports->save($directory, $object, $entry);
    File::put($path, 'user edit');

    $replacement = $exports->save($directory, $object, $entry);

    expect(File::get($object))->toBe('clip')->and(File::get($path))->toBe('user edit')
        ->and(File::get($replacement))->toBe('clip')->and($replacement)->not->toBe($path);
    expect($exports->save($directory, $object, $entry))->toBe($replacement);
    expect(File::glob(dirname($path).'/.usbcloud-*'))->toBe([]);
});

it('refuses corrupt objects and unsafe export names without publishing files', function () {
    $directory = config('usbcloud-client.directory');
    File::ensureDirectoryExists($directory);
    File::put($object = $directory.'/object', 'corrupt');
    $exports = app(UsbCloudExports::class);
    $entry = volumeManifest()['files'][0];

    expect(fn () => $exports->save($directory, $object, $entry))->toThrow(RuntimeException::class, 'unverified');
    File::put($object, 'clip');
    $entry['source_path'] = '../../outside.mp4';
    expect(fn () => $exports->save($directory, $object, $entry))->toThrow(RuntimeException::class, 'Unsafe');
    expect(File::exists($directory.'/exports'))->toBeFalse();
});

it('keeps scans and transfer progress in app settings without publishing pending clips', function () {
    $archive = dirname(config('usbcloud.directory')).'/archive';
    config(['usbcloud.archive_directory' => $archive, 'usbcloud.include_default_device' => false]);
    $connection = app(UsbCloudDevices::class)->save('GARAGE', ['host' => 'garage.local']);
    fakeVolumeClient(volumeManifest());
    $client = new UsbCloudClient($connection);

    $result = $client->retrieve(copy: false);
    app(UsbCloudTransfers::class)->update('GARAGE', ['state' => 'queued']);

    expect($result['success'])->toBeTrue();
    expect(File::isFile(config('usbcloud.directory').'/devices/GARAGE/inventory.json'))->toBeTrue();
    expect(File::isFile(config('usbcloud.directory').'/devices/GARAGE/'.$result['id'].'/result.json'))->toBeTrue();
    expect(File::isFile(config('usbcloud.directory').'/devices/GARAGE/transfer.json'))->toBeTrue();
    expect(File::isDirectory($archive) ? File::allFiles($archive) : [])->toBe([]);
    Process::assertNotRan(fn (PendingProcess $process): bool => str_contains(end($process->command), 'snapshot-read'));
});

it('stores verified recordings and their source metadata in media clips and downloads from there', function () {
    $archive = dirname(config('usbcloud.directory')).'/archive';
    config(['usbcloud.archive_directory' => $archive, 'usbcloud.include_default_device' => false]);
    $connection = app(UsbCloudDevices::class)->save('GARAGE', ['host' => 'garage.local']);
    fakeVolumeClient(volumeManifest());
    $client = new UsbCloudClient($connection);

    $result = $client->retrieve();

    expect($result['success'])->toBeTrue();
    expect(File::glob($archive.'/devices/GARAGE/exports/2026/11/11/*/DCIM/clip.mp4'))->toHaveCount(2);
    $metadata = File::glob($archive.'/devices/GARAGE/metadata/*.json');
    expect($metadata)->toHaveCount(2);
    expect(json_decode(File::get($metadata[0]), true))->toHaveKeys(['name', 'source_path', 'volume_id', 'volume_generation', 'sha256', 'bytes', 'modified_at']);
    expect(File::isDirectory(config('usbcloud.directory').'/devices/GARAGE/objects'))->toBeFalse();
    $file = app(UsbCloud::class)->allFiles()[0];
    $this->get(route('usbcloud.file', $file['id']))->assertOk()->assertDownload('clip.mp4');
    expect(File::isFile($archive.'/devices/GARAGE/media/'.$file['sha256'].'.json'))->toBeTrue();
    expect($client->retrieve()['already_saved'])->toBe(2);
    $this->artisan('usbcloud:export')->expectsOutput('2 readable files exported.')->assertSuccessful();
    Process::assertRanTimes(fn (PendingProcess $process): bool => str_contains(end($process->command), 'snapshot-read'), 1);
});

it('leaves failed downloads out of media clips', function () {
    $archive = dirname(config('usbcloud.directory')).'/archive';
    config(['usbcloud.archive_directory' => $archive, 'usbcloud.include_default_device' => false]);
    $connection = app(UsbCloudDevices::class)->save('GARAGE', ['host' => 'garage.local']);
    fakeVolumeClient(volumeManifest(), 'bad');
    $client = new UsbCloudClient($connection);

    $result = $client->retrieve();

    expect($result['success'])->toBeFalse();
    expect($result['error'])->toContain('checksum');
    expect(File::allFiles($archive))->toBe([]);
    expect(File::isFile($client->directory().'/'.$result['id'].'/result.json'))->toBeTrue();
    expect(File::exists($client->directory().'/'.$result['id'].'/files'))->toBeFalse();
    Process::assertRan(fn (PendingProcess $process): bool => str_contains(end($process->command), 'snapshot-read'));
});

it('also stores client console recordings in the configured media folder', function () {
    $archive = dirname(config('usbcloud.directory')).'/archive';
    config(['usbcloud.archive_directory' => $archive]);
    fakeVolumeClient(volumeManifest());

    $response = $this->post(route('client.console.retrieve'))->assertOk();
    expect($response->streamedContent())->toContain('"success":true');

    expect(File::glob($archive.'/devices/BLINK-PI/exports/2026/11/11/*/DCIM/clip.mp4'))->toHaveCount(2);
    expect(File::glob(config('usbcloud-client.directory').'/*/result.json'))->toHaveCount(1);
    expect(File::isDirectory(config('usbcloud-client.directory').'/objects'))->toBeFalse();
    Process::assertRanTimes(fn (PendingProcess $process): bool => str_contains(end($process->command), 'snapshot-read'), 1);
});
