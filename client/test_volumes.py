import base64
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import usbcloud_client as client


class VolumeTest(unittest.TestCase):
    def test_discovers_all_data_partitions_with_non_default_sector_size(self):
        table = {'partitiontable': {'label': 'dos', 'sectorsize': 4096, 'partitions': [
            {'start': 1, 'size': 10, 'type': '7'},
            {'start': 20, 'size': 70, 'type': 'f'},
            {'start': 21, 'size': 10, 'type': '83'},
        ]}}
        with patch('subprocess.run', return_value=SimpleNamespace(returncode=0, stdout='dos')), patch.object(client, 'output', side_effect=[json.dumps(table), '409600']):
            self.assertEqual(client.snapshot_layout(), [
                {'id': 'p1', 'offset': 4096, 'size': 40960},
                {'id': 'p3', 'offset': 86016, 'size': 40960},
            ])

    def test_rejects_ambiguous_probes_and_out_of_bounds_or_overlapping_partitions(self):
        with patch('subprocess.run', return_value=SimpleNamespace(returncode=8, stdout='TYPE=exfat')):
            with self.assertRaisesRegex(RuntimeError, 'ambiguous'):
                client.probe_filesystem('/dev/test')
            with self.assertRaisesRegex(RuntimeError, 'ambiguous'):
                client.snapshot_layout()
        for parts in ([{'start': 1, 'size': 500}], [{'start': 1, 'size': 10}, {'start': 2, 'size': 10}]):
            table = {'partitiontable': {'label': 'gpt', 'partitions': parts}}
            with self.subTest(parts=parts), patch('subprocess.run', return_value=SimpleNamespace(returncode=0, stdout='gpt')), patch.object(client, 'output', side_effect=[json.dumps(table), '10240']):
                with self.assertRaises(RuntimeError):
                    client.snapshot_layout()

    def test_readers_use_filesystem_specific_options_without_journal_replay(self):
        readers = [
            ('vfat', 'vfat', 'ro,nosuid,nodev,noexec,fmask=0133,dmask=0022'),
            ('exfat', 'exfat', 'ro,nosuid,nodev,noexec,fmask=0133,dmask=0022'),
            ('ntfs', 'ntfs3', 'ro,nosuid,nodev,noexec,fmask=0133,dmask=0022'),
            ('ext2', 'ext2', 'ro,nosuid,nodev,noexec'),
            ('ext3', 'ext4', 'ro,noload,nosuid,nodev,noexec'),
            ('ext4', 'ext4', 'ro,noload,nosuid,nodev,noexec'),
        ]
        for filesystem, driver, options in readers:
            with self.subTest(filesystem=filesystem), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                with patch.object(client, 'BASE', root), patch.object(client, 'LEASE', root / 'lease.json'), patch.object(client, 'SNAP', str(root / 'capture')), patch.object(client, 'EXPORT', root / 'export'), patch.object(client, 'attach_pool'), patch.object(client, 'release'), patch.object(client, 'snapshot_layout', return_value=[{'id': 'disk', 'offset': 0, 'size': 1024}]), patch.object(client, 'probe_filesystem', return_value={'TYPE': filesystem, 'UUID': '1234'}), patch.object(client, 'run') as command, contextlib.redirect_stdout(io.StringIO()):
                    client.open_snapshot()
                command.assert_any_call('mount', '-t', driver, '-o', options, str(root / 'capture'), str(root / 'export/volumes/disk'), stderr=subprocess.PIPE)

    def test_reformat_detection_tracks_uuid_changes_but_not_volume_renames(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            lease_path = root / 'lease.json'
            changes = []
            with patch.object(client, 'BASE', root), patch.object(client, 'LEASE', lease_path), patch.object(client, 'SNAP', str(root / 'capture')), patch.object(client, 'EXPORT', root / 'export'), patch.object(client, 'attach_pool'), patch.object(client, 'release'), patch.object(client, 'snapshot_layout', return_value=[{'id': 'disk', 'offset': 0, 'size': 1024}]), patch.object(client, 'run'), patch('os.path.ismount', return_value=True), contextlib.redirect_stdout(io.StringIO()):
                for uuid, label in [('first', 'Blink'), ('first', 'Renamed'), ('second', 'Renamed')]:
                    with patch.object(client, 'probe_filesystem', return_value={'TYPE': 'exfat', 'UUID': uuid, 'LABEL': label}):
                        client.open_snapshot()
                    lease = json.loads(lease_path.read_text())
                    inventory = client.snapshot_manifest(lease['token'])
                    changes.append(inventory['volume_changes'])
                    lease_path.unlink()
            self.assertEqual(changes[0], [{'volume_id': 'disk', 'kind': 'added'}])
            self.assertEqual(changes[1], [])
            self.assertEqual(changes[2][0]['kind'], 'reformatted')

    def test_opens_reads_and_cleans_multiple_volumes_including_unsupported_volume(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            lease_path = root / 'snapshot.json'
            export = root / 'export'
            layout = [{'id': 'p' + str(n), 'offset': n * 512, 'size': 1024} for n in (1, 2, 3)]
            mounted = set()
            def command(*args, **kwargs):
                if args[0] == 'losetup' and '--find' in args:
                    return SimpleNamespace(stdout='/dev/loop' + args[args.index('--offset') + 1])
                if args[0] == 'mount':
                    mount = Path(args[-1])
                    mounted.add(str(mount))
                    (mount / 'clip.mp4').write_bytes(mount.name.encode())
                    (mount / 'link').symlink_to(root / 'private')
                    os.mkfifo(mount / 'pipe')
                if args[0] == 'umount':
                    mounted.remove(args[1])
                    for p in Path(args[1]).iterdir():
                        p.unlink()
                return SimpleNamespace(stdout='')
            with patch.object(client, 'BASE', root), patch.object(client, 'LEASE', lease_path), patch.object(client, 'EXPORT', export), patch.object(client, 'SNAP', str(root / 'capture')), patch.object(client, 'attach_pool'), patch.object(client, 'snapshot_layout', return_value=layout), patch.object(client, 'probe_filesystem', side_effect=[{'TYPE': 'crypto_LUKS'}, {'TYPE': 'exfat', 'UUID': 'a'}, {'TYPE': 'ext4', 'UUID': 'b'}]), patch.object(client, 'run', side_effect=command) as commands, patch('os.path.ismount', side_effect=lambda p: str(p) in mounted), contextlib.redirect_stdout(io.StringIO()):
                client.open_snapshot()
                inventory = client.snapshot_manifest(json.loads(lease_path.read_text())['token'])
                self.assertEqual([f['name'] for f in inventory['files']], ['volumes/p2/clip.mp4', 'volumes/p3/clip.mp4'])
                self.assertEqual([v['mounted'] for v in inventory['volumes']], [False, True, True])
                self.assertIn('Unsupported', inventory['volumes'][0]['error'])
                self.assertEqual(inventory['files'][0]['source_path'], 'clip.mp4')
                lease = json.loads(lease_path.read_text())
                class Output:
                    buffer = io.BytesIO()
                with patch('sys.stdout', Output()):
                    client.snapshot_read(lease['token'], base64.urlsafe_b64encode(b'volumes/p2/clip.mp4').decode())
                self.assertEqual(Output.buffer.getvalue(), b'p2')
                with self.assertRaisesRegex(RuntimeError, 'regular'):
                    client.snapshot_read(lease['token'], base64.urlsafe_b64encode(b'volumes/p2/pipe').decode())
                client.release(token=lease['token'])
                self.assertFalse(lease_path.exists())
                self.assertFalse(mounted)
                for offset in ('512', '1024', '1536'):
                    commands.assert_any_call('losetup', '-d', '/dev/loop' + offset)
                commands.assert_any_call('blockdev', '--setro', str(root / 'capture'))
                self.assertEqual(inventory['filesystem']['type'], 'multiple')

    def test_detects_reformatted_added_and_removed_volumes(self):
        old = [{'id': 'p1', 'generation': 'old'}, {'id': 'p2', 'generation': 'same'}]
        new = [{'id': 'p1', 'generation': 'new'}, {'id': 'p3', 'generation': 'other'}]
        self.assertEqual(client.volume_changes(new, old), [
            {'volume_id': 'p1', 'kind': 'reformatted', 'previous_generation': 'old'},
            {'volume_id': 'p3', 'kind': 'added'}, {'volume_id': 'p2', 'kind': 'removed'},
        ])
        self.assertEqual(client.volume_changes(old, old), [])

    def test_cleanup_can_resume_after_one_of_multiple_unmounts_fails(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            mounts = [root / 'p1', root / 'p2']
            for mount in mounts:
                mount.mkdir()
            lease = root / 'lease.json'
            lease.write_text(json.dumps({'token': 'test', 'volumes': [
                {'mount': str(mount), 'loop': '/dev/loop' + str(n), 'mounted': True}
                for n, mount in enumerate(mounts, 1)
            ]}))
            mounted = set(map(str, mounts))
            def command(*args):
                if args[0] == 'umount':
                    if args[1].endswith('p1'):
                        raise subprocess.CalledProcessError(32, 'umount')
                    mounted.remove(args[1])
            with patch.object(client, 'LEASE', lease), patch.object(client, 'SNAP', str(root / 'capture')), patch.object(client, 'EXPORT', root / 'export'), patch('os.path.ismount', side_effect=lambda p: str(p) in mounted), patch.object(client, 'run', side_effect=command):
                with self.assertRaises(subprocess.CalledProcessError):
                    client.release('test')
                saved = json.loads(lease.read_text())
                self.assertIsNone(saved['volumes'][1]['loop'])
                self.assertFalse(saved['volumes'][1]['mounted'])
                mounted.clear()
                with patch.object(client, 'run') as retry:
                    client.release('test')
                retry.assert_called_once_with('losetup', '-d', '/dev/loop1')
                self.assertFalse(lease.exists())

    def test_cleanup_retains_lease_when_unmount_fails(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            lease = root / 'lease.json'
            lease.write_text(json.dumps({'token': 'test', 'volumes': [{'mount': str(root / 'p1'), 'loop': '/dev/loop1'}]}))
            with patch.object(client, 'LEASE', lease), patch('os.path.ismount', return_value=True), patch.object(client, 'run', side_effect=subprocess.CalledProcessError(32, 'umount')) as command:
                with self.assertRaises(subprocess.CalledProcessError):
                    client.release('test')
                self.assertTrue(lease.exists())
                command.assert_called_once_with('umount', str(root / 'p1'))


if __name__ == '__main__':
    unittest.main()
