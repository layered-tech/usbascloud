<?php

namespace App\Services;

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;

class ClientInstallations
{
    /** @return list<array{id: string, name: string, description: string}> */
    public function profiles(): array
    {
        $catalog = json_decode(File::get(base_path('client/installer_profiles.json')), true, flags: JSON_THROW_ON_ERROR);
        $profiles = [];
        foreach ($catalog as $id => $profile) {
            $profiles[] = ['id' => $id, 'name' => $profile['name'], 'description' => $profile['description']];
        }

        return $profiles;
    }

    /** @param array<string, mixed> $connection
     * @return array{command: string, expires_at: string}
     */
    public function create(array $connection): array
    {
        $storageSize = isset($connection['storage_size_gib']) ? (int) $connection['storage_size_gib'] : null;
        $profile = $connection['installer_profile'] ?? 'pi-zero-2-w';
        unset($connection['storage_size_gib'], $connection['installer_profile']);
        abort_if((int) $connection['port'] !== 22 || strtolower($connection['user']) === 'root', 422, 'Automatic installation requires SSH port 22 and a non-root Pi username.');
        $this->publicKey();
        $this->assertAvailable($connection);
        $token = Str::random(64);
        $expires = now()->addDay();
        Cache::put($this->cacheKey($token), [
            'connection' => $connection, 'id' => 'USB-'.strtoupper(Str::random(12)),
            'expires_at' => $expires->timestamp, 'host_key' => null,
            'storage_size_gib' => $storageSize,
            'installer_profile' => $profile,
        ], $expires);
        $base = rtrim(config('usbcloud.heartbeat_url') ?: config('app.url'), '/');
        $asset = $base.route('client.installation.asset', 'install.sh', false);
        $script = 'set -eu; work=$(mktemp -d); trap \'rm -rf "$work"\' EXIT; curl --fail --silent --show-error --max-time 60 '.escapeshellarg($asset).' -o "$work/install.sh"; sudo bash "$work/install.sh" '.escapeshellarg($base).' '.escapeshellarg($token);
        if ($storageSize !== null) {
            $script .= ' --size-gib '.$storageSize;
        }
        $script .= ' --profile '.escapeshellarg($profile);

        return ['command' => 'bash -c '.escapeshellarg($script), 'expires_at' => $expires->toIso8601String()];
    }

    /** @return array<string, mixed> */
    public function configuration(string $token): array
    {
        $installation = $this->find($token);

        return [...$installation['connection'], 'storage_size_gib' => $installation['storage_size_gib'] ?? null, 'installer_profile' => $installation['installer_profile'] ?? 'pi-zero-2-w', 'public_key' => $this->publicKey()];
    }

    /** @return array{device: string, url: string, token: string} */
    public function enroll(string $token, string $hostKey): array
    {
        $key = $this->normalizeHostKey($hostKey);

        return Cache::lock('usbcloud.installation.enroll', 30)->block(5, function () use ($token, $key): array {
            $installation = $this->find($token);
            $id = $installation['id'];
            $devices = app(UsbCloudDevices::class);
            $existing = $devices->all(true)[$id] ?? null;
            $heartbeatToken = hash_hmac('sha256', 'usbcloud-heartbeat', $token);
            abort_if($installation['host_key'] !== null && $installation['host_key'] !== $key, 409, 'This setup command has already been used by another device.');
            abort_if($existing && ($existing['removed'] || ! hash_equals($existing['heartbeat_token_hash'] ?? '', hash('sha256', $heartbeatToken))), 409, 'This installation has been revoked. Generate a new setup command.');
            $this->assertAvailable($installation['connection'], $id);
            $directory = config('usbcloud.directory').'/known-hosts';
            File::ensureDirectoryExists($directory, 0700);
            $path = $directory.'/'.$id;
            File::replace($path, $id.' '.$key."\n", 0600);
            $installation['host_key'] = $key;
            Cache::put($this->cacheKey($token), $installation, max(1, $installation['expires_at'] - now()->timestamp));
            if (! $existing) {
                $devices->save($id, [...$installation['connection'],
                    'name' => $installation['connection']['name'] ?: $id,
                    'host_key_alias' => $id, 'known_hosts_file' => $path,
                    'transfer_protocol' => 'stream',
                    'heartbeat_token_hash' => hash('sha256', $heartbeatToken), 'removed' => false,
                ]);
            }

            return ['device' => $id, 'url' => rtrim(config('usbcloud.heartbeat_url') ?: config('app.url'), '/').route('devices.heartbeat', $id, false), 'token' => $heartbeatToken];
        });
    }

    /** @return array<string, mixed> */
    private function find(string $token): array
    {
        abort_unless(preg_match('/\A[a-zA-Z0-9]{64}\z/', $token) === 1, 401, 'Invalid setup token.');
        $installation = Cache::get($this->cacheKey($token));
        abort_unless(is_array($installation) && $installation['expires_at'] > now()->timestamp, 401, 'Setup command expired. Generate a new command in Add device.');

        return $installation;
    }

    private function cacheKey(string $token): string
    {
        return 'usbcloud.installation.'.hash('sha256', $token);
    }

    private function publicKey(): string
    {
        $identity = config('usbcloud-client.identity');
        $path = str_ends_with($identity, '.pub') ? $identity : $identity.'.pub';
        abort_unless(File::isFile($path), 422, 'The server SSH public key is missing. Configure the server SSH identity first.');

        return trim(File::get($path));
    }

    private function normalizeHostKey(string $key): string
    {
        abort_unless(preg_match('/\Assh-ed25519 ([A-Za-z0-9+\/=]+)(?: [^\r\n]*)?\z/', trim($key), $matches) === 1, 422, 'An Ed25519 SSH host public key is required.');
        $decoded = base64_decode($matches[1], true);
        abort_unless(is_string($decoded) && strlen($decoded) === 51 && substr($decoded, 0, 19) === pack('N', 11).'ssh-ed25519'.pack('N', 32), 422, 'Invalid SSH host public key.');

        return 'ssh-ed25519 '.$matches[1];
    }

    /** @param array<string, mixed> $connection */
    private function assertAvailable(array $connection, ?string $except = null): void
    {
        foreach (app(UsbCloudDevices::class)->all() as $id => $device) {
            abort_if($id !== $except && strcasecmp($device['host'], $connection['host']) === 0 && (int) $device['port'] === (int) $connection['port'], 409, 'This address is already registered. Remove the old device before reinstalling.');
        }
    }
}
