"""Source-lock integrity and the real tgrep build contract."""

import hashlib
import io
import json
import tarfile
import tempfile
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

from build.ash_rs.tgrep import resolve_tgrep
from build.lib.targets import TARGETS


class TgrepTests(unittest.TestCase):
    def fixture(self, root):
        source = root / "source.tar.gz"
        with tarfile.open(source, "w:gz") as output:
            member = tarfile.TarInfo("Cargo.toml")
            content = b"[workspace]\n"
            member.size = len(content)
            output.addfile(member, io.BytesIO(content))
        patch_file = root / "engine.patch"
        patch_file.write_text("patch")
        lock = {
            "schemaVersion": 2,
            "runtime": "tgrep",
            "version": "test",
            "targets": ["aarch64-apple-darwin"],
            "source": {
                "file": source.name,
                "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            },
            "patch": {
                "file": patch_file.name,
                "sha256": hashlib.sha256(patch_file.read_bytes()).hexdigest(),
            },
        }
        path = root / "runtime-lock.json"
        path.write_text(json.dumps(lock))
        return path

    def test_source_build_is_locked_patched_and_reused_by_digest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            lock = self.fixture(root)
            commands = []
            build_directories = []

            def run(command, **kwargs):
                commands.append(command)
                if command[1] == "build":
                    build_directories.append(Path(kwargs["cwd"]))
                    self.assertFalse(build_directories[-1].is_relative_to(root / "cache"))
                    target = (
                        Path(kwargs["env"]["CARGO_TARGET_DIR"])
                        / "aarch64-apple-darwin/release/tgrep"
                    )
                    target.parent.mkdir(parents=True)
                    target.write_bytes(b"built search engine")

            with (
                patch("build.ash_rs.tgrep.subprocess.run", side_effect=run),
                patch(
                    "build.ash_rs.tgrep.subprocess.check_output",
                    return_value="toolchain",
                ),
                patch("build.ash_rs.tgrep.default_target", return_value="other-target"),
            ):
                first = resolve_tgrep(
                    TARGETS["aarch64-apple-darwin"], lock, root / "cache"
                )
                second = resolve_tgrep(
                    TARGETS["aarch64-apple-darwin"], lock, root / "cache"
                )
            self.assertEqual(first, second)
            self.assertEqual(first.source, "locked-source")
            self.assertEqual(commands[0][:3], ["git", "apply", "--check"])
            self.assertIn("--locked", commands[2])
            self.assertEqual(len(commands), 3)
            self.assertFalse(build_directories[0].exists())
            self.assertEqual(
                {path.name for path in first.executable.parent.iterdir()},
                {"tgrep", "build.json", ".build.lock"},
            )

    def test_reusing_a_published_binary_collects_legacy_compiler_outputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            lock = self.fixture(root)

            def run(command, **kwargs):
                if command[1] == "build":
                    target = Path(kwargs["env"]["CARGO_TARGET_DIR"])
                    executable = target / "aarch64-apple-darwin/release/tgrep"
                    executable.parent.mkdir(parents=True)
                    executable.write_bytes(b"published engine")

            with (
                patch("build.ash_rs.tgrep.subprocess.run", side_effect=run),
                patch(
                    "build.ash_rs.tgrep.subprocess.check_output",
                    return_value="toolchain",
                ),
                patch("build.ash_rs.tgrep.default_target", return_value="other-target"),
            ):
                first = resolve_tgrep(
                    TARGETS["aarch64-apple-darwin"], lock, root / "cache"
                )
                legacy = first.executable.parent / "target"
                legacy.mkdir()
                (legacy / "old.rlib").write_bytes(b"compiler cache")
                with patch(
                    "build.ash_rs.tgrep.subprocess.run",
                    side_effect=AssertionError("unexpected rebuild"),
                ):
                    repeated = resolve_tgrep(
                        TARGETS["aarch64-apple-darwin"], lock, root / "cache"
                    )
            self.assertEqual(first, repeated)
            self.assertFalse(legacy.exists())
            self.assertEqual(first.executable.read_bytes(), b"published engine")

    def test_patch_is_applied_inside_an_ignored_parent_checkout(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            (root / ".gitignore").write_text("cache/\n")
            lock = self.fixture(root)
            patch_file = root / "engine.patch"
            patch_file.write_text(
                'diff --git a/Cargo.toml b/Cargo.toml\n--- a/Cargo.toml\n+++ b/Cargo.toml\n@@ -1 +1,2 @@\n [workspace]\n+resolver = "2"\n',
                newline="\n",
            )
            data = json.loads(lock.read_text())
            data["patch"]["sha256"] = hashlib.sha256(
                patch_file.read_bytes()
            ).hexdigest()
            lock.write_text(json.dumps(data))
            original_run = subprocess.run

            def run(command, **kwargs):
                if command[0] == "git":
                    return original_run(command, **kwargs)
                self.assertIn(
                    'resolver = "2"', (Path(kwargs["cwd"]) / "Cargo.toml").read_text()
                )
                output = (
                    Path(kwargs["env"]["CARGO_TARGET_DIR"])
                    / "aarch64-apple-darwin/release/tgrep"
                )
                output.parent.mkdir(parents=True)
                output.write_bytes(b"compiled patched source")

            with (
                patch("build.ash_rs.tgrep.subprocess.run", side_effect=run),
                patch(
                    "build.ash_rs.tgrep.subprocess.check_output",
                    return_value="toolchain",
                ),
                patch("build.ash_rs.tgrep.default_target", return_value="other-target"),
            ):
                result = resolve_tgrep(
                    TARGETS["aarch64-apple-darwin"], lock, root / "cache"
                )
            self.assertEqual(result.executable.read_bytes(), b"compiled patched source")

    def test_failed_build_removes_partial_sources_and_compiler_outputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            lock = self.fixture(root)

            def run(command, **kwargs):
                if command[1] == "build":
                    target = Path(kwargs["env"]["CARGO_TARGET_DIR"])
                    target.mkdir()
                    (target / "partial.rlib").write_bytes(b"unfinished build")
                    raise subprocess.CalledProcessError(1, command)

            with (
                patch("build.ash_rs.tgrep.subprocess.run", side_effect=run),
                patch(
                    "build.ash_rs.tgrep.subprocess.check_output",
                    return_value="toolchain",
                ),
            ):
                with self.assertRaises(subprocess.CalledProcessError):
                    resolve_tgrep(TARGETS["aarch64-apple-darwin"], lock, root / "cache")
            cache = next((root / "cache/test").iterdir())
            self.assertEqual({path.name for path in cache.iterdir()}, {".build.lock"})

    def test_source_or_patch_corruption_is_rejected_before_compiling(self):
        for filename in ("source.tar.gz", "engine.patch"):
            with (
                self.subTest(filename=filename),
                tempfile.TemporaryDirectory() as temporary,
            ):
                root = Path(temporary)
                lock = self.fixture(root)
                (root / filename).write_bytes(b"corrupt")
                with patch(
                    "build.ash_rs.tgrep.subprocess.run",
                    side_effect=AssertionError("unexpected build"),
                ):
                    with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
                        resolve_tgrep(
                            TARGETS["aarch64-apple-darwin"], lock, root / "cache"
                        )

    def test_archive_path_escape_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            lock = self.fixture(root)
            source = root / "source.tar.gz"
            with tarfile.open(source, "w:gz") as output:
                member = tarfile.TarInfo("../outside")
                member.size = 1
                output.addfile(member, io.BytesIO(b"x"))
            data = json.loads(lock.read_text())
            data["source"]["sha256"] = hashlib.sha256(source.read_bytes()).hexdigest()
            lock.write_text(json.dumps(data))
            with patch(
                "build.ash_rs.tgrep.subprocess.check_output", return_value="toolchain"
            ):
                with self.assertRaisesRegex(
                    RuntimeError, "Invalid tgrep source archive"
                ):
                    resolve_tgrep(TARGETS["aarch64-apple-darwin"], lock, root / "cache")
            self.assertFalse((root / "outside").exists())
