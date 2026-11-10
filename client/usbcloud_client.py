#!/usr/bin/env python3
"""Hardware client: USB storage and temporary read-only snapshot access over SFTP."""
import argparse
import base64
import shlex
import sys
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import secrets
import socket
import urllib.request
import urllib.parse
from datetime import datetime, timezone

BASE = Path('/var/lib/blink-poc') if Path('/var/lib/blink-poc').exists() else Path('/var/lib/usbcloud-client')
POOL = BASE / 'pool.img'
VG = 'blink_poc' if Path('/dev/blink_poc/drive').exists() else 'usbcloud_client'
ORIGIN = f'/dev/{VG}/drive'
SNAP = f'/dev/{VG}/capture'
EXPORT = Path('/srv/blink-poc/snapshot') if Path('/srv/blink-poc').exists() else Path('/srv/usbcloud-client/snapshot')
LEASE = BASE / 'snapshot.json'
VERSION = '0.4.0'


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def event(message, level='info'):
    path = BASE / 'events.jsonl'
    if path.exists() and path.stat().st_size > 512 * 1024:
        path.replace(BASE / 'events.previous.jsonl')
    with path.open('a') as stream:
        stream.write(json.dumps({'at': timestamp(), 'level': level, 'message': message}) + '\n')


def read_json(path):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return None


def write_json(path, value):
    temporary = path.with_name(path.name + '.new')
    temporary.write_text(json.dumps(value))
    temporary.replace(path)


def device_logs():
    path = BASE / 'events.jsonl'
    try:
        lines = path.read_text().splitlines()[-200:]
    except FileNotFoundError:
        return []
    entries = []
    for line in lines:
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            # A writer can still be appending the final line.
            continue
    return entries


def device_status():
    return {'storage': json.loads(output('lvs', '--reportformat', 'json', '-o', 'lv_name,lv_size,origin,data_percent', VG)),
            'version': VERSION, 'hostname': socket.gethostname(),
            'model': Path('/proc/device-tree/model').read_text().rstrip('\x00') if Path('/proc/device-tree/model').exists() else None,
            'uptime_seconds': int(float(Path('/proc/uptime').read_text().split()[0])),
            'inventory': read_json(BASE / 'inventory.json'),
            'gadget_loaded': Path('/sys/module/g_mass_storage').exists(),
            'usb_state': {p.name: (p / 'state').read_text().strip() for p in Path('/sys/class/udc').iterdir()},
            'snapshot': read_json(LEASE)}


def health_metrics():
    metrics = {'cpu_count': os.cpu_count(), 'load_1m': os.getloadavg()[0]}
    try:
        metrics['cpu_temperature_c'] = int(Path('/sys/class/thermal/thermal_zone0/temp').read_text()) / 1000
    except (OSError, ValueError):
        metrics['cpu_temperature_c'] = None
    try:
        memory = {line.split(':')[0]: int(line.split()[1]) for line in Path('/proc/meminfo').read_text().splitlines()}
        metrics['memory_used_percent'] = round(100 * (1 - memory['MemAvailable'] / memory['MemTotal']), 1)
    except (OSError, ValueError, KeyError, ZeroDivisionError):
        metrics['memory_used_percent'] = None
    disk = shutil.disk_usage('/')
    metrics.update(root_free_bytes=disk.free, root_used_percent=round(100 * disk.used / disk.total, 1))
    try:
        result = subprocess.run(['vcgencmd', 'get_throttled'], capture_output=True, text=True, check=True, timeout=3)
        metrics['throttled_flags'] = int(result.stdout.strip().split('=')[1], 16)
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        metrics['throttled_flags'] = None
    return metrics


