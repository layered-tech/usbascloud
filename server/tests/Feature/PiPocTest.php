<?php

use Illuminate\Process\PendingProcess;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Str;
use Inertia\Testing\AssertableInertia as Assert;

beforeEach(function () {
    config(['pi-poc.transfer_protocol' => 'sftp']);
    config(['pi-poc.directory' => storage_path('framework/testing/pi-poc-'.Str::uuid())]);
});

afterEach(function () {
    File::deleteDirectory(config('pi-poc.directory'));
});

it('shows the dedicated page to guests even when the Pi is offline', function () {
    Process::fake(['*' => Process::result(errorOutput: 'Connection timed out', exitCode: 255)]);
    $this->get(route('poc.pi'))->assertOk()->assertInertia(fn (Assert $page) => $page
        ->component('poc/pi')->where('status.online', false)->where('status.error', 'Connection timed out')->has('runs', 0));
    Process::assertRan(fn (PendingProcess $process) => end($process->command) === 'sudo -n blink-poc status');
});

it('retrieves files for guests and closes the snapshot after copying', function () {
    Process::fake(function (PendingProcess $process) {
        $command = $process->command;
        if ($command[0] === 'scp') {
            $destination = end($command);
            File::put($destination, 'sample recording');

            return Process::result();
        }

        if (str_contains(end($command), 'snapshot-manifest')) {
            return Process::result(output: json_encode(['files' => [['name' => 'clip.mp4', 'bytes' => strlen('sample recording'), 'sha256' => hash('sha256', 'sample recording')]]]));
        }

        return Process::result(output: str_contains(end($command), 'snapshot-open')
            ? json_encode(['token' => str_repeat('a', 32), 'path' => '/srv/blink-poc/snapshot'])
            : '{"gadget_loaded":true,"usb_state":{"usb":"configured"},"snapshot":null}');
    });
    $response = $this->post(route('poc.pi.retrieve'))->assertOk()->assertHeader('content-type', 'application/x-ndjson');
    expect($response->streamedContent())->toContain('Starting snapshot retrieval', 'snapshot-open', 'snapshot-close', '"type":"result"');
    $result = json_decode(File::get(File::glob(config('pi-poc.directory').'/*/result.json')[0]), true);
    expect($result['success'])->toBeTrue()
        ->and($result['files'][0]['sha256'])->toBe(hash('sha256', 'sample recording'));
    Process::assertRan(fn (PendingProcess $process) => end($process->command) === 'sudo -n blink-poc snapshot-close --token '.str_repeat('a', 32));
    $this->get(route('poc.pi.file', ['run' => $result['id'], 'file' => 0]))->assertOk()->assertHeader('cache-control', 'no-store, private');
});

it('records a copy failure and still releases the snapshot', function () {
    Process::fake(function (PendingProcess $process) {
        if ($process->command[0] === 'scp') {
            return Process::result(errorOutput: 'Transfer interrupted', exitCode: 1);
        }

        if (str_contains(end($process->command), 'snapshot-manifest')) {
            return Process::result(output: json_encode(['files' => [['name' => 'clip.mp4', 'bytes' => strlen('interrupted content'), 'sha256' => hash('sha256', 'interrupted content')]]]));
        }

        return Process::result(output: str_contains(end($process->command), 'snapshot-open')
            ? json_encode(['token' => str_repeat('b', 32), 'path' => '/srv/blink-poc/snapshot']) : '{}');
    });
    $response = $this->post(route('poc.pi.retrieve'))->assertOk()->assertHeader('content-type', 'application/x-ndjson');
    expect($response->streamedContent())->toContain('Starting snapshot retrieval', 'snapshot-open', 'snapshot-close', '"type":"result"');
    $result = json_decode(File::get(File::glob(config('pi-poc.directory').'/*/result.json')[0]), true);
    expect($result['success'])->toBeFalse()->and($result['error'])->toBe('Transfer interrupted');
    Process::assertRan(fn (PendingProcess $process) => end($process->command) === 'sudo -n blink-poc snapshot-close --token '.str_repeat('b', 32));
});

