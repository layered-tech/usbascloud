<?php

namespace App\Services;

use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\File;
use RuntimeException;
use Throwable;

class UsbCloudExports
{
    /** @param array<string, mixed> $entry */
    public function save(string $directory, string $object, array $entry): ?string
    {
        if (! config('usbcloud.readable_exports')) {
            return null;
        }
        $digest = $entry['sha256'] ?? '';
        if (! is_string($digest) || ! preg_match('/\A[a-f0-9]{64}\z/', $digest) || ! $this->matches($object, $digest)) {
            throw new RuntimeException('Cannot export an unverified archive object.');
        }
        $source = $entry['source_path'] ?? $entry['name'];
        $parts = explode('/', $source);
        foreach ($parts as $part) {
            if (in_array($part, ['', '.', '..'], true) || preg_match('/[\x00-\x1f\x7f\\\\]/', $part)) {
                throw new RuntimeException('Unsafe readable export path.');
            }
        }
        $date = 'undated';
        try {
            if (is_string($entry['modified_at'] ?? null) && preg_match('/\A\d{4}-\d{2}-\d{2}T/', $entry['modified_at'])) {
                $date = CarbonImmutable::parse($entry['modified_at'])->format('Y/m/d');
            }
        } catch (Throwable) {
            // Filesystems can contain timestamps outside the date parser's range.
        }
        $volume = isset($entry['volume_id'], $entry['volume_generation'])
            ? $entry['volume_id'].'-'.$entry['volume_generation'] : 'legacy';
        $segments = ['exports', ...explode('/', $date), $volume, ...array_map($this->component(...), $parts)];
        $filename = array_pop($segments);
        $parent = rtrim($directory, '/');
        foreach ($segments as $segment) {
            $parent .= '/'.$this->component($segment);
            if (is_link($parent)) {
                throw new RuntimeException('Readable export directory cannot be a symlink.');
            }
            File::ensureDirectoryExists($parent);
        }
        $destination = $parent.'/'.$filename;
        if (file_exists($destination) || is_link($destination)) {
            if ($this->matches($destination, $digest)) {
                return $destination;
            }
            $destination = $parent.'/'.$digest.'--'.$filename;
            if (file_exists($destination) || is_link($destination)) {
                if ($this->matches($destination, $digest)) {
                    return $destination;
                }
                throw new RuntimeException('Readable export collision; existing file preserved.');
            }
        }
        $temporary = tempnam($parent, '.usbcloud-');
        if ($temporary === false) {
            throw new RuntimeException('Cannot create readable export.');
        }
        try {
            if (! File::copy($object, $temporary) || ! $this->matches($temporary, $digest)) {
                throw new RuntimeException('Readable export failed checksum verification.');
            }
            chmod($temporary, 0644);
            /** Publish the independent copy atomically without replacing a concurrent writer's file. */
            if (! @link($temporary, $destination)) {
                throw new RuntimeException('Cannot publish readable export without replacing an existing file; check filesystem hardlink support and permissions.');
            }
        } finally {
            File::delete($temporary);
        }

        return $destination;
    }

    private function matches(string $path, string $digest): bool
    {
        return ! is_link($path) && is_file($path) && hash_file('sha256', $path) === $digest;
    }

    private function component(string $name): string
    {
        $safe = rtrim(preg_replace('/[<>:"|?*\/\x00-\x1f\x7f\\\\]/u', '_', $name) ?? '', '. ');
        $safe = mb_strcut($safe, 0, 120, 'UTF-8');

        return ($safe === '' ? 'file' : $safe).($safe !== $name ? '~'.substr(hash('sha256', $name), 0, 12) : '');
    }
}
