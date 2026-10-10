"""Disk budgets preserve active profiles and Cargo's coherent output groups."""

import os
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from build.lib.cargo_cache import (
    leased_cache,
    profile_from_arguments,
    trim_artifact_cache,
    trim_incremental_cache,
)
from build.lib.file_lock import exclusive_lock, shared_lock


class CargoCacheTests(unittest.TestCase):
    def test_build_entry_keeps_warm_artifacts_without_scanning_even_after_idle(self):
        with tempfile.TemporaryDirectory() as temporary:
            repository = Path(temporary)
            target = repository / ".build/cargo"
            session = self.session(target, "ci-test", "cached", 1)
            marker = target / ".cache-checked"
            marker.touch()
            os.utime(marker, (1, 1))
            with patch(
                "build.lib.cargo_cache._file_stats",
                side_effect=AssertionError("compilation must not wait for cache scans"),
            ):
                for _ in range(2):
                    with leased_cache(repository, profile="ci-test"):
                        self.assertEqual(
                            (session / "state.bin").read_bytes(), b"12345678"
                        )
            self.assertEqual((session / "state.bin").read_bytes(), b"12345678")

    def session(self, root: Path, profile: str, name: str, timestamp: int) -> Path:
        directory = root / profile
        directory.mkdir(parents=True, exist_ok=True)
        (directory / ".cargo-lock").touch()
        session = directory / "incremental" / name
        session.mkdir(parents=True)
        data = session / "state.bin"
        data.write_bytes(b"12345678")
        # Whole seconds keep fixture ordering distinct on Windows filesystems.
        os.utime(data, (timestamp, timestamp))
        os.utime(session, (timestamp, timestamp))
        return session

    def test_artifact_budget_removes_complete_old_profiles_and_keeps_lock_inodes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old = self.session(root, "debug", "old", 1).parent.parent
            current = self.session(
                root, "aarch64/dev-small", "current", 2
            ).parent.parent
            for name in [
                "deps/library.rlib",
                ".fingerprint/library/build",
                "build/library/out",
            ]:
                output = old / name
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_bytes(b"obsolete")
                os.utime(output, (1, 1))
            lock = old / ".cargo-lock"
            inode = lock.stat().st_ino
            self.assertEqual(trim_artifact_cache(root, 8, idle_seconds=0), 32)
            self.assertEqual(
                {p.name for p in old.iterdir()}, {".cargo-lock", ".cache-lease"}
            )
            self.assertEqual(lock.stat().st_ino, inode)
            self.assertTrue((current / "incremental/current/state.bin").exists())

    def test_artifact_budget_preserves_live_builds_and_running_wrapper_leases(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            active = self.session(root, "ci-test", "active", 1)
            running = self.session(root, "dev-small", "running", 2)
            idle = self.session(root, "debug", "idle", 3)
            with (
                exclusive_lock(root / "ci-test/.cargo-lock"),
                shared_lock(root / "dev-small/.cache-lease", create=True),
            ):
                self.assertEqual(trim_artifact_cache(root, 0, idle_seconds=0), 8)
                self.assertTrue(active.exists())
                self.assertTrue(running.exists())
                self.assertFalse(idle.exists())
            self.assertEqual(trim_artifact_cache(root, 0, idle_seconds=0), 16)

    def test_additional_cargo_locks_protect_outputs_and_keep_their_inodes(self):
        for name in (".cargo-build-lock", ".cargo-artifact-lock"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                session = self.session(root, "debug", "old", 1)
                lock = root / "debug" / name
                lock.touch()
                inode = lock.stat().st_ino
                with exclusive_lock(lock):
                    self.assertEqual(trim_artifact_cache(root, 0, idle_seconds=0), 0)
                    self.assertTrue(session.exists())
                self.assertEqual(trim_artifact_cache(root, 0, idle_seconds=0), 8)
                self.assertEqual(lock.stat().st_ino, inode)

    def test_shared_artifact_hard_links_are_counted_once(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            session = self.session(root, "debug", "old", 1)
            os.link(session / "state.bin", root / "debug" / "same-inode.bin")
            self.assertEqual(trim_artifact_cache(root, 8, idle_seconds=0), 0)
            self.assertTrue(session.exists())

    def test_recent_outputs_survive_the_budget_until_publication_can_finish(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old = self.session(root, "ci-test", "old", 1)
            recent = self.session(root, "dev-small", "recent", 2)
            (recent.parent.parent / ".cache-used").touch()
            self.assertEqual(trim_artifact_cache(root, 0), 8)
            self.assertFalse(old.exists())
            self.assertTrue(recent.exists())

    def test_wrapper_lease_covers_cross_target_process_execution_and_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            repository = Path(temporary)
            target = repository / ".build/cargo"
            output = self.session(target, "aarch64/dev-small", "current", 1)
            with self.assertRaisesRegex(RuntimeError, "process failed"):
                with leased_cache(
                    repository, profile="dev-small", target_triple="aarch64"
                ):
                    with exclusive_lock(
                        output.parent.parent / ".cache-lease", blocking=False
                    ) as acquired:
                        self.assertFalse(acquired)
                    self.assertEqual(trim_incremental_cache(target, 0), 0)
                    self.assertEqual(trim_artifact_cache(target, 0, idle_seconds=0), 0)
                    self.assertTrue(output.exists())
                    raise RuntimeError("process failed")
            with exclusive_lock(
                output.parent.parent / ".cache-lease", blocking=False
            ) as acquired:
                self.assertTrue(acquired)

    def test_profile_selection_matches_cargo_profile_directory_names(self):
        for arguments, expected in [
            (["test"], "debug"),
            (["build", "--release"], "release"),
            (["run", "-r"], "release"),
            (["check", "--profile", "dev"], "debug"),
            (["test", "--profile=test"], "debug"),
            (["test", "--profile", "ci-test"], "ci-test"),
            (["bench"], "release"),
            (["build", "--profile=bench"], "release"),
            (["test", "--", "--profile=release"], "debug"),
        ]:
            with self.subTest(arguments=arguments):
                self.assertEqual(profile_from_arguments(arguments), expected)

    def test_old_sessions_are_evicted_across_profiles_without_removing_artifacts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old = self.session(root, "ci-test", "old", 1)
            current = self.session(root, "aarch64/dev-small", "current", 2)
            artifact = root / "ci-test/deps/library.rlib"
            artifact.parent.mkdir()
            artifact.write_bytes(b"keep the reusable dependency")
            self.assertEqual(trim_incremental_cache(root, 8), 8)
            self.assertFalse(old.exists())
            self.assertTrue(current.exists())
            self.assertEqual(artifact.read_bytes(), b"keep the reusable dependency")
            self.assertEqual(trim_incremental_cache(root, 8), 0)

    def test_live_profile_is_not_inspected_or_collected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            active = self.session(root, "ci-test", "active", 1)
            idle = self.session(root, "dev-small", "idle", 2)
            with exclusive_lock(root / "ci-test/.cargo-lock"):
                self.assertEqual(trim_incremental_cache(root, 0), 8)
                self.assertTrue(active.exists())
                self.assertFalse(idle.exists())
            self.assertEqual(trim_incremental_cache(root, 0), 8)
            self.assertFalse(active.exists())

    @unittest.skipIf(os.name == "nt", "symlink creation requires Windows privileges")
    def test_symlinked_targets_and_profiles_do_not_collect_external_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cache, external = root / "cache", root / "external"
            cache.mkdir()
            session = self.session(external, "dev-small", "external", 1)
            (cache / "dev-small").symlink_to(
                external / "dev-small", target_is_directory=True
            )
            self.assertEqual(trim_incremental_cache(cache, 0), 0)
            self.assertEqual(trim_artifact_cache(cache, 0, idle_seconds=0), 0)
            self.assertTrue(session.exists())
            alias = root / "alias"
            alias.symlink_to(external, target_is_directory=True)
            self.assertEqual(trim_incremental_cache(alias, 0), 0)
            self.assertEqual(trim_artifact_cache(alias, 0, idle_seconds=0), 0)
            self.assertTrue(session.exists())


if __name__ == "__main__":
    unittest.main()
