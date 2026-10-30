"""Integrity and extraction boundaries for the bundled standalone adapter."""

import hashlib
import io
import os
import stat
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from build.lib import js_debug


class RuntimeTests(unittest.TestCase):
    def fixture(self, root, extra=(), adapter=None):
        archive = (
            root / ".build/downloads/js-debug" / js_debug.VERSION / "js-debug.tar.gz"
        )
        archive.parent.mkdir(parents=True)
        with tarfile.open(archive, "w:gz") as output:
            for name, content in [
                ("js-debug/LICENSE", b"MIT"),
                (
                    "js-debug/src/dapDebugServer.js",
                    js_debug._UNKNOWN_SESSION.encode() if adapter is None else adapter,
                ),
                *extra,
            ]:
                member = tarfile.TarInfo(name)
                member.size = len(content)
                output.addfile(member, io.BytesIO(content))
        source = root / "extensions/debug-javascript/src"
        source.mkdir(parents=True)
        for name in ("auto-attach.cjs", "adapter-runtime.cjs"):
            (source / name).write_text(name)
        artifact = SimpleNamespace(
            size=archive.stat().st_size,
            sha256=hashlib.sha256(archive.read_bytes()).hexdigest(),
            url="https://example.invalid/pinned.tar.gz",
        )
        return archive, artifact

    def test_verified_runtime_keeps_license_and_readable_regular_resources(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            _, artifact = self.fixture(root)
            destination = root / "package/runtime"
            with (
                patch.object(js_debug, "Artifact", return_value=artifact),
                patch.object(js_debug, "download_and_verify") as download,
            ):
                js_debug.copy_runtime(root, destination)
                download.assert_not_called()
            self.assertEqual((destination / "LICENSE").read_text(), "MIT")
            adapter = destination / "src/dapDebugServer.js"
            self.assertEqual(adapter.read_text(), js_debug._EARLY_WORKER_EVENT)
            self.assertTrue(stat.S_ISREG(adapter.stat().st_mode))
            # Windows chmod exposes the read-only flag, rather than POSIX group/other bits.
            if os.name != "nt":
                self.assertEqual(stat.S_IMODE(adapter.stat().st_mode), 0o644)
            self.assertEqual(
                (destination.parent / "src/auto-attach.cjs").read_text(),
                "auto-attach.cjs",
            )

    def test_corrupt_cache_cannot_be_used_as_runtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive, artifact = self.fixture(root)
            archive.write_bytes(b"corrupt")
            with (
                patch.object(js_debug, "Artifact", return_value=artifact),
                patch.object(
                    js_debug,
                    "download_and_verify",
                    side_effect=RuntimeError("digest mismatch"),
                ),
            ):
                with self.assertRaisesRegex(RuntimeError, "digest mismatch"):
                    js_debug.copy_runtime(root, root / "package/runtime")
            self.assertFalse((root / "package/runtime").exists())

    def test_early_worker_patch_rejects_changed_or_duplicate_upstream_code(self):
        for content in [b"// changed adapter", js_debug._UNKNOWN_SESSION.encode() * 2]:
            with (
                self.subTest(content=content),
                tempfile.TemporaryDirectory() as temporary,
            ):
                root = Path(temporary)
                _, artifact = self.fixture(root, adapter=content)
                with patch.object(js_debug, "Artifact", return_value=artifact):
                    with self.assertRaisesRegex(
                        RuntimeError, "early-worker patch no longer matches"
                    ):
                        js_debug.copy_runtime(root, root / "package/runtime")

    def test_runtime_upgrade_requires_reviewing_the_compatibility_patch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with patch.object(js_debug, "VERSION", "new-version"):
                with self.assertRaisesRegex(
                    RuntimeError, "early-worker patch requires review"
                ):
                    js_debug.copy_runtime(root, root / "package/runtime")

    def test_escaping_or_duplicate_members_are_rejected(self):
        for extra in [
            [("js-debug/../../outside", b"bad")],
            [("js-debug/LICENSE", b"duplicate")],
        ]:
            with self.subTest(extra=extra), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                _, artifact = self.fixture(root, extra)
                with patch.object(js_debug, "Artifact", return_value=artifact):
                    with self.assertRaisesRegex(RuntimeError, "Invalid"):
                        js_debug.copy_runtime(root, root / "package/runtime")
                self.assertFalse((root / "outside").exists())