def heartbeat_payload():
    # Avoid LVM/snapshot operations: reporting must remain independent of transfers.
    return {
        'version': VERSION, 'hostname': socket.gethostname(),
        'model': Path('/proc/device-tree/model').read_text().rstrip('\x00') if Path('/proc/device-tree/model').exists() else None,
        'uptime_seconds': int(float(Path('/proc/uptime').read_text().split()[0])),
        'gadget_loaded': Path('/sys/module/g_mass_storage').exists(),
        'usb_state': {p.name: (p / 'state').read_text().strip() for p in Path('/sys/class/udc').glob('*')},
        'metrics': health_metrics(),
    }


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def send_heartbeat(configuration):
    request = urllib.request.Request(configuration['url'],
        data=json.dumps(heartbeat_payload()).encode(),
        headers={'Authorization': 'Bearer ' + configuration['token'],
                 'Content-Type': 'application/json', 'Accept': 'application/json'}, method='POST')
    # Never forward credentials to a redirect destination; keep TLS verification enabled.
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=10) as response:
        response.read(4096)


def configure_heartbeat():
    configuration = json.load(sys.stdin)
    parsed = urllib.parse.urlparse(configuration.get('url', ''))
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise ValueError('A backend HTTP(S) URL is required')
    token = configuration.get('token', '')
    if not isinstance(token, str) or len(token) != 64 or not token.isalnum():
        raise ValueError('Invalid heartbeat token')
    # Confirm routing, certificate trust and token acceptance before enabling the service.
    send_heartbeat(configuration)
    path = BASE / 'heartbeat.json'
    # The directory is root-only; the token is never a command-line argument or log entry.
    write_json(path, {'url': configuration['url'], 'token': token})
    path.chmod(0o600)
    Path('/etc/systemd/system/usbcloud-heartbeat.service').write_text("""[Unit]
Description=USBCloud device health heartbeat
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
ExecStart=/usr/local/sbin/usbcloud-client heartbeat
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
""")
    run('systemctl', 'daemon-reload')
    run('systemctl', 'enable', 'usbcloud-heartbeat.service')
    run('systemctl', 'restart', 'usbcloud-heartbeat.service')


def heartbeat_loop():
    while True:
        try:
            configuration = read_json(BASE / 'heartbeat.json')
            if configuration:
                send_heartbeat(configuration)
        except Exception:
            # Do not log request objects or credentials, and never block USB operations.
            print('Heartbeat failed; retrying in 30 seconds.', file=sys.stderr, flush=True)
        time.sleep(30)


def run(*args, **kwargs):
    if 'stdout' not in kwargs:
        kwargs['stdout'] = subprocess.PIPE
    return subprocess.run(args, check=True, text=True, **kwargs)


def output(*args):
    return run(*args, stdout=subprocess.PIPE).stdout.strip()


def attach_pool():
    if not POOL.exists():
        raise RuntimeError('Run init first')
    devices = output('losetup', '-j', str(POOL))
    loop = devices.split(':', 1)[0] if devices else output('losetup', '--find', '--show', str(POOL))
    run('pvscan', '--cache', loop)
    run('vgchange', '-ay', VG)
    return loop


def initialize():
    # Refuse to format anything that already exists; never use the SD partition.
    if POOL.exists() or subprocess.run(['vgs', VG], capture_output=True).returncode == 0:
        raise RuntimeError('Existing storage detected; refusing to initialize again')
    if shutil.disk_usage(BASE).free < 24 * 1024**3:
        raise RuntimeError('Need at least 24 GiB free')
    run('fallocate', '-l', '20G', str(POOL))
    os.chmod(POOL, 0o600)
    loop = output('losetup', '--find', '--show', str(POOL))
    run('pvcreate', loop)
    run('vgcreate', VG, loop)
    run('lvcreate', '-L', '8G', '-n', 'drive', VG)
    run('mkfs.exfat', '-L', 'USBCLOUD', ORIGIN)
    print('Created an 8 GiB exFAT disk inside the dedicated pool file.')


def start():
    attach_pool()
    if Path('/sys/module/g_mass_storage').exists():
        lun = Path('/sys/module/g_mass_storage/parameters/file')
        if lun.exists() and os.path.realpath(lun.read_text().strip().split(',')[0]) == os.path.realpath(ORIGIN):
            return
        raise RuntimeError('A mass-storage gadget is already loaded; refusing to replace it')
    # Switching modes is performed once during setup, not during snapshot scans.
    if Path('/sys/module/g_ether').exists():
        run('modprobe', '-r', 'g_ether')
    run('modprobe', 'g_mass_storage', f'file={ORIGIN}', 'removable=1', 'ro=0', 'stall=0', 'nofua=0')
    event('USB disk attached.', 'ok')
    print('USB disk attached. Do not mount the live origin locally.')


