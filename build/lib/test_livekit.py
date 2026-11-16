"""Locked media server resolution without a network dependency."""

import hashlib
import io
import json
import os
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from build.lib.livekit import ROOT, resolve_livekit
from build.lib.targets import TARGETS


def write_fixture(root, target):
    name = "livekit-server.exe" if "windows" in target else "livekit-server"
    archive = root / "third_party/.cache/livekit/1.0.0/server.zip"
    archive.parent.mkdir(parents=True)
    with zipfile.ZipFile(archive, "w") as output:
        output.writestr(name, b"verified server")
        output.writestr("unrelated.txt", b"unrelated")
    key = target.removesuffix("-musl") + "-gnu" if target.endswith("-musl") else target
    lock = {
        "schemaVersion": 1,
        "runtime": "livekit",
        "version": "1.0.0",
        "artifacts": {
            key: {
                "url": "https://example.test/server.zip",
                "archive": archive.name,
                "size": archive.stat().st_size,
                "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
            }
        },
    }
    path = root / "third_party/livekit/runtime-lock.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(lock), encoding="utf-8")
    return archive, path, lock


class LivekitTests(unittest.TestCase):
    def test_every_product_target_uses_a_locked_binary_without_a_build_host(self):
        for target in TARGETS:
            with (
                self.subTest(target=target),
                tempfile.TemporaryDirectory() as temporary,
            ):
                root = Path(temporary)
                write_fixture(root, target)
                with patch(
                    "build.lib.livekit.download_and_verify",
                    side_effect=AssertionError("Archive is already verified"),
                ):
                    binary = resolve_livekit(target, root=root)
                    self.assertEqual(binary.read_bytes(), b"verified server")
                    self.assertFalse((binary.parent / "unrelated.txt").exists())
                    os.utime(binary, ns=(1_000_000_000, 1_000_000_000))
                    previous = binary.stat()
                    resolve_livekit(target, root=root)
                    self.assertEqual(binary.stat().st_mtime_ns, previous.st_mtime_ns)
                    binary.write_bytes(b"damaged executable")
                    resolve_livekit(target, root=root)
                    self.assertEqual(binary.read_bytes(), b"verified server")

    def test_missing_or_corrupt_archive_is_downloaded_with_the_locked_size(self):
        for damage in ("missing", "size", "digest"):
            with (
                self.subTest(damage=damage),
                tempfile.TemporaryDirectory() as temporary,
            ):
                root = Path(temporary)
                target = "x86_64-pc-windows-msvc"
                archive, _, _ = write_fixture(root, target)
                verified = archive.read_bytes()
                if damage == "missing":
                    archive.unlink()
                elif damage == "size":
                    archive.write_bytes(verified + b"tampered")
                else:
                    archive.write_bytes(b"x" * len(verified))
                with patch(
                    "build.download.artifacts.urlopen",
                    return_value=io.BytesIO(verified),
                ) as download:
                    binary = resolve_livekit(target, root=root)
                self.assertEqual(binary.read_bytes(), b"verified server")
                self.assertEqual(archive.read_bytes(), verified)
                download.assert_called_once()

    def test_wrong_size_cannot_reuse_or_download_an_archive_with_the_right_hash(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = "aarch64-apple-darwin"
            archive, path, lock = write_fixture(root, target)
            lock["artifacts"][target]["size"] += 1
            path.write_text(json.dumps(lock))
            with patch(
                "build.download.artifacts.urlopen",
                return_value=io.BytesIO(archive.read_bytes()),
            ):
                with self.assertRaisesRegex(RuntimeError, "locked size or SHA-256"):
                    resolve_livekit(target, root=root)
            self.assertFalse((archive.parent / target / "livekit-server").exists())

    def test_missing_artifacts_never_fall_back_to_source_builds(self):
        for target in ("aarch64-apple-darwin", "x86_64-apple-darwin", "unsupported"):
            with (
                self.subTest(target=target),
                tempfile.TemporaryDirectory() as temporary,
            ):
                root = Path(temporary)
                _, path, lock = write_fixture(root, "aarch64-apple-darwin")
                lock["artifacts"] = {}
                lock["source"] = {"url": "https://example.test/source.tar.gz"}
                path.write_text(json.dumps(lock))
                with patch(
                    "build.download.artifacts.urlopen",
                    side_effect=AssertionError(
                        "Missing artifacts must fail before I/O"
                    ),
                ):
                    with self.assertRaisesRegex(
                        RuntimeError, "No media server artifact"
                    ):
                        resolve_livekit(target, root=root)

    def test_invalid_artifact_metadata_is_rejected_before_io(self):
        for field, value in (
            ("size", None),
            ("size", True),
            ("size", 0),
            ("size", 128 * 1024 * 1024 + 1),
            ("sha256", "invalid"),
            ("archive", "../server.zip"),
            ("url", "http://example.test/server.zip"),
            ("url", "https://user:secret@example.test/server.zip"),
        ):
            with (
                self.subTest(field=field, value=value),
                tempfile.TemporaryDirectory() as temporary,
            ):
                root = Path(temporary)
                target = "aarch64-apple-darwin"
                _, path, lock = write_fixture(root, target)
                lock["artifacts"][target][field] = value
                path.write_text(json.dumps(lock))
                with self.assertRaises(RuntimeError):
                    resolve_livekit(target, root=root)

    def test_repository_lock_covers_every_product_target(self):
        lock = json.loads((ROOT / "third_party/livekit/runtime-lock.json").read_text())
        for target in TARGETS:
            key = (
                target.removesuffix("-musl") + "-gnu"
                if target.endswith("-musl")
                else target
            )
            with self.subTest(target=target):
                self.assertIn(key, lock["artifacts"])