it('rejects overlapping retrievals without contacting the Pi', function () {
    Process::fake();
    $lock = Cache::lock('pi-poc-retrieval', 300);
    $lock->get();
    try {
        $this->postJson(route('poc.pi.retrieve'))->assertStatus(423)->assertJsonPath('message', 'A retrieval is already running. Wait for it to finish, then refresh.');
        Process::assertNothingRan();
    } finally {
        $lock->release();
    }
});

it('does not serve a file outside its retrieval directory', function () {
    $run = (string) Str::ulid();
    $directory = config('pi-poc.directory').'/'.$run;
    File::ensureDirectoryExists($directory.'/files');
    File::put($directory.'/secret.txt', 'not a retrieved file');
    File::put($directory.'/result.json', json_encode(['files' => [['name' => '../secret.txt']]]));
    $this->get(route('poc.pi.file', ['run' => $run, 'file' => 0]))->assertNotFound();
});

it('streams refresh commands and returns status without opening a snapshot', function () {
    Process::fake(['*' => Process::result(output: '{"gadget_loaded":true,"usb_state":{"usb":"configured"},"snapshot":null}')]);
    $response = $this->post(route('poc.pi.refresh'))->assertOk()->assertHeader('content-type', 'application/x-ndjson');
    $events = collect(explode("\n", trim($response->streamedContent())))->map(fn (string $line) => json_decode($line, true));
    expect($events->where('type', 'output')->pluck('data')->implode(''))->toContain('Refreshing Pi status', 'sudo -n blink-poc status');
    expect($events->last()['data']['online'])->toBeTrue();
    Process::assertRanTimes(fn (PendingProcess $process) => end($process->command) === 'sudo -n blink-poc status', 1);
    Process::assertNotRan(fn (PendingProcess $process) => str_contains(end($process->command), 'snapshot-open'));
});

it('streams an offline refresh result so the page can show a retryable error', function () {
    Process::fake(['*' => Process::result(errorOutput: 'Connection timed out', exitCode: 255)]);
    $response = $this->post(route('poc.pi.refresh'))->assertOk();
    $events = collect(explode("\n", trim($response->streamedContent())))->map(fn (string $line) => json_decode($line, true));
    expect($events->last()['type'])->toBe('status')
        ->and($events->last()['data']['online'])->toBeFalse()
        ->and($events->last()['data']['error'])->toBe('Connection timed out');
    Process::assertRanTimes(fn (PendingProcess $process) => end($process->command) === 'sudo -n blink-poc status', 1);
});

it('keeps one copy per checksum and retains changed content on later retrievals', function () {
    $content = 'original recording';
    Process::fake(function (PendingProcess $process) use (&$content) {
        if ($process->command[0] === 'scp') {
            File::put(end($process->command), $content);

            return Process::result();
        }

        if (str_contains(end($process->command), 'snapshot-manifest')) {
            return Process::result(output: json_encode(['files' => [['name' => 'clip.mp4', 'bytes' => strlen($content), 'sha256' => hash('sha256', $content)]]]));
        }

        return Process::result(output: str_contains(end($process->command), 'snapshot-open')
            ? json_encode(['token' => str_repeat('c', 32), 'path' => '/srv/blink-poc/snapshot']) : '{}');
    });
    $first = $this->post(route('poc.pi.retrieve'))->assertOk();
    $first->streamedContent();
    $duplicate = $this->post(route('poc.pi.retrieve'))->assertOk();
    $duplicateEvents = collect(explode("\n", trim($duplicate->streamedContent())))->map(fn (string $line) => json_decode($line, true));
    $duplicateRun = $duplicateEvents->last()['data'];
    expect($duplicateRun['files'])->toBe([])->and($duplicateRun['already_saved'])->toBe(1);
    expect(File::files(config('pi-poc.directory').'/objects'))->toHaveCount(1);
    Process::assertRanTimes(fn (PendingProcess $process) => $process->command[0] === 'scp', 1);
    $content = 'changed recording';
    $changed = $this->post(route('poc.pi.retrieve'))->assertOk();
    $changedEvents = collect(explode("\n", trim($changed->streamedContent())))->map(fn (string $line) => json_decode($line, true));
    expect($changedEvents->last()['data']['files'])->toHaveCount(1)
        ->and(File::files(config('pi-poc.directory').'/objects'))->toHaveCount(2)
        ->and(File::glob(config('pi-poc.directory').'/*/files/*'))->toBe([]);
    Process::assertRanTimes(fn (PendingProcess $process) => str_contains(end($process->command), 'snapshot-close'), 3);
});

