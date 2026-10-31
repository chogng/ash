"""The Windows release verifier cleans up its private service on failed acceptance."""

from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from build.release import verify_remote


class RemoteSshFixtureTests(unittest.TestCase):
    def test_failed_service_start_or_bootstrap_removes_only_the_fixture_service(self):
        for failure in ("start", "bootstrap"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temp:
                fixture = Path(temp) / "ssh"
                fixture.mkdir()
                calls = []

                def run(arguments, **options):
                    calls.append(arguments)
                    if arguments[:2] == ["sc.exe", "start"] and failure == "start":
                        raise subprocess.CalledProcessError(1, arguments)
                    return subprocess.CompletedProcess(
                        arguments, 0, stdout=b"STATE : 1 STOPPED"
                    )

                with (
                    patch.object(
                        verify_remote,
                        "os",
                        SimpleNamespace(name="nt", environ={"SystemRoot": temp}),
                    ),
                    patch.object(verify_remote.subprocess, "run", side_effect=run),
                    (Path(temp) / "log").open("w") as log,
                ):
                    with self.assertRaises(
                        (subprocess.CalledProcessError, RuntimeError)
                    ):
                        with verify_remote.ssh_server(fixture, log):
                            raise RuntimeError("bootstrap failed")
                services = [call[2] for call in calls if call[0] == "sc.exe"]
                self.assertEqual(set(services), {"AshRemoteRelease-" + Path(temp).name})
                self.assertIn(["sc.exe", "stop", services[0]], calls)
                self.assertEqual(calls[-1], ["sc.exe", "delete", services[0]])
