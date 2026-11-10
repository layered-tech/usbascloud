import hashlib
import json
from pathlib import Path
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import usbcloud_client


class ManifestTest(unittest.TestCase):
    def test_hashes_snapshot_files_and_skips_symlinks(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            snapshot = root / 'snapshot'
            snapshot.mkdir()
            (snapshot / 'clip with spaces.mp4').write_bytes(b'clip')
            import os
            os.utime(snapshot / 'clip with spaces.mp4', (0, 0))
            (snapshot / 'link').symlink_to(snapshot / 'clip with spaces.mp4')
            lease = root / 'lease.json'
            lease.write_text(json.dumps({'token': 'test-token', 'expires_at': time.time() + 60}))
            with patch.object(usbcloud_client, 'BASE', root), patch.object(usbcloud_client, 'EXPORT', snapshot), patch.object(usbcloud_client, 'LEASE', lease), patch('os.path.ismount', return_value=True):
                with patch('os.statvfs', return_value=SimpleNamespace(f_blocks=100, f_frsize=512, f_bavail=80, f_bfree=80)):
                    result = usbcloud_client.snapshot_manifest('test-token')
                self.assertEqual(result['files'], [
                    {'name': 'clip with spaces.mp4', 'bytes': 4, 'sha256': hashlib.sha256(b'clip').hexdigest(), 'modified_at': '1970-01-01T00:00:00+00:00'}])
                self.assertEqual(result['filesystem']['used_bytes'], 10240)
                self.assertEqual(result['filesystem']['free_bytes'], 40960)
                self.assertEqual(result['filesystem']['total_bytes'], 51200)
                self.assertTrue((root / 'inventory.json').exists())
                self.assertNotIn('files', json.loads((root / 'inventory.json').read_text()))
                self.assertEqual(usbcloud_client.device_logs()[0]['level'], 'ok')
                with self.assertRaisesRegex(RuntimeError, 'token'):
                    usbcloud_client.snapshot_manifest('wrong-token')
                with patch('os.path.ismount', return_value=False):
                    with self.assertRaisesRegex(RuntimeError, 'not mounted'):
                        usbcloud_client.snapshot_manifest('test-token')
                lease.write_text(json.dumps({'token': 'test-token', 'expires_at': 0}))
                with self.assertRaisesRegex(RuntimeError, 'expired'):
                    usbcloud_client.snapshot_manifest('test-token')


class DetachTest(unittest.TestCase):
    def test_refuses_detach_while_a_snapshot_is_active(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            lease = root / 'snapshot.json'
            lease.write_text(json.dumps({'token': 'active', 'expires_at': time.time() + 60}))
            with patch.object(usbcloud_client, 'BASE', root), patch.object(usbcloud_client, 'LEASE', lease), patch.object(usbcloud_client, 'run') as command:
                with self.assertRaisesRegex(RuntimeError, 'snapshot is active'):
                    usbcloud_client.detach()
                command.assert_not_called()

class LiveReadTest(unittest.TestCase):
    def test_log_reads_do_not_wait_for_the_snapshot_lock(self):
        import contextlib
        import io
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'events.jsonl').write_text(json.dumps({'at': 'now', 'level': 'info', 'message': 'Snapshot hashing in progress.'}) + '\n{"partial":')
            stream = io.StringIO()
            with patch.object(usbcloud_client, 'BASE', root), patch('os.geteuid', return_value=0), patch('sys.argv', ['usbcloud-client', 'logs']), patch('fcntl.flock') as lock, contextlib.redirect_stdout(stream):
                usbcloud_client.main()
            lock.assert_not_called()
            self.assertEqual(json.loads(stream.getvalue())['entries'][0]['message'], 'Snapshot hashing in progress.')

    def test_status_reads_do_not_wait_for_the_snapshot_lock(self):
        import contextlib
        import io
        with tempfile.TemporaryDirectory() as folder:
            stream = io.StringIO()
            with patch.object(usbcloud_client, 'BASE', Path(folder)), patch('os.geteuid', return_value=0), patch('sys.argv', ['usbcloud-client', 'status']), patch.object(usbcloud_client, 'device_status', return_value={'gadget_loaded': True}), patch('fcntl.flock') as lock, contextlib.redirect_stdout(stream):
                usbcloud_client.main()
            lock.assert_not_called()
            self.assertTrue(json.loads(stream.getvalue())['gadget_loaded'])

class SnapshotTimeoutTest(unittest.TestCase):
    def test_validates_timeout_before_touching_storage(self):
        with patch.object(usbcloud_client, 'attach_pool') as attach:
            for seconds in (0, 59, 3601):
                with self.assertRaisesRegex(ValueError, 'Snapshot timeout'):
                    usbcloud_client.open_snapshot(seconds)
            attach.assert_not_called()

    def test_applies_requested_lease_duration(self):
        import contextlib
        import io
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            lease = root / 'snapshot.json'
            with patch.object(usbcloud_client, 'BASE', root), patch.object(usbcloud_client, 'LEASE', lease), patch.object(usbcloud_client, 'SNAP', str(root / 'capture')), patch.object(usbcloud_client, 'EXPORT', root / 'export'), patch.object(usbcloud_client, 'attach_pool'), patch.object(usbcloud_client, 'release'), patch.object(usbcloud_client, 'run'), patch('subprocess.run', return_value=SimpleNamespace(stdout='exfat')), patch('time.time', return_value=100), contextlib.redirect_stdout(io.StringIO()):
                usbcloud_client.open_snapshot(900)
            self.assertEqual(json.loads(lease.read_text())['expires_at'], 1000)

class SnapshotFilesystemTest(unittest.TestCase):
    def open_snapshot(self, root, table_type='', filesystem='exfat', mount_error=None):
        def probe(args, **kwargs):
            return SimpleNamespace(stdout=table_type if 'PTTYPE' in args else filesystem)

        def command(*args, **kwargs):
            if args[0] == 'sfdisk':
                return SimpleNamespace(stdout=json.dumps({'partitiontable': {
                    'sectorsize': 512, 'partitions': [{'start': 32, 'size': 16777184}],
                }}))
            if args[0] == 'losetup':
                return SimpleNamespace(stdout='/dev/loop1\n')
            if args[0] == 'blkid':
                return SimpleNamespace(stdout=filesystem)
            if args[0] == 'mount' and mount_error:
                raise mount_error
            return SimpleNamespace(stdout='')

        import contextlib
        import io
        with patch.object(usbcloud_client, 'BASE', root), patch.object(usbcloud_client, 'LEASE', root / 'snapshot.json'), patch.object(usbcloud_client, 'SNAP', str(root / 'capture')), patch.object(usbcloud_client, 'EXPORT', root / 'export'), patch.object(usbcloud_client, 'attach_pool'), patch.object(usbcloud_client, 'release') as release, patch.object(usbcloud_client, 'run', side_effect=command) as run, patch('subprocess.run', side_effect=probe), contextlib.redirect_stdout(io.StringIO()):
            if mount_error or filesystem not in ('exfat', 'vfat'):
                with self.assertRaises(type(mount_error) if mount_error else RuntimeError):
                    usbcloud_client.open_snapshot()
                release.assert_any_call()
            else:
                usbcloud_client.open_snapshot()
            return run

    def test_mounts_partition_instead_of_stale_whole_disk_signature(self):
        for table_type in ('dos', 'gpt'):
            with self.subTest(table=table_type), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                run = self.open_snapshot(root, table_type=table_type)
                run.assert_any_call('losetup', '--find', '--show', '--read-only', '--offset', '16384', '--sizelimit', '8589918208', str(root / 'capture'), stdout=-1)
                run.assert_any_call('mount', '-t', 'exfat', '-o', 'ro,nosuid,nodev,noexec,fmask=0133,dmask=0022', '/dev/loop1', str(root / 'export'))
                self.assertEqual(json.loads((root / 'snapshot.json').read_text())['loop'], '/dev/loop1')

    def test_mounts_unpartitioned_filesystems_directly(self):
        for filesystem in ('exfat', 'vfat'):
            with self.subTest(filesystem=filesystem), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                run = self.open_snapshot(root, filesystem=filesystem)
                run.assert_any_call('mount', '-t', filesystem, '-o', 'ro,nosuid,nodev,noexec,fmask=0133,dmask=0022', str(root / 'capture'), str(root / 'export'))
                self.assertFalse(any(call.args[0] == 'losetup' for call in run.call_args_list))

    def test_releases_snapshot_when_partition_mount_fails(self):
        with tempfile.TemporaryDirectory() as folder:
            self.open_snapshot(Path(folder), table_type='dos', mount_error=RuntimeError('mount failed'))

    def test_rejects_unsupported_partition_filesystem_and_releases_snapshot(self):
        with tempfile.TemporaryDirectory() as folder:
            run = self.open_snapshot(Path(folder), table_type='dos', filesystem='ext4')
            self.assertFalse(any(call.args[0] == 'mount' for call in run.call_args_list))

class RestrictedSshTest(unittest.TestCase):
    def test_rejects_shell_commands_and_destructive_initialization(self):
        for command in ('id', 'cat /etc/passwd', 'sudo -n usbcloud-client init', 'sudo -n usbcloud-client ssh-serve'):
            with patch.dict('os.environ', {'SSH_ORIGINAL_COMMAND': command}), patch('os.execvp') as execute:
                with self.assertRaisesRegex(RuntimeError, 'only permits USBCloud'):
                    usbcloud_client.serve_ssh()
                execute.assert_not_called()

    def test_executes_only_the_validated_command_without_a_shell(self):
        with patch.dict('os.environ', {'SSH_ORIGINAL_COMMAND': 'sudo -n usbcloud-client status'}), patch('os.execvp') as execute:
            usbcloud_client.serve_ssh()
        execute.assert_called_once_with('sudo', ['sudo', '-n', '/usr/local/sbin/usbcloud-client', 'status'])

    def test_reads_only_normal_files_inside_a_live_snapshot(self):
        import base64
        import contextlib
        import io
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            snapshot = root / 'export'
            snapshot.mkdir()
            (snapshot / 'clip.mp4').write_bytes(b'clip')
            (root / 'private').write_bytes(b'private')
            (snapshot / 'link').symlink_to(root / 'private')
            lease = root / 'lease.json'
            lease.write_text(json.dumps({'token': 'active', 'expires_at': time.time() + 60}))
            class Output:
                buffer = io.BytesIO()
            out = Output()
            with patch.object(usbcloud_client, 'EXPORT', snapshot), patch.object(usbcloud_client, 'LEASE', lease), patch('os.path.ismount', return_value=True), patch('sys.stdout', out):
                usbcloud_client.snapshot_read('active', base64.urlsafe_b64encode(b'clip.mp4').decode())
                self.assertEqual(out.buffer.getvalue(), b'clip')
                for path in (b'../private', b'/etc/passwd', b'link', b'a/../../private'):
                    with self.assertRaises((RuntimeError, ValueError, FileNotFoundError)):
                        usbcloud_client.snapshot_read('active', base64.urlsafe_b64encode(path).decode())
                with self.assertRaisesRegex(RuntimeError, 'token'):
                    usbcloud_client.snapshot_read('wrong', base64.urlsafe_b64encode(b'clip.mp4').decode())


if __name__ == '__main__':
    unittest.main()
