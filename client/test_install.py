import base64
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch, MagicMock

import install_client
import usbcloud_client


def host_key():
    wire = b'\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20' + b'a' * 32
    return 'ssh-ed25519 ' + base64.b64encode(wire).decode()


class InstallerTests(unittest.TestCase):
    def test_boot_configuration_replaces_conflicting_overlay_and_is_repeatable(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'config.txt'
            original = '[cm4]\ndtoverlay=dwc2,dr_mode=host\n[all]\ndtparam=audio=on\n'
            path.write_text(original)
            self.assertTrue(install_client.configure_boot(path))
            installed = path.read_text()
            self.assertIn('dtparam=audio=on', installed)
            self.assertEqual(installed.count('dtoverlay=dwc2'), 1)
            self.assertTrue(installed.endswith('[all]\n# USBCloud USB device mode\ndtoverlay=dwc2,dr_mode=peripheral\n# End USBCloud USB device mode\n'))
            self.assertFalse(install_client.configure_boot(path))
            self.assertEqual(path.with_name('config.txt.usbcloud-backup').read_text(), original)

    def test_pi4_profile_sets_peripheral_controller_without_erasing_other_board_settings(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'config.txt'
            original = '[cm4]\notg_mode=1\n[all]\ndtparam=audio=on\n'
            path.write_text(original)
            profile = install_client.select_profile('Raspberry Pi 4 Model B Rev 1.5', 'pi-4-b')
            self.assertTrue(install_client.configure_boot(path, profile))
            self.assertIn('[cm4]\notg_mode=1', path.read_text())
            self.assertIn('# USBCloud USB device mode\notg_mode=0\ndtoverlay=dwc2,dr_mode=peripheral\n', path.read_text())
            self.assertFalse(install_client.configure_boot(path, profile))
            self.assertEqual(path.with_name('config.txt.usbcloud-backup').read_text(), original)

    def test_profile_selection_rejects_wrong_and_unsupported_boards(self):
        for model, profile in [('Raspberry Pi Zero 2 W Rev 1.0', 'pi-4-b'), ('Raspberry Pi 4 Model B Rev 1.5', 'pi-zero-2-w'), ('Raspberry Pi 400 Rev 1.0', 'pi-4-b'), ('Raspberry Pi 5 Model B Rev 1.0', None)]:
            with self.subTest(model=model, profile=profile), self.assertRaisesRegex(RuntimeError, 'profile|supported'):
                install_client.select_profile(model, profile)
        with self.assertRaisesRegex(ValueError, 'Unknown'):
            install_client.select_profile('Raspberry Pi 4 Model B Rev 1.5', 'unknown')

    def test_profile_prompt_and_update_detection_use_the_actual_board(self):
        with patch('sys.stdin.isatty', return_value=True), patch('builtins.input', side_effect=['unknown', 'pi-4-b']) as prompt:
            self.assertEqual(install_client.select_profile('Raspberry Pi 4 Model B Rev 1.5')['id'], 'pi-4-b')
            self.assertEqual(prompt.call_count, 2)
        with patch('sys.stdin.isatty', return_value=False), patch('builtins.input') as prompt:
            self.assertEqual(install_client.select_profile('Raspberry Pi 4 Model B Rev 1.5', update=True)['id'], 'pi-4-b')
            with self.assertRaisesRegex(RuntimeError, '--profile'):
                install_client.select_profile('Raspberry Pi 4 Model B Rev 1.5')
            prompt.assert_not_called()

    def test_mismatched_board_stops_installation_before_any_system_changes(self):
        model = SimpleNamespace(exists=lambda: True, read_text=lambda: 'Raspberry Pi 4 Model B Rev 1.5')
        with patch('os.geteuid', return_value=0), patch.object(install_client, 'Path', return_value=model), patch.object(install_client, 'api', return_value={'installer_profile': 'pi-zero-2-w'}), patch.object(install_client, 'run') as run, patch.object(install_client, 'configure_boot') as boot:
            with self.assertRaisesRegex(RuntimeError, 'does not match'):
                install_client.install('https://nas.example', 'setup-token')
            run.assert_not_called()
            boot.assert_not_called()

    def test_backend_key_is_restricted_once_and_admin_keys_are_preserved(self):
        with tempfile.TemporaryDirectory() as folder:
            account = SimpleNamespace(pw_dir=folder, pw_uid=os.getuid(), pw_gid=os.getgid())
            directory = Path(folder) / '.ssh'
            directory.mkdir()
            path = directory / 'authorized_keys'
            path.write_text('ssh-ed25519 ADMIN admin\n' + host_key() + ' unrestricted\n')
            install_client.authorize_backend(account, host_key())
            install_client.authorize_backend(account, host_key())
            self.assertEqual(path.read_text().splitlines(), ['ssh-ed25519 ADMIN admin',
                f'restrict,command="{install_client.CLIENT} ssh-serve" {host_key()}'])
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(directory.stat().st_mode & 0o777, 0o700)

    def test_invalid_backend_keys_and_symlinked_authorized_keys_are_rejected(self):
        for key in ('command="id" ' + host_key(), host_key() + '\n' + host_key(), 'ssh-ed25519 !bad!'):
            with self.assertRaises(RuntimeError):
                install_client.public_key(key)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / '.ssh').mkdir()
            (root / 'private').write_text('preserve')
            (root / '.ssh/authorized_keys').symlink_to(root / 'private')
            with self.assertRaises(RuntimeError):
                install_client.authorize_backend(SimpleNamespace(pw_dir=folder, pw_uid=os.getuid(), pw_gid=os.getgid()), host_key())
            self.assertEqual((root / 'private').read_text(), 'preserve')

    def test_invalid_sudoers_keeps_previous_rule_and_removes_staging_file(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            path = directory / 'usbcloud-client'
            path.write_text('old rule\n')
            with patch.object(install_client, 'run', side_effect=subprocess.CalledProcessError(1, 'visudo')):
                with self.assertRaises(subprocess.CalledProcessError):
                    install_client.configure_sudo('chris', directory)
            self.assertEqual(path.read_text(), 'old rule\n')
            self.assertFalse((directory / '.usbcloud-client.new').exists())
            with patch.object(install_client, 'run') as run:
                install_client.configure_sudo('chris', directory)
            run.assert_called_once_with('visudo', '-cf', str(directory / '.usbcloud-client.new'))
            self.assertEqual(path.read_text(), f'chris ALL=(root) NOPASSWD: {install_client.CLIENT} *\n')
            self.assertEqual(path.stat().st_mode & 0o777, 0o440)

    def test_existing_pool_is_never_reinitialized_even_when_incomplete(self):
        with tempfile.TemporaryDirectory() as folder:
            pool = Path(folder) / 'pool.img'
            pool.write_bytes(b'recordings')
            with patch.object(usbcloud_client, 'POOL', pool), patch.object(usbcloud_client, 'attach_pool'), patch.object(install_client, 'run', return_value=SimpleNamespace(stdout='exfat\n')) as run:
                install_client.initialize_storage()
                self.assertNotIn(unittest.mock.call(install_client.CLIENT, 'init'), run.call_args_list)
                run.side_effect = subprocess.CalledProcessError(5, 'lvs')
                with self.assertRaises(subprocess.CalledProcessError):
                    install_client.initialize_storage()
                run.side_effect = None
                run.return_value.stdout = 'ext4\n'
                install_client.initialize_storage()
                self.assertNotIn(unittest.mock.call(install_client.CLIENT, 'init'), run.call_args_list)
            self.assertEqual(pool.read_bytes(), b'recordings')

    def test_explicit_storage_size_and_available_space_are_checked_without_prompting(self):
        with patch('shutil.disk_usage', return_value=SimpleNamespace(free=112 * 1024**3)), patch('builtins.input') as prompt:
            self.assertEqual(install_client.select_storage_size(48), 48)
            with self.assertRaisesRegex(RuntimeError, '52 GiB'):
                install_client.select_storage_size(100)
            with self.assertRaisesRegex(ValueError, 'whole number'):
                install_client.select_storage_size(0)
            prompt.assert_not_called()

    def test_missing_size_prompts_with_safe_maximum_and_retries_invalid_answers(self):
        with patch('shutil.disk_usage', return_value=SimpleNamespace(free=112 * 1024**3)), patch('sys.stdin.isatty', return_value=True), patch('builtins.input', side_effect=['no', '100', '48']) as prompt:
            self.assertEqual(install_client.select_storage_size(), 48)
            self.assertEqual(prompt.call_count, 3)
            self.assertIn('52', prompt.call_args.args[0])
        with patch('shutil.disk_usage', return_value=SimpleNamespace(free=112 * 1024**3)), patch('sys.stdin.isatty', return_value=True), patch('builtins.input', return_value=''):
            self.assertEqual(install_client.select_storage_size(), 52)

    def test_missing_size_on_noninteractive_install_and_insufficient_space_stop_before_setup(self):
        with patch('shutil.disk_usage', return_value=SimpleNamespace(free=112 * 1024**3)), patch('sys.stdin.isatty', return_value=False):
            with self.assertRaisesRegex(RuntimeError, '--size-gib'):
                install_client.select_storage_size()
        with patch('shutil.disk_usage', return_value=SimpleNamespace(free=9 * 1024**3)), patch('builtins.input') as prompt:
            with self.assertRaisesRegex(RuntimeError, 'space'):
                install_client.select_storage_size()
            prompt.assert_not_called()

    def test_storage_initialization_forwards_the_selected_size_and_preserves_existing_pool(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            pool = base / 'pool.img'
            with patch.object(usbcloud_client, 'BASE', base), patch.object(usbcloud_client, 'POOL', pool), patch.object(usbcloud_client, 'attach_pool'), patch.object(install_client, 'run') as run:
                install_client.initialize_storage(48)
                run.assert_called_once_with(install_client.CLIENT, 'init', '--size-gib', '48')
                pool.write_bytes(b'recordings')
                run.reset_mock()
                install_client.initialize_storage(16)
                run.assert_called_once_with('lvs', '--noheadings', usbcloud_client.ORIGIN)
                self.assertEqual(pool.read_bytes(), b'recordings')

    def test_reboot_requires_interactive_acceptance(self):
        with patch('sys.argv', ['install_client.py', '--update']), patch.object(install_client, 'install', return_value=True), patch('sys.stdin.isatty', return_value=False), patch.object(install_client, 'run') as run:
            self.assertEqual(install_client.main(), 0)
            run.assert_not_called()
        with patch('sys.argv', ['install_client.py', '--update']), patch.object(install_client, 'install', return_value=True), patch('sys.stdin.isatty', return_value=True), patch('builtins.input', return_value='y'), patch.object(install_client, 'run') as run:
            self.assertEqual(install_client.main(), 0)
            run.assert_called_once_with('systemctl', 'reboot')

    def test_command_line_size_reaches_the_installer(self):
        with patch('sys.argv', ['install_client.py', '--backend', 'https://nas.example', '--token', 'setup-token', '--size-gib', '48']), patch.object(install_client, 'install', return_value=False) as install:
            self.assertEqual(install_client.main(), 0)
            install.assert_called_once_with('https://nas.example', 'setup-token', False, 48, None)

    def test_command_line_profile_reaches_the_installer(self):
        with patch('sys.argv', ['install_client.py', '--backend', 'https://nas.example', '--token', 'setup-token', '--profile', 'pi-4-b']), patch.object(install_client, 'install', return_value=False) as install:
            self.assertEqual(install_client.main(), 0)
            install.assert_called_once_with('https://nas.example', 'setup-token', False, None, 'pi-4-b')

    def test_api_sends_token_in_header_and_refuses_redirects(self):
        opener = MagicMock()
        opener.open.return_value.__enter__.return_value = io.StringIO('{"user":"pi"}')
        with patch('urllib.request.build_opener', return_value=opener) as build:
            self.assertEqual(install_client.api('https://nas.example', 'secret', 'configuration'), {'user': 'pi'})
        self.assertIsInstance(build.call_args.args[0], usbcloud_client.NoRedirect)
        request = opener.open.call_args.args[0]
        self.assertEqual(request.get_header('Authorization'), 'Bearer secret')
        self.assertNotIn('secret', request.full_url)
        self.assertEqual(json.loads(request.data), {})

    def test_fresh_install_and_retry_configure_the_system_and_preserve_storage(self):
        for profile_id, model in [('pi-zero-2-w', 'Raspberry Pi Zero 2 W Rev 1.0'), ('pi-4-b', 'Raspberry Pi 4 Model B Rev 1.5')]:
            with tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                def filesystem(path):
                    value = str(path)
                    if value.startswith(str(root)):
                        return Path(value)
                    if value.startswith(('/proc/', '/boot/', '/etc/', '/sys/', '/usr/', '/var/')):
                        return root / value.lstrip('/')
                    return Path(path)
                for name, content in {
                    '/proc/device-tree/model': model + '\x00',
                    '/boot/firmware/config.txt': '[all]\ndtparam=audio=on\n',
                    '/etc/ssh/ssh_host_ed25519_key.pub': host_key(),
                }.items():
                    path = filesystem(name)
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(content)
                base = root / 'var/lib/usbcloud-client'
                account = SimpleNamespace(pw_dir=str(root / 'home/chris'), pw_uid=os.getuid(), pw_gid=os.getgid())
                Path(account.pw_dir).mkdir(parents=True)
                configuration = {'user': 'chris', 'port': 22, 'public_key': host_key(), 'storage_size_gib': 8, 'installer_profile': profile_id}
                enrollment = {'device': 'PI', 'url': 'https://nas.example/heartbeat', 'token': 'a' * 64}
                original_sudo = install_client.configure_sudo
                with patch.object(install_client, 'Path', side_effect=filesystem), patch('os.geteuid', return_value=0), patch('pwd.getpwnam', return_value=account), patch('shutil.which', return_value='/bin/tool'), patch('shutil.disk_usage', return_value=SimpleNamespace(free=30 * 1024**3)), patch.object(install_client, 'run', return_value=SimpleNamespace(stdout='exfat\n')) as run, patch('subprocess.run'), patch.object(install_client, 'api', side_effect=[configuration, enrollment, configuration, enrollment]) as api, patch.object(usbcloud_client, 'BASE', base), patch.object(usbcloud_client, 'POOL', base / 'pool.img'), patch.object(usbcloud_client, 'attach_pool'), patch.object(install_client, 'configure_sudo', side_effect=lambda user: original_sudo(user, filesystem('/etc/sudoers.d'))):
                    install_client.install('https://nas.example', 'setup-token')
                    run.assert_any_call(install_client.CLIENT, 'init', '--size-gib', '8')
                    run.assert_any_call(install_client.CLIENT, 'heartbeat-configure', input=json.dumps({'url': enrollment['url'], 'token': enrollment['token']}))
                    run.assert_any_call('systemctl', 'enable', 'usbcloud-client.service')
                    api.assert_any_call('https://nas.example', 'setup-token', 'enroll', {'host_key': host_key()})
                    (base / 'pool.img').write_bytes(b'recordings')
                    filesystem('/sys/class/udc/controller').mkdir(parents=True)
                    run.reset_mock()
                    install_client.install('https://nas.example', 'setup-token')
                    self.assertNotIn(unittest.mock.call(install_client.CLIENT, 'init'), run.call_args_list)
                    run.assert_any_call('systemctl', 'start', 'usbcloud-client.service')
                    api.reset_mock()
                    install_client.install(update=True)
                    api.assert_not_called()
                self.assertEqual(json.loads((base / 'installer.json').read_text()), {'installer_profile': profile_id})
                self.assertEqual((base / 'pool.img').read_bytes(), b'recordings')
                self.assertEqual(filesystem('/etc/modules-load.d/usbcloud-client.conf').read_text(), 'dwc2\n')
                self.assertEqual((root / 'home/chris/.ssh/authorized_keys').read_text().count(host_key()), 1)


if __name__ == '__main__':
    unittest.main()