def detach():
    release(expired_only=True)
    if LEASE.exists() or Path(SNAP).exists():
        raise RuntimeError('A snapshot is active. Wait for the current scan or pull to finish.')
    if Path('/sys/module/g_mass_storage').exists():
        run('modprobe', '-r', 'g_mass_storage')
        event('USB disk detached by the server.', 'warn')
    print(json.dumps({'gadget_loaded': False}))


def release(token=None, expired_only=False):
    lease = json.loads(LEASE.read_text()) if LEASE.exists() else None
    if expired_only and (lease is None or lease['expires_at'] > time.time()):
        return
    if token is not None and (lease is None or lease['token'] != token):
        raise RuntimeError('Snapshot token does not match; refusing to close it')
    if os.path.ismount(EXPORT):
        run('umount', str(EXPORT))
    if lease and lease.get('loop'):
        run('losetup', '-d', lease['loop'])
    if Path(SNAP).exists():
        run('lvremove', '-y', f'{VG}/capture')
    LEASE.unlink(missing_ok=True)


def open_snapshot(timeout=600):
    if not 60 <= timeout <= 3600:
        raise ValueError('Snapshot timeout must be between 60 and 3600 seconds')
    attach_pool()
    release(expired_only=True)
    if Path(SNAP).exists() or LEASE.exists():
        raise RuntimeError('Snapshot already open; close it or wait for expiry')
    EXPORT.mkdir(parents=True, exist_ok=True, mode=0o755)
    run('lvcreate', '--snapshot', '-L', '9G', '-n', 'capture', ORIGIN)
    lease = {'token': secrets.token_hex(16), 'expires_at': time.time() + timeout,
             'path': str(EXPORT), 'loop': None}
    # Persist cleanup state before any optional partition mapping or mount.
    write_json(LEASE, lease)
    try:
        device = SNAP
        kind = subprocess.run(['blkid', '-p', '-s', 'TYPE', '-o', 'value', SNAP], capture_output=True, text=True).stdout.strip()
        if kind not in ('exfat', 'vfat'):
            table = json.loads(output('sfdisk', '--json', SNAP))['partitiontable']
            part = table['partitions'][0]
            sector = table.get('sectorsize', 512)
            lease['loop'] = output('losetup', '--find', '--show', '--read-only', '--offset', str(part['start'] * sector), '--sizelimit', str(part['size'] * sector), SNAP)
            write_json(LEASE, lease)
            device = lease['loop']
            kind = output('blkid', '-p', '-s', 'TYPE', '-o', 'value', device)
        if kind not in ('exfat', 'vfat'):
            raise RuntimeError('Unsupported filesystem in snapshot: ' + kind)
        run('mount', '-t', kind, '-o', 'ro,nosuid,nodev,noexec,fmask=0133,dmask=0022', device, str(EXPORT))
        lease['filesystem'] = kind
        write_json(LEASE, lease)
        event('Read-only snapshot opened.')
        print(json.dumps(lease))
    except BaseException:
        release()
        raise


def snapshot_manifest(token):
    lease = json.loads(LEASE.read_text()) if LEASE.exists() else None
    if not lease or not token or not secrets.compare_digest(lease['token'], token):
        raise RuntimeError('Snapshot token does not match')
    if lease['expires_at'] <= time.time() or not os.path.ismount(EXPORT):
        raise RuntimeError('Snapshot is expired or not mounted')
    files = []
    for path in sorted(EXPORT.rglob('*')):
        if path.is_symlink() or not path.is_file():
            continue
        digest = hashlib.sha256()
        with path.open('rb') as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                digest.update(chunk)
        stat = path.stat()
        files.append({'name': path.relative_to(EXPORT).as_posix(),
                      'bytes': stat.st_size, 'sha256': digest.hexdigest(),
                      'modified_at': datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat()})
    disk = os.statvfs(EXPORT)
    inventory = {'scanned_at': timestamp(), 'files': files,
                 'filesystem': {'type': lease.get('filesystem'), 'mount': str(EXPORT),
                                'total_bytes': disk.f_blocks * disk.f_frsize,
                                'free_bytes': disk.f_bavail * disk.f_frsize,
                                'used_bytes': (disk.f_blocks - disk.f_bfree) * disk.f_frsize}}
    write_json(BASE / 'inventory.json', {key: value for key, value in inventory.items() if key != 'files'})
    event(f'Manifest complete: {len(files)} files hashed.', 'ok')
    return inventory


