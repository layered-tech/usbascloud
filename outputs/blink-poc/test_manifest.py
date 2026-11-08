import hashlib
import json
from pathlib import Path
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import blink_poc


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
            with patch.object(blink_poc, 'BASE', root), patch.object(blink_poc, 'EXPORT', snapshot), patch.object(blink_poc, 'LEASE', lease), patch('os.path.ismount', return_value=True):
                with patch('os.statvfs', return_value=SimpleNamespace(f_blocks=100, f_frsize=512, f_bavail=80, f_bfree=80)):
                    result = blink_poc.snapshot_manifest('test-token')
                self.assertEqual(result['files'], [
                    {'name': 'clip with spaces.mp4', 'bytes': 4, 'sha256': hashlib.sha256(b'clip').hexdigest(), 'modified_at': '1970-01-01T00:00:00+00:00'}])
                self.assertEqual(result['filesystem']['used_bytes'], 10240)
                self.assertEqual(result['filesystem']['free_bytes'], 40960)
                self.assertEqual(result['filesystem']['total_bytes'], 51200)
                self.assertTrue((root / 'inventory.json').exists())
                self.assertNotIn('files', json.loads((root / 'inventory.json').read_text()))
                self.assertEqual(blink_poc.device_logs()[0]['level'], 'ok')
                with self.assertRaisesRegex(RuntimeError, 'token'):
                    blink_poc.snapshot_manifest('wrong-token')
                with patch('os.path.ismount', return_value=False):
                    with self.assertRaisesRegex(RuntimeError, 'not mounted'):
                        blink_poc.snapshot_manifest('test-token')
                lease.write_text(json.dumps({'token': 'test-token', 'expires_at': 0}))
                with self.assertRaisesRegex(RuntimeError, 'expired'):
                    blink_poc.snapshot_manifest('test-token')


class DetachTest(unittest.TestCase):
    def test_refuses_detach_while_a_snapshot_is_active(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            lease = root / 'snapshot.json'
            lease.write_text(json.dumps({'token': 'active', 'expires_at': time.time() + 60}))
            with patch.object(blink_poc, 'BASE', root), patch.object(blink_poc, 'LEASE', lease), patch.object(blink_poc, 'run') as command:
                with self.assertRaisesRegex(RuntimeError, 'snapshot is active'):
                    blink_poc.detach()
                command.assert_not_called()

class LiveReadTest(unittest.TestCase):
    def test_log_reads_do_not_wait_for_the_snapshot_lock(self):
        import contextlib
        import io
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'events.jsonl').write_text(json.dumps({'at': 'now', 'level': 'info', 'message': 'Snapshot hashing in progress.'}) + '\n{"partial":')
            stream = io.StringIO()
            with patch.object(blink_poc, 'BASE', root), patch('os.geteuid', return_value=0), patch('sys.argv', ['blink-poc', 'logs']), patch('fcntl.flock') as lock, contextlib.redirect_stdout(stream):
                blink_poc.main()
            lock.assert_not_called()
            self.assertEqual(json.loads(stream.getvalue())['entries'][0]['message'], 'Snapshot hashing in progress.')

    def test_status_reads_do_not_wait_for_the_snapshot_lock(self):
        import contextlib
        import io
        with tempfile.TemporaryDirectory() as folder:
            stream = io.StringIO()
            with patch.object(blink_poc, 'BASE', Path(folder)), patch('os.geteuid', return_value=0), patch('sys.argv', ['blink-poc', 'status']), patch.object(blink_poc, 'device_status', return_value={'gadget_loaded': True}), patch('fcntl.flock') as lock, contextlib.redirect_stdout(stream):
                blink_poc.main()
            lock.assert_not_called()
            self.assertTrue(json.loads(stream.getvalue())['gadget_loaded'])

class SnapshotTimeoutTest(unittest.TestCase):
    def test_validates_timeout_before_touching_storage(self):
        with patch.object(blink_poc, 'attach_pool') as attach:
            for seconds in (0, 59, 3601):
                with self.assertRaisesRegex(ValueError, 'Snapshot timeout'):
                    blink_poc.open_snapshot(seconds)
            attach.assert_not_called()

    def test_applies_requested_lease_duration(self):
        import contextlib
        import io
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            lease = root / 'snapshot.json'
            with patch.object(blink_poc, 'BASE', root), patch.object(blink_poc, 'LEASE', lease), patch.object(blink_poc, 'SNAP', str(root / 'capture')), patch.object(blink_poc, 'EXPORT', root / 'export'), patch.object(blink_poc, 'attach_pool'), patch.object(blink_poc, 'release'), patch.object(blink_poc, 'run'), patch('subprocess.run', return_value=SimpleNamespace(stdout='exfat')), patch('time.time', return_value=100), contextlib.redirect_stdout(io.StringIO()):
                blink_poc.open_snapshot(900)
            self.assertEqual(json.loads(lease.read_text())['expires_at'], 1000)

class RestrictedSshTest(unittest.TestCase):
    def test_rejects_shell_commands_and_destructive_initialization(self):
        for command in ('id', 'cat /etc/passwd', 'sudo -n blink-poc init', 'sudo -n blink-poc ssh-serve'):
            with patch.dict('os.environ', {'SSH_ORIGINAL_COMMAND': command}), patch('os.execvp') as execute:
                with self.assertRaisesRegex(RuntimeError, 'only permits USBCloud'):
                    blink_poc.serve_ssh()
                execute.assert_not_called()

    def test_executes_only_the_validated_command_without_a_shell(self):
        with patch.dict('os.environ', {'SSH_ORIGINAL_COMMAND': 'sudo -n blink-poc status'}), patch('os.execvp') as execute:
            blink_poc.serve_ssh()
        execute.assert_called_once_with('sudo', ['sudo', '-n', '/usr/local/sbin/blink-poc', 'status'])

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
            with patch.object(blink_poc, 'EXPORT', snapshot), patch.object(blink_poc, 'LEASE', lease), patch('os.path.ismount', return_value=True), patch('sys.stdout', out):
                blink_poc.snapshot_read('active', base64.urlsafe_b64encode(b'clip.mp4').decode())
                self.assertEqual(out.buffer.getvalue(), b'clip')
                for path in (b'../private', b'/etc/passwd', b'link', b'a/../../private'):
                    with self.assertRaises((RuntimeError, ValueError, FileNotFoundError)):
                        blink_poc.snapshot_read('active', base64.urlsafe_b64encode(path).decode())
                with self.assertRaisesRegex(RuntimeError, 'token'):
                    blink_poc.snapshot_read('wrong', base64.urlsafe_b64encode(b'clip.mp4').decode())


if __name__ == '__main__':
    unittest.main()
