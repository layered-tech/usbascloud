#!/usr/bin/env python3
"""Install USBCloud on Raspberry Pi OS and enroll it with its backend."""
import argparse
import base64
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

import usbcloud_client

CLIENT = '/usr/local/sbin/usbcloud-client'
PROFILES_PATH = Path(__file__).with_name('installer_profiles.json')


def installer_profiles():
    return json.loads(PROFILES_PATH.read_text())


def select_profile(model, profile_id=None, update=False):
    profiles = installer_profiles()
    if profile_id is not None and profile_id not in profiles:
        raise ValueError(f'Unknown installer profile: {profile_id}')
    model = model.strip('\x00\n ')
    matches = [key for key, profile in profiles.items() if re.fullmatch(profile['model_pattern'], model)]
    if not matches:
        raise RuntimeError(f'No supported installer profile for this board: {model}')
    if profile_id is None:
        if update:
            profile_id = matches[0]
        else:
            if not sys.stdin.isatty():
                raise RuntimeError('Select a device profile in Add device or supply --profile in the installation command.')
            print(f'Detected board: {model}')
            for key, profile in profiles.items():
                print(f"  {key}: {profile['name']}")
            while profile_id not in profiles:
                profile_id = input(f'Device profile [{matches[0]}]: ').strip() or matches[0]
                if profile_id not in profiles:
                    print('Enter one of the profile IDs above.')
    profile = profiles[profile_id]
    if profile_id not in matches:
        raise RuntimeError(f"The selected profile ({profile['name']}) does not match the detected board ({model}).")
    return dict(profile, id=profile_id)


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def api(base, token, action, data=None):
    request = urllib.request.Request(base.rstrip('/') + '/api/v1/client-installation/' + action,
        data=json.dumps(data or {}).encode(), headers={'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json', 'Accept': 'application/json'})
    try:
        with urllib.request.build_opener(usbcloud_client.NoRedirect()).open(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        try:
            message = json.load(error).get('message', 'Request rejected')
        except (ValueError, AttributeError):
            message = 'Request rejected'
        raise RuntimeError(f'Backend setup failed ({error.code}): {message}') from None


def write(path, content, mode=0o644):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        raise RuntimeError(f'Refusing to replace symlink: {path}')
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(content.encode())
            stream.flush()
            temporary.chmod(mode)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


def configure_boot(path, profile=None):
    profile = profile or installer_profiles()['pi-zero-2-w']
    original = path.read_text()
    managed = re.sub(r'^# USBCloud USB device mode\n.*?^# End USBCloud USB device mode\n?', '', original, flags=re.MULTILINE | re.DOTALL)
    lines = managed.splitlines()
    # Keep conditional sections and other settings; one unconditional overlay wins.
    lines = [line for line in lines if not re.match(r'^\s*dtoverlay\s*=\s*dwc2(?:,|\s|$)', line)
             and line != '# USBCloud USB device mode']
    updated = '\n'.join(lines).rstrip() + '\n'
    if not updated.endswith('[all]\n'):
        updated += '\n[all]\n'
    updated += '# USBCloud USB device mode\n' + '\n'.join(profile['boot_config']) + '\n# End USBCloud USB device mode\n'
    if updated == original:
        return False
    backup = path.with_name(path.name + '.usbcloud-backup')
    if not backup.exists():
        shutil.copy2(path, backup)
    write(path, updated)
    return True


def public_key(value):
    parts = value.strip().split()
    if len(parts) < 2 or parts[0] not in ('ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521') or '\n' in value.strip():
        raise RuntimeError('The backend did not provide a valid SSH public key.')
    try:
        decoded = base64.b64decode(parts[1], validate=True)
        length = int.from_bytes(decoded[:4], 'big')
        if decoded[4:4 + length].decode() != parts[0] or len(decoded) <= 4 + length:
            raise ValueError()
    except (ValueError, UnicodeError):
        raise RuntimeError('The backend did not provide a valid SSH public key.') from None
    return ' '.join(parts[:2])


def authorize_backend(account, key):
    directory = Path(account.pw_dir) / '.ssh'
    if directory.is_symlink():
        raise RuntimeError('The SSH directory must not be a symlink.')
    directory.mkdir(mode=0o700, exist_ok=True)
    directory.chmod(0o700)
    os.chown(directory, account.pw_uid, account.pw_gid)
    path = directory / 'authorized_keys'
    if path.is_symlink():
        raise RuntimeError('authorized_keys must not be a symlink.')
    lines = path.read_text().splitlines() if path.exists() else []
    blob = key.split()[1]
    lines = [line for line in lines if blob not in line.split()]
    lines.append(f'restrict,command="{CLIENT} ssh-serve" {key}')
    write(path, '\n'.join(lines) + '\n', 0o600)
    os.chown(path, account.pw_uid, account.pw_gid)


def configure_sudo(user, directory=Path('/etc/sudoers.d')):
    directory.mkdir(mode=0o755, parents=True, exist_ok=True)
    path = directory / 'usbcloud-client'
    staged = directory / '.usbcloud-client.new'
    write(staged, f'{user} ALL=(root) NOPASSWD: {CLIENT} *\n', 0o440)
    try:
        run('visudo', '-cf', str(staged))
        staged.replace(path)
    finally:
        staged.unlink(missing_ok=True)


def install_services():
    services = {
        'usbcloud-client.service': f'''[Unit]
Description=USBCloud client USB storage
After=local-fs.target systemd-modules-load.service
[Service]
Type=oneshot
ExecStart={CLIENT} start
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
''',
        'usbcloud-client-expire.service': f'''[Unit]
Description=Expire abandoned Pi storage snapshots
[Service]
Type=oneshot
ExecStart={CLIENT} snapshot-expire
''',
        'usbcloud-client-expire.timer': '''[Unit]
Description=Check Pi snapshot leases
[Timer]
OnBootSec=60
OnUnitActiveSec=30
[Install]
WantedBy=timers.target
''',
    }
    for name, content in services.items():
        write(Path('/etc/systemd/system') / name, content)
    write('/etc/avahi/services/usbcloud.service', f'''<?xml version="1.0" standalone="no"?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name replace-wildcards="yes">USBCloud on %h</name>
  <service><type>_usbcloud._tcp</type><port>22</port><txt-record>version={usbcloud_client.VERSION}</txt-record><txt-record>auth=ssh-key</txt-record></service>
</service-group>
''')
    run('ln', '-sfn', CLIENT, '/usr/local/sbin/blink-poc')
    subprocess.run(['systemctl', 'disable', 'blink-poc.service'], capture_output=True)
    subprocess.run(['systemctl', 'disable', '--now', 'blink-poc-expire.timer'], capture_output=True)
    run('systemctl', 'daemon-reload')
    run('systemctl', 'enable', 'usbcloud-client.service')
    run('systemctl', 'enable', '--now', 'usbcloud-client-expire.timer', 'avahi-daemon', 'ssh')


def select_storage_size(size_gib=None):
    path = usbcloud_client.BASE if usbcloud_client.BASE.exists() else usbcloud_client.BASE.parent
    maximum = usbcloud_client.maximum_storage_size_gib(path)
    if maximum < 1:
        raise RuntimeError('Not enough free space for USB storage, snapshots and the operating system. At least 10 GiB free is required.')
    if size_gib is not None:
        usbcloud_client.storage_pool_size_gib(size_gib)
        if size_gib > maximum:
            raise RuntimeError(f'Maximum USB storage size is {maximum} GiB after reserving snapshot and system space.')
        return size_gib
    if not sys.stdin.isatty():
        raise RuntimeError('Choose a storage size in Add device or supply --size-gib, or rerun this command in an interactive terminal.')
    print('Choose the capacity presented over USB. Snapshot and system space are reserved separately.')
    while True:
        answer = input(f'USB storage size in GiB (1–{maximum}) [{maximum}]: ').strip()
        try:
            selected = maximum if not answer else int(answer)
            usbcloud_client.storage_pool_size_gib(selected)
            if selected <= maximum:
                return selected
        except ValueError:
            pass
        print(f'Enter a whole number from 1 to {maximum}.')


def initialize_storage(size_gib=None):
    if usbcloud_client.POOL.exists():
        # Validate our backing volume, not the filesystem chosen by the USB host.
        usbcloud_client.attach_pool()
        run('lvs', '--noheadings', usbcloud_client.ORIGIN)
        print('Preserving existing USB storage and recordings.')
        return
    usbcloud_client.BASE.mkdir(parents=True, mode=0o700, exist_ok=True)
    run(CLIENT, 'init', '--size-gib', str(size_gib))


def install(backend=None, token=None, update=False, size_gib=None, profile_id=None):
    if os.geteuid() != 0:
        raise RuntimeError('Run the installer with sudo.')
    model = Path('/proc/device-tree/model')
    if not model.exists():
        raise RuntimeError('No supported Raspberry Pi board was detected.')
    configuration = None if update else api(backend, token, 'configuration')
    saved_profile = usbcloud_client.read_json(usbcloud_client.BASE / 'installer.json') if update else None
    detected_model = model.read_text().strip('\x00\n ')
    profile = select_profile(detected_model, profile_id or (configuration or saved_profile or {}).get('installer_profile'), update=update)
    print(f"Verified {detected_model} against profile {profile['name']}.", flush=True)
    boot = next((path for path in (Path('/boot/firmware/config.txt'), Path('/boot/config.txt')) if path.exists()), None)
    if boot is None or not shutil.which('apt-get') or not shutil.which('systemctl'):
        raise RuntimeError('Raspberry Pi OS with apt and systemd is required.')
    if configuration:
        user = configuration['user']
        if not re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}', user, re.IGNORECASE) or user == 'root':
            raise RuntimeError('Choose a non-root Pi user in Add device.')
        account = pwd.getpwnam(user)
        key = public_key(configuration['public_key'])
        if int(configuration['port']) != 22:
            raise RuntimeError('Automatic installation currently requires SSH port 22.')
    elif not usbcloud_client.POOL.exists():
        raise RuntimeError('No existing installation. Use the command from Add device.')
    if not usbcloud_client.POOL.exists():
        size_gib = select_storage_size(size_gib if size_gib is not None else configuration.get('storage_size_gib'))
    print('Installing system dependencies…', flush=True)
    run('apt-get', 'update')
    run('apt-get', 'install', '-y', 'lvm2', 'exfatprogs', 'fdisk', 'avahi-daemon', 'sudo', 'openssh-server', 'ca-certificates')
    run('install', '-o', 'root', '-g', 'root', '-m', '0755', str(Path(__file__).with_name('usbcloud_client.py')), CLIENT)
    print(f"Installing profile: {profile['name']}. {profile['description']}", flush=True)
    changed = configure_boot(boot, profile)
    write('/etc/modules-load.d/usbcloud-client.conf', '\n'.join(profile['modules']) + '\n')
    if configuration:
        authorize_backend(account, key)
        configure_sudo(user)
    initialize_storage(size_gib)
    write(usbcloud_client.BASE / 'installer.json', json.dumps({'installer_profile': profile['id']}), 0o600)
    install_services()
    if configuration:
        run('ssh-keygen', '-A')
        host_key = Path('/etc/ssh/ssh_host_ed25519_key.pub').read_text().strip()
        enrollment = api(backend, token, 'enroll', {'host_key': host_key})
        run(CLIENT, 'heartbeat-configure', input=json.dumps({'url': enrollment['url'], 'token': enrollment['token']}))
        print(f"Registered {enrollment['device']} with USBCloud.")
    elif (usbcloud_client.BASE / 'heartbeat.json').exists():
        run('systemctl', 'restart', 'usbcloud-heartbeat.service')
    controllers = list(Path('/sys/class/udc').glob('*'))
    if changed or not controllers:
        print('Setup complete. A reboot is required before connecting the USB data cable.')
        print(profile['description'])
        return True
    else:
        run('systemctl', 'start', 'usbcloud-client.service')
        print('Setup complete. USB storage is ready; connect the USB data cable.')
        print(profile['description'])
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backend')
    parser.add_argument('--token')
    parser.add_argument('--update', action='store_true')
    parser.add_argument('--size-gib', type=int, help='USB storage capacity in GiB; asks during a fresh install if omitted')
    parser.add_argument('--profile', choices=list(installer_profiles()), help='Target device profile; asks during a fresh install if omitted')
    args = parser.parse_args()
    if not args.update and (not args.backend or not args.token):
        parser.error('Use the installation command from Add device.')
    try:
        reboot_required = install(args.backend, args.token, args.update, args.size_gib, args.profile)
        if reboot_required:
            if sys.stdin.isatty() and input('Reboot now? [Y/n] ').strip().lower() in ('', 'y', 'yes'):
                run('systemctl', 'reboot')
            else:
                print('Run sudo reboot when ready. USB storage starts automatically after reboot.')
    except (EOFError, OSError, ValueError, KeyError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f'Installation stopped: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
