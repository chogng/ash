"""Remote fixture cleanup waits only for transient Windows executable locks."""

from types import SimpleNamespace
import os
from pathlib import Path
import shutil
import subprocess
import unittest
from unittest.mock import Mock, patch

from build import remote_smoke


class RemoteFixtureCleanupTests(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "Windows executable mapping semantics")
    def test_cleanup_waits_for_a_real_windows_executable_mapping(self):
        child = None
        try:
            with remote_smoke.remote_fixture_directory(prefix="ash-cleanup-") as name:
                root = Path(name)
                executable = root / "running.exe"
                shutil.copyfile(
                    Path(os.environ["SystemRoot"]) / "System32/cmd.exe", executable
                )
                child = subprocess.Popen(
                    [
                        str(executable),
                        "/d",
                        "/c",
                        "echo READY & ping -n 3 127.0.0.1 >nul",
                    ],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                )
                self.assertEqual(child.stdout.readline().strip(), b"READY")
                self.assertIsNone(child.poll())
                with self.assertRaises(PermissionError):
                    executable.unlink()
            self.assertFalse(root.exists())
            self.assertEqual(child.wait(timeout=10), 0)
        finally:
            if child is not None:
                if child.poll() is None:
                    child.kill()
                child.wait(timeout=10)
                child.stdout.close()

    def test_windows_retries_until_the_stopped_executable_is_released(self):
        temporary = SimpleNamespace(
            name="fixture", cleanup=Mock(side_effect=[PermissionError(), None])
        )
        with (
            patch.object(
                remote_smoke.tempfile, "TemporaryDirectory", return_value=temporary
            ),
            patch.object(remote_smoke, "os", SimpleNamespace(name="nt")),
            patch.object(remote_smoke.time, "monotonic", return_value=0),
            patch.object(remote_smoke.time, "sleep") as sleep,
        ):
            with remote_smoke.remote_fixture_directory(prefix="test-") as fixture:
                self.assertEqual(fixture, "fixture")
        self.assertEqual(temporary.cleanup.call_count, 2)
        sleep.assert_called_once_with(0.1)

    def test_persistent_locks_and_non_windows_permission_errors_still_fail(self):
        for platform in ("nt", "posix"):
            with self.subTest(platform=platform):
                temporary = SimpleNamespace(
                    name="fixture", cleanup=Mock(side_effect=PermissionError())
                )
                with (
                    patch.object(
                        remote_smoke.tempfile,
                        "TemporaryDirectory",
                        return_value=temporary,
                    ),
                    patch.object(remote_smoke, "os", SimpleNamespace(name=platform)),
                    patch.object(remote_smoke.time, "monotonic", side_effect=[0, 11]),
                    patch.object(remote_smoke.time, "sleep") as sleep,
                    self.assertRaises(PermissionError),
                ):
                    with remote_smoke.remote_fixture_directory(prefix="test-"):
                        pass
                temporary.cleanup.assert_called_once()
                sleep.assert_not_called()

    def test_cleanup_preserves_an_acceptance_failure(self):
        temporary = SimpleNamespace(name="fixture", cleanup=Mock())
        with (
            patch.object(
                remote_smoke.tempfile, "TemporaryDirectory", return_value=temporary
            ),
            self.assertRaisesRegex(RuntimeError, "acceptance failed"),
        ):
            with remote_smoke.remote_fixture_directory(prefix="test-"):
                raise RuntimeError("acceptance failed")
        temporary.cleanup.assert_called_once()

    def test_persistent_windows_lock_is_reported_and_still_raises(self):
        temporary = SimpleNamespace(
            name="fixture",
            cleanup=Mock(side_effect=PermissionError(13, "locked", "fixture.exe")),
        )
        with (
            patch.object(
                remote_smoke.tempfile, "TemporaryDirectory", return_value=temporary
            ),
            patch.object(remote_smoke, "os", SimpleNamespace(name="nt")),
            patch.object(remote_smoke.time, "monotonic", side_effect=[0, 11]),
            patch.object(remote_smoke, "_record_windows_executable_lock") as diagnostic,
            self.assertRaises(PermissionError),
        ):
            with remote_smoke.remote_fixture_directory(prefix="test-"):
                pass
        diagnostic.assert_called_once_with("fixture.exe")
