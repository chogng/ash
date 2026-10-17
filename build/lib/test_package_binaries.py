import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from build.lib import package_binaries
from build.lib.targets import TARGETS


class BinaryIsolationTests(unittest.TestCase):
    def test_local_host_features_never_enter_core_build(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            names = [
                "ash-app-server",
                "ash-livekit-client",
                "ash-realtime-voice",
                "ash-voice-host",
            ]
            for name in names:
                (root / name).touch()
                (root / name).chmod(0o755)
            commands = []

            def run(command, **kwargs):
                commands.append(command)
                output = []
                for i, item in enumerate(command):
                    if item == "--bin":
                        name = command[i + 1]
                        output.append(
                            json.dumps(
                                {
                                    "reason": "compiler-artifact",
                                    "target": {"name": name, "kind": ["bin"]},
                                    "executable": str(root / name),
                                }
                            )
                        )
                return subprocess.CompletedProcess(command, 0, "\n".join(output))

            with (
                patch.object(
                    package_binaries, "cargo_command_packages", return_value=set()
                ),
                patch.object(package_binaries, "cargo_environment", return_value={}),
                patch.object(package_binaries, "leased_cache"),
                patch.object(package_binaries.subprocess, "run", side_effect=run),
            ):
                result = package_binaries.build_binaries(
                    root,
                    TARGETS["aarch64-apple-darwin"],
                    dict.fromkeys(names),
                    cargo="cargo",
                    cargo_profile="dev-small",
                )
            self.assertEqual(set(result), set(names))
            self.assertEqual(len(commands), 4)
            self.assertNotIn("--features", commands[0])
            self.assertIn("ash-app-server", commands[0])
            for name, command in zip(names[1:], commands[1:]):
                self.assertEqual(command.count("--bin"), 1)
                self.assertIn(name + "/host", command)
                self.assertNotIn("ash-app-server", command)
