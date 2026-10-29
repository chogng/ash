"""Locked media server resolution without a network dependency."""

import hashlib
import json
import os
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from build.lib.livekit import resolve_livekit


class LivekitTests(unittest.TestCase):
    def test_macos_requires_go_before_downloading_source(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            lock_path = root / "third_party/livekit/runtime-lock.json"
            lock_path.parent.mkdir(parents=True)
            lock_path.write_text(
                json.dumps(
                    {
                        "version": "1.0",
                        "artifacts": {},
                        "source": {
                            "url": "https://example.invalid/source.tar.gz",
                            "sha256": "0" * 64,
                        },
                    }
                )
            )
            with (
                patch("build.lib.livekit.sys.platform", "darwin"),
                patch("build.lib.livekit.shutil.which", return_value=None),
                patch(
                    "build.lib.livekit.download_and_verify",
                    side_effect=AssertionError("unexpected download"),
                ),
            ):
                with self.assertRaisesRegex(RuntimeError, "requires Go 1.26"):
                    resolve_livekit("aarch64-apple-darwin", root=root)

    def test_source_build_preserves_identical_output_and_publishes_changes(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cache = root / "third_party/.cache/livekit/1.0"
            cache.mkdir(parents=True)
            archive = cache / "source.tar.gz"
            archive.write_bytes(b"source archive")
            lock = root / "third_party/livekit/runtime-lock.json"
            lock.parent.mkdir(parents=True, exist_ok=True)
            lock.write_text(
                json.dumps(
                    {
                        "version": "1.0",
                        "artifacts": {},
                        "source": {
                            "url": "https://example.test/source.tar.gz",
                            "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                        },
                    }
                )
            )
            commands = []
            seeded_outputs = []
            built_bytes = b"compact server"
            fail_build = False

            def run(command, **kwargs):
                commands.append(command)
                if command[0] == "tar":
                    (Path(command[-1]) / "livekit-1.0").mkdir()
                else:
                    self.assertIn("-ldflags=-s -w", command)
                    output = Path(command[command.index("-o") + 1])
                    seeded_outputs.append(
                        output.read_bytes() if output.exists() else None
                    )
                    output.write_bytes(built_bytes)
                    if fail_build:
                        raise subprocess.CalledProcessError(1, command)

            with (
                patch("build.lib.livekit.sys.platform", "darwin"),
                patch("build.lib.livekit.shutil.which", return_value="go"),
                patch("build.lib.livekit.subprocess.run", side_effect=run),
            ):
                binary = resolve_livekit("aarch64-apple-darwin", root=root)
                self.assertEqual(built_bytes, binary.read_bytes())
                self.assertEqual(2, len(commands))
                os.utime(binary, ns=(1_000_000_000, 1_000_000_000))
                previous = binary.stat()

                resolve_livekit("aarch64-apple-darwin", root=root)
                self.assertEqual(previous.st_mtime_ns, binary.stat().st_mtime_ns)
                self.assertEqual(previous.st_ino, binary.stat().st_ino)
                self.assertEqual(4, len(commands))
                self.assertEqual([None, built_bytes], seeded_outputs)

                built_bytes = b"updated server"
                resolve_livekit("aarch64-apple-darwin", root=root)
                self.assertEqual(built_bytes, binary.read_bytes())
                self.assertEqual(0o755, binary.stat().st_mode & 0o777)
                self.assertEqual(b"compact server", seeded_outputs[-1])

                binary.write_bytes(b"damaged server")
                resolve_livekit("aarch64-apple-darwin", root=root)
                self.assertEqual(built_bytes, binary.read_bytes())
                self.assertIsNone(seeded_outputs[-1])

                receipt = binary.with_suffix(".sha256")
                for damaged_receipt in (b"invalid", b"\xff"):
                    receipt.write_bytes(damaged_receipt)
                    resolve_livekit("aarch64-apple-darwin", root=root)
                    self.assertIsNone(seeded_outputs[-1])
                receipt.unlink()
                resolve_livekit("aarch64-apple-darwin", root=root)
                self.assertIsNone(seeded_outputs[-1])

                previous_receipt = receipt.read_bytes()
                fail_build = True
                built_bytes = b"incomplete server"
                with self.assertRaises(subprocess.CalledProcessError):
                    resolve_livekit("aarch64-apple-darwin", root=root)
                self.assertEqual(b"updated server", binary.read_bytes())
                self.assertEqual(previous_receipt, receipt.read_bytes())

                fail_build = False
                built_bytes = b"recovered server"
                binary.unlink()
                resolve_livekit("aarch64-apple-darwin", root=root)
                self.assertIsNone(seeded_outputs[-1])
                self.assertEqual(built_bytes, binary.read_bytes())

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
                "build.lib.livekit.download_and_verify",
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
