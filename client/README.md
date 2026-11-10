# USBCloud Client

The Pi owns USB mass-storage emulation, durable local storage, snapshot lifecycle,
and storage health. The client sends authenticated health heartbeats to its registered backend.
A separate LAN service owns copying, media validation,
transfer history, cloud credentials/uploads, monitoring, and user-facing controls.

The initial backing storage is a dedicated 20 GiB file on the Pi SD card. An LVM
volume exposes 8 GiB of exFAT to the USB host. A 9 GiB copy-on-write snapshot can
hold changes to the entire origin, with additional headroom for snapshot metadata.
The live filesystem must never be mounted or edited by Linux while exported.

## LAN interface

Use SSH with the existing key and invoke the root-owned `usbcloud-client` command:

```sh
sudo usbcloud-client status
sudo usbcloud-client snapshot-open
sudo usbcloud-client snapshot-manifest --token TOKEN_FROM_OPEN
sudo usbcloud-client snapshot-close --token TOKEN_FROM_OPEN
```

`snapshot-open` returns JSON containing an opaque token, expiry time (Unix seconds),
and `/srv/usbcloud-client/snapshot`. `snapshot-manifest` hashes the read-only files on the Pi
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

## Health heartbeats (client 0.4.0)

Adding a device provisions a separate per-device bearer token over the existing
SSH connection. The backend stores its SHA-256 hash; the Pi keeps its token in
root-only `/var/lib/usbcloud-client/heartbeat.json`. The `usbcloud-heartbeat` systemd
service posts to `/api/v1/devices/{device}/heartbeat` every 30 seconds, independently
of USB storage and transfers. No report for 90 seconds marks the device offline;
last-known metrics remain visible. Removing a device revokes its token.

Reports include CPU temperature, one-minute load, core count, memory usage,
system-disk usage/free bytes, Pi power/throttling flags, uptime, firmware and USB
state. Missing sensors report null. Warnings appear at 80°C CPU, 90% memory/disk
usage, or active power/thermal flags. Historical throttling bits are displayed
without triggering a current warning.

For an existing device, install the updated `usbcloud_client.py` at
`/usr/local/sbin/usbcloud-client`, then run from the repository root:

```sh
php artisan usbcloud:pair-heartbeat BLINK-PI
```

This command also rotates an existing token. Configuration checks an authenticated
heartbeat before enabling the service. The backend URL defaults to `APP_URL`;
set `USBCLOUD_HEARTBEAT_URL` to a client-reachable base URL if different. HTTPS
uses normal certificate verification and rejects redirects. A local Valet
`.test` site bound to loopback requires a reachable listener, DNS and certificate
trust before pairing. Existing unpaired clients retain SSH status checks until
successfully provisioned. Logs and file operations still use SSH.
