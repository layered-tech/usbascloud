import io
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch, MagicMock

import usbcloud_client


class HeartbeatTests(unittest.TestCase):
    def test_metrics_tolerate_missing_pi_sensors_and_use_available_memory(self):
        def read(path):
            if str(path) == '/proc/meminfo':
                return 'MemTotal: 1000 kB\nMemAvailable: 250 kB\n'
            raise FileNotFoundError()
        with patch.object(Path, 'read_text', read), patch('shutil.disk_usage', return_value=SimpleNamespace(total=100, used=40, free=60)), patch('subprocess.run', side_effect=FileNotFoundError()):
            metrics = usbcloud_client.health_metrics()
        self.assertEqual(metrics['memory_used_percent'], 75)
        self.assertEqual(metrics['root_used_percent'], 40)
        self.assertEqual(metrics['root_free_bytes'], 60)
        self.assertIsNone(metrics['cpu_temperature_c'])
        self.assertIsNone(metrics['throttled_flags'])

    def test_request_uses_bearer_json_and_timeout(self):
        opener = MagicMock()
        with patch.object(usbcloud_client, 'heartbeat_payload', return_value={'metrics': {}}), patch('urllib.request.build_opener', return_value=opener):
            usbcloud_client.send_heartbeat({'url': 'https://backend.example/api/heartbeat', 'token': 'secret'})
        request = opener.open.call_args.args[0]
        self.assertEqual(request.get_header('Authorization'), 'Bearer secret')
        self.assertEqual(request.method, 'POST')
        self.assertEqual(json.loads(request.data), {'metrics': {}})
        self.assertEqual(opener.open.call_args.kwargs['timeout'], 10)
        self.assertIsNone(usbcloud_client.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://elsewhere.example'))

    def test_configuration_is_private_and_service_does_not_embed_token(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            writes = []
            original = Path.write_text
            def write(path, text):
                if str(path).startswith('/etc/systemd/'):
                    writes.append(text)
                    return len(text)
                return original(path, text)
            with patch.object(usbcloud_client, 'BASE', base), patch('sys.stdin', io.StringIO(json.dumps({'url': 'https://backend.example/api/heartbeat', 'token': 'a' * 64}))), patch.object(usbcloud_client, 'send_heartbeat'), patch.object(usbcloud_client, 'run') as run, patch.object(Path, 'write_text', write):
                usbcloud_client.configure_heartbeat()
            self.assertEqual((base / 'heartbeat.json').stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads((base / 'heartbeat.json').read_text())['token'], 'a' * 64)
            self.assertNotIn('a' * 64, writes[0])
            run.assert_any_call('systemctl', 'restart', 'usbcloud-heartbeat.service')

    def test_unreachable_backend_does_not_replace_existing_configuration(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            path = base / 'heartbeat.json'
            path.write_text('{"token": "old"}')
            with patch.object(usbcloud_client, 'BASE', base), patch('sys.stdin', io.StringIO(json.dumps({'url': 'https://backend.example/api/heartbeat', 'token': 'a' * 64}))), patch.object(usbcloud_client, 'send_heartbeat', side_effect=OSError('unreachable')), patch.object(usbcloud_client, 'run') as run:
                with self.assertRaises(OSError):
                    usbcloud_client.configure_heartbeat()
            self.assertEqual(json.loads(path.read_text())['token'], 'old')
            run.assert_not_called()

    def test_loop_retries_after_network_failure(self):
        with patch.object(usbcloud_client, 'read_json', return_value={'url': 'https://example', 'token': 'a' * 64}), patch.object(usbcloud_client, 'send_heartbeat', side_effect=OSError('unreachable')) as send, patch('time.sleep', side_effect=[None, KeyboardInterrupt()]) as sleep, patch('sys.stderr', io.StringIO()) as stderr:
            with self.assertRaises(KeyboardInterrupt):
                usbcloud_client.heartbeat_loop()
        self.assertEqual(send.call_count, 2)
        sleep.assert_called_with(30)
        self.assertNotIn('a' * 64, stderr.getvalue())


if __name__ == '__main__':
    unittest.main()
