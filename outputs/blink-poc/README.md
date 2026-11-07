# Pi hardware client proof of concept

The Pi owns USB mass-storage emulation, durable local storage, snapshot lifecycle,
and storage health. A separate LAN service owns polling, copying, media validation,
transfer history, cloud credentials/uploads, monitoring, and user-facing controls.

The initial backing storage is a dedicated 20 GiB file on the Pi SD card. An LVM
volume exposes 8 GiB of exFAT to the USB host. A 9 GiB copy-on-write snapshot can
hold changes to the entire origin, with additional headroom for snapshot metadata.
The live filesystem must never be mounted or edited by Linux while exported.

## LAN interface

Use SSH with the existing key and invoke the root-owned `blink-poc` command:

```sh
sudo blink-poc status
sudo blink-poc snapshot-open
sudo blink-poc snapshot-manifest --token TOKEN_FROM_OPEN
sudo blink-poc snapshot-close --token TOKEN_FROM_OPEN
```

`snapshot-open` returns JSON containing an opaque token, expiry time (Unix seconds),
and `/srv/blink-poc/snapshot`. `snapshot-manifest` hashes the read-only files on the Pi
and returns their relative paths, byte counts, and SHA-256 checksums. The LAN service
compares these hashes with its saved objects and transfers only missing content
through SFTP. It verifies each download against the Pi checksum, then closes the snapshot in a `finally` block. Concurrent opens are rejected.
A timer checks every 30 seconds and closes expired snapshots after a ten-minute
lease. Reads in progress may cause unmount to fail; failure remains visible and
the timer retries. Tokens prevent a stale caller from closing a newer snapshot.

Opening or closing a snapshot does not unbind the USB gadget. LVM can briefly
pause block I/O to establish a snapshot; host tolerance still requires testing.
Snapshots are block-consistent views of received writes, not host-flushed or
application-consistent files. Incomplete filesystem metadata can prevent a
snapshot from mounting; the client reports the error and cleans up the snapshot.

The LAN service must compare files across distinct snapshots, validate completed
media, retry partial files, and verify its copies. A matching size, timestamp, or
hash alone cannot prove the host will never modify a file again. No clip policy,
media-specific filtering, cloud account, or upload state lives on the Pi.

## First hardware test

Keep the Pi powered through PWR IN and manage it over Wi-Fi. Connect its USB data
port to Blink only after the disk is initialized and attached. Verify Blink sees
the disk, record a clip, and request snapshots while the disk stays connected.
Actual Blink recognition, recording, and tolerance of snapshots remain unverified
until performed on the real module.

Uploads do not reclaim space on the live disk. Retention requires host-owned
deletion or a separate coordinated maintenance flow; the LAN service must never
delete files through the mounted snapshot or silently edit the live filesystem.
