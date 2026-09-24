"""Locked media server resolution without a network dependency."""

import hashlib
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from build.ash_rs.livekit import resolve_livekit


class LivekitTests(unittest.TestCase):
    def test_verified_archive_extracts_only_the_server(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cache = root / "third_party/.cache/livekit/1.0"
            cache.mkdir(parents=True)
            archive = cache / "server.zip"
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr("livekit-server.exe", b"server")
                output.writestr("unrelated.txt", b"unrelated")
            lock = {
                "version": "1.0",
                "artifacts": {
                    "x86_64-pc-windows-msvc": {
                        "url": "https://example.com/server.zip",
                        "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                        "archive": archive.name,
                    },
                },
            }
            lock_path = root / "third_party/livekit/runtime-lock.json"
            lock_path.parent.mkdir(parents=True)
            lock_path.write_text(json.dumps(lock))
            with patch(
                "build.ash_rs.livekit.download_and_verify",
                side_effect=AssertionError("unexpected download"),
            ):
                executable = resolve_livekit("x86_64-pc-windows-msvc", root=root)
            self.assertEqual(b"server", executable.read_bytes())
            self.assertFalse((executable.parent / "unrelated.txt").exists())

    def test_unlocked_target_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            lock = root / "third_party/livekit/runtime-lock.json"
            lock.parent.mkdir(parents=True)
            lock.write_text(json.dumps({"version": "1.0", "artifacts": {}}))
            with self.assertRaisesRegex(RuntimeError, "No media server build"):
                resolve_livekit("unsupported", root=root)