def snapshot_read(token, encoded_path):
    lease = read_json(LEASE)
    if not lease or not token or not secrets.compare_digest(lease['token'], token):
        raise RuntimeError('Snapshot token does not match')
    if lease['expires_at'] <= time.time() or not os.path.ismount(EXPORT):
        raise RuntimeError('Snapshot is expired or not mounted')
    name = base64.b64decode(encoded_path, altchars=b'-_', validate=True).decode('utf-8')
    relative = Path(name)
    if relative.is_absolute() or not name or any(part in ('', '.', '..') for part in name.split('/')) or any(ord(c) < 32 or ord(c) == 127 or c == chr(92) for c in name):
        raise RuntimeError('Invalid snapshot path')
    path = EXPORT / relative
    path.resolve(strict=True).relative_to(EXPORT.resolve())
    for part in [path, *path.parents]:
        if part == EXPORT:
            break
        if part.is_symlink():
            raise RuntimeError('Symlinks cannot be read')
    with path.open('rb') as source:
        while chunk := source.read(1024 * 1024):
            if lease['expires_at'] <= time.time():
                raise RuntimeError('Snapshot lease expired during transfer')
            sys.stdout.buffer.write(chunk)
    sys.stdout.buffer.flush()


def serve_ssh():
    command = shlex.split(os.environ.get('SSH_ORIGINAL_COMMAND', ''))
    allowed = {'status', 'logs', 'start', 'detach', 'snapshot-open', 'snapshot-close', 'snapshot-manifest', 'snapshot-read', 'heartbeat-configure'}
    if len(command) < 4 or command[:2] != ['sudo', '-n'] or command[2] not in {'usbcloud-client', 'blink-poc'} or command[3] not in allowed:
        raise RuntimeError('This key only permits USBCloud commands')
    # No shell: argparse validates options and each operation validates its lease.
    os.execvp('sudo', ['sudo', '-n', '/usr/local/sbin/usbcloud-client', *command[3:]])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['heartbeat', 'heartbeat-configure', 'ssh-serve', 'snapshot-read', 'init', 'start', 'detach', 'logs', 'snapshot-open', 'snapshot-close', 'snapshot-expire', 'snapshot-manifest', 'status'])
    parser.add_argument('--token')
    parser.add_argument('--path')
    parser.add_argument('--timeout', type=int, default=600)
    args = parser.parse_args()
    if args.action == 'ssh-serve':
        serve_ssh()
        return
    if os.geteuid() != 0:
        parser.error('Requires root')
    BASE.mkdir(mode=0o700, parents=True, exist_ok=True)
    if args.action == 'heartbeat-configure':
        configure_heartbeat()
        return
    if args.action == 'heartbeat':
        heartbeat_loop()
        return
    if args.action == 'logs':
        print(json.dumps({'entries': device_logs()}))
        return
    if args.action == 'status':
        print(json.dumps(device_status()))
        return
    if args.action == 'snapshot-read':
        if not args.token or not args.path:
            parser.error('snapshot-read requires --token and --path')
        snapshot_read(args.token, args.path)
        return
    with (BASE / 'lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if args.action == 'init':
            initialize()
        elif args.action == 'start':
            start()
        elif args.action == 'detach':
            detach()
        elif args.action == 'snapshot-open':
            open_snapshot(args.timeout)
        elif args.action == 'snapshot-close':
            if not args.token:
                parser.error('snapshot-close requires --token')
            release(token=args.token)
        elif args.action == 'snapshot-manifest':
            if not args.token:
                parser.error('snapshot-manifest requires --token')
            print(json.dumps(snapshot_manifest(args.token)))
        elif args.action == 'snapshot-expire':
            release(expired_only=True)



if __name__ == '__main__':
    main()
