"""Source-lock integrity and the real tgrep build contract."""

import hashlib
import io
import json
import os
import tarfile
import tempfile
import subprocess
import tomllib
import unittest
from pathlib import Path
from unittest.mock import patch

from build.lib import tgrep
from build.lib.tgrep import resolve_tgrep
from build.lib.targets import TARGETS


class TgrepTests(unittest.TestCase):
    def test_locked_patch_keeps_windows_hardening_architecture_compatible(self):
        distribution = Path(__file__).resolve().parents[2] / "third_party/tgrep"
        lock = json.loads((distribution / "runtime-lock.json").read_text())
        source = tgrep._verified_input(distribution, lock["source"])
        runtime_patch = tgrep._verified_input(distribution, lock["patch"])
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            tgrep._extract_source(source, directory)
            environment = dict(
                os.environ, GIT_CEILING_DIRECTORIES=str(directory.parent)
            )
            for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
                environment.pop(name, None)
            subprocess.run(
                ["git", "apply", str(runtime_patch)],
                cwd=directory,
                env=environment,
                check=True,
            )
            with (directory / ".cargo/config.toml").open("rb") as config:
                targets = tomllib.load(config)["target"]
            windows = targets[
                'cfg(all(target_os = "windows", target_arch = "x86_64"))'
            ]["rustflags"]
            arm64 = targets['cfg(all(target_os = "windows", target_arch = "aarch64"))'][
                "rustflags"
            ]
            for flags in (windows, arm64):
                self.assertIn("-Ccontrol-flow-guard", flags)
                self.assertIn("-Ctarget-feature=+crt-static", flags)
                self.assertIn("/DYNAMICBASE", " ".join(flags))
            self.assertIn("/CETCOMPAT", " ".join(windows))
            self.assertNotIn("/CETCOMPAT", " ".join(arm64))

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
                    self.assertFalse(
                        build_directories[-1].is_relative_to(root / "cache")
                    )
                    target = (
                        Path(kwargs["env"]["CARGO_TARGET_DIR"])
                        / "aarch64-apple-darwin/release/tgrep"
                    )
                    target.parent.mkdir(parents=True)
                    target.write_bytes(b"built search engine")

            with (
                patch("build.lib.tgrep.subprocess.run", side_effect=run),
                patch(
                    "build.lib.tgrep.subprocess.check_output",
                    return_value="toolchain",
                ),
                patch("build.lib.tgrep.default_target", return_value="other-target"),
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

    def test_release_profile_overrides_caller_and_participates_in_cache_identity(self):
        for target in (
            "x86_64-unknown-linux-gnu",
            "x86_64-pc-windows-msvc",
            "aarch64-apple-darwin",
        ):
            with (
                self.subTest(target=target),
                tempfile.TemporaryDirectory() as temporary,
            ):
                root = Path(temporary)
                lock = self.fixture(root)
                data = json.loads(lock.read_text())
                data["targets"] = [target]
                lock.write_text(json.dumps(data))
                spec = TARGETS[target]
                profiles = []

                def run(command, **kwargs):
                    if command[1] == "build":
                        environment = kwargs["env"]
                        profiles.append(
                            (
                                environment["CARGO_PROFILE_RELEASE_DEBUG"],
                                environment["CARGO_PROFILE_RELEASE_STRIP"],
                            )
                        )
                        output = (
                            Path(environment["CARGO_TARGET_DIR"])
                            / target
                            / "release"
                            / ("tgrep" + spec.executable_suffix)
                        )
                        output.parent.mkdir(parents=True)
                        output.write_bytes(b"search engine")

                with (
                    patch.dict(
                        os.environ,
                        CARGO_PROFILE_RELEASE_DEBUG="2",
                        CARGO_PROFILE_RELEASE_STRIP="none",
                    ),
                    patch.object(tgrep.subprocess, "run", side_effect=run),
                    patch.object(
                        tgrep.subprocess, "check_output", return_value="toolchain"
                    ),
                    patch.object(tgrep, "default_target", return_value="other-target"),
                ):
                    stripped = resolve_tgrep(spec, lock, root / "cache")
                    reused = resolve_tgrep(spec, lock, root / "cache")
                    with patch.object(
                        tgrep, "_RELEASE_PROFILE", {"debug": "0", "strip": "none"}
                    ):
                        unstripped = resolve_tgrep(spec, lock, root / "cache")
                self.assertEqual(stripped, reused)
                self.assertNotEqual(stripped.executable, unstripped.executable)
                self.assertEqual(profiles, [("0", "symbols"), ("0", "none")])

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
                patch("build.lib.tgrep.subprocess.run", side_effect=run),
                patch(
                    "build.lib.tgrep.subprocess.check_output",
                    return_value="toolchain",
                ),
                patch("build.lib.tgrep.default_target", return_value="other-target"),
            ):
                first = resolve_tgrep(
                    TARGETS["aarch64-apple-darwin"], lock, root / "cache"
                )
                legacy = first.executable.parent / "target"
                legacy.mkdir()
                (legacy / "old.rlib").write_bytes(b"compiler cache")
                with patch(
                    "build.lib.tgrep.subprocess.run",
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
            temporary_directory = tempfile.TemporaryDirectory
            (root / "cache").mkdir()

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
                patch(
                    "build.lib.tgrep.tempfile.TemporaryDirectory",
                    side_effect=lambda **kwargs: temporary_directory(
                        dir=root / "cache", **kwargs
                    ),
                ),
                patch("build.lib.tgrep.subprocess.run", side_effect=run),
                patch(
                    "build.lib.tgrep.subprocess.check_output",
                    return_value="toolchain",
                ),
                patch("build.lib.tgrep.default_target", return_value="other-target"),
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
                patch("build.lib.tgrep.subprocess.run", side_effect=run),
                patch(
                    "build.lib.tgrep.subprocess.check_output",
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
                    "build.lib.tgrep.subprocess.run",
                    side_effect=AssertionError("unexpected build"),
                ):
                    with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
                        resolve_tgrep(
                            TARGETS["aarch64-apple-darwin"], lock, root / "cache"
                        )

    def test_shared_sources_are_verified_injected_and_part_of_cache_identity(self):
        for name in ("ranking", "discovery"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                lock = self.fixture(root)
                ranking = root / f"{name}.rs"
                ranking.write_text("pub fn rank() {}\n")
                data = json.loads(lock.read_text())
                data[name] = {
                    "file": ranking.name,
                    "sha256": hashlib.sha256(ranking.read_bytes()).hexdigest(),
                }
                lock.write_text(json.dumps(data))
                builds = []

                def run(command, **kwargs):
                    if command[1] == "build":
                        source = Path(kwargs["cwd"]) / f"tgrep-cli/src/ash_{name}.rs"
                        builds.append(source.read_bytes())
                        target = Path(kwargs["env"]["CARGO_TARGET_DIR"])
                        executable = target / "aarch64-apple-darwin/release/tgrep"
                        executable.parent.mkdir(parents=True)
                        executable.write_bytes(source.read_bytes())
                    elif command[1] == "apply" and "--check" not in command:
                        (Path(kwargs["cwd"]) / "tgrep-cli/src").mkdir(parents=True)

                with (
                    patch("build.lib.tgrep.subprocess.run", side_effect=run),
                    patch(
                        "build.lib.tgrep.subprocess.check_output",
                        return_value="toolchain",
                    ),
                    patch(
                        "build.lib.tgrep.default_target", return_value="other-target"
                    ),
                ):
                    first = resolve_tgrep(
                        TARGETS["aarch64-apple-darwin"], lock, root / "cache"
                    )
                    ranking.write_text("pub fn rank() { /* updated */ }\n")
                    with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
                        resolve_tgrep(
                            TARGETS["aarch64-apple-darwin"], lock, root / "cache"
                        )
                    data[name]["sha256"] = hashlib.sha256(
                        ranking.read_bytes()
                    ).hexdigest()
                    lock.write_text(json.dumps(data))
                    second = resolve_tgrep(
                        TARGETS["aarch64-apple-darwin"], lock, root / "cache"
                    )
                self.assertNotEqual(first.executable, second.executable)
                self.assertEqual(len(builds), 2)
                self.assertEqual(second.executable.read_bytes(), ranking.read_bytes())

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
                "build.lib.tgrep.subprocess.check_output", return_value="toolchain"
            ):
                with self.assertRaisesRegex(
                    RuntimeError, "Invalid tgrep source archive"
                ):
                    resolve_tgrep(TARGETS["aarch64-apple-darwin"], lock, root / "cache")
            self.assertFalse((root / "outside").exists())
