"""The SSH preflight drives the native regression with an isolated child environment."""

from contextlib import nullcontext
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from build.release import verify_windows_installer


class WindowsInstallerPreflightTests(unittest.TestCase):
    def test_native_regression_uses_the_fixture_client_and_a_bounded_timeout(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            ssh = root / "private-ssh.exe"
            reports = root / "reports"
            previous = os.environ.get("ASH_REMOTE_INSTALLER_TEST_SSH")
            with (
                patch.object(
                    verify_windows_installer,
                    "remote_fixture_directory",
                    return_value=nullcontext(str(root)),
                ),
                patch.object(
                    verify_windows_installer,
                    "ssh_fixture",
                    return_value=nullcontext(ssh),
                ),
                patch.object(verify_windows_installer.subprocess, "run") as run,
            ):
                verify_windows_installer.verify("aarch64-pc-windows-msvc", reports)
            args, options = run.call_args
            self.assertIn("aarch64-pc-windows-msvc", args[0])
            self.assertIn("--exact", args[0])
            self.assertEqual(options["env"]["ASH_REMOTE_INSTALLER_TEST_SSH"], str(ssh))
            self.assertTrue(options["check"])
            self.assertEqual(options["timeout"], 300)
            self.assertEqual(os.environ.get("ASH_REMOTE_INSTALLER_TEST_SSH"), previous)
            report = json.loads((reports / "report.json").read_text())
            self.assertEqual(report["transport"], "OpenSSH")
            self.assertEqual(report["binaryFixtureBytes"], 8 * 1024 * 1024)