it('consolidates older retrieval copies while keeping their download links working', function () {
    $run = (string) Str::ulid();
    $directory = config('pi-poc.directory').'/'.$run;
    File::ensureDirectoryExists($directory.'/files');
    File::put($directory.'/files/old.mp4', 'existing recording');
    File::put($directory.'/result.json', json_encode(['files' => [['id' => 0, 'name' => 'old.mp4', 'sha256' => hash('sha256', 'existing recording')]]]));
    Process::fake(function (PendingProcess $process) {
        if ($process->command[0] === 'scp') {
            File::put(end($process->command), 'existing recording');

            return Process::result();
        }

        if (str_contains(end($process->command), 'snapshot-manifest')) {
            return Process::result(output: json_encode(['files' => [['name' => 'renamed.mp4', 'bytes' => strlen('existing recording'), 'sha256' => hash('sha256', 'existing recording')]]]));
        }

        return Process::result(output: str_contains(end($process->command), 'snapshot-open')
            ? json_encode(['token' => str_repeat('d', 32), 'path' => '/srv/blink-poc/snapshot']) : '{}');
    });
    $response = $this->post(route('poc.pi.retrieve'))->assertOk();
    $response->streamedContent();
    expect(File::files(config('pi-poc.directory').'/objects'))->toHaveCount(1)
        ->and(File::exists($directory.'/files/old.mp4'))->toBeFalse();
    $this->get(route('poc.pi.file', ['run' => $run, 'file' => 0]))->assertOk();
    Process::assertNotRan(fn (PendingProcess $process) => $process->command[0] === 'scp');
    Process::assertRan(fn (PendingProcess $process) => str_contains(end($process->command), 'snapshot-close'));
});

it('rejects unsafe manifest paths before transferring files', function () {
    Process::fake(function (PendingProcess $process) {
        $command = end($process->command);
        if (str_contains($command, 'snapshot-manifest')) {
            return Process::result(output: json_encode(['files' => [['name' => '../escape.mp4', 'bytes' => 4, 'sha256' => hash('sha256', 'clip')]]]));
        }

        return Process::result(output: str_contains($command, 'snapshot-open')
            ? json_encode(['token' => str_repeat('e', 32), 'path' => '/srv/blink-poc/snapshot']) : '{}');
    });
    $response = $this->post(route('poc.pi.retrieve'))->assertOk();
    expect($response->streamedContent())->toContain('unsafe or invalid manifest entry');
    Process::assertNotRan(fn (PendingProcess $process) => $process->command[0] === 'scp');
    Process::assertRan(fn (PendingProcess $process) => str_contains(end($process->command), 'snapshot-close'));
});

it('does not retain a download whose content differs from the Pi checksum', function () {
    Process::fake(function (PendingProcess $process) {
        if ($process->command[0] === 'scp') {
            File::put(end($process->command), 'bad!');

            return Process::result();
        }
        $command = end($process->command);
        if (str_contains($command, 'snapshot-manifest')) {
            return Process::result(output: json_encode(['files' => [['name' => 'clip.mp4', 'bytes' => 4, 'sha256' => hash('sha256', 'clip')]]]));
        }

        return Process::result(output: str_contains($command, 'snapshot-open')
            ? json_encode(['token' => str_repeat('f', 32), 'path' => '/srv/blink-poc/snapshot']) : '{}');
    });
    $response = $this->post(route('poc.pi.retrieve'))->assertOk();
    expect($response->streamedContent())->toContain('does not match the Pi checksum');
    expect(File::files(config('pi-poc.directory').'/objects'))->toHaveCount(0)
        ->and(File::glob(config('pi-poc.directory').'/*/files/*'))->toBe([]);
    Process::assertRan(fn (PendingProcess $process) => str_contains(end($process->command), 'snapshot-close'));
});
