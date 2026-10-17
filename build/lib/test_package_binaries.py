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

    @patch.dict("build.lib.package_binaries.os.environ", {}, clear=True)
    def test_size_optimization_is_limited_to_windows_x64_release_packages(self):
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        cases = (
            ("x86_64-pc-windows-msvc", "release", True),
            ("x86_64-pc-windows-msvc", "dev-small", False),
            ("aarch64-pc-windows-msvc", "release", False),
            ("x86_64-unknown-linux-gnu", "release", False),
            ("aarch64-apple-darwin", "release", False),
        )
        for target, profile, optimized in cases:
            with self.subTest(target=target, profile=profile):
                spec = TARGETS[target]
                executable = root / ("ash-app-server" + spec.executable_suffix)
                executable.touch()
                executable.chmod(0o755)
                artifact = {
                    "reason": "compiler-artifact",
                    "target": {"kind": ["bin"], "name": "ash-app-server"},
                    "executable": str(executable),
                }
                with (
                    patch.object(
                        package_binaries, "cargo_command_packages", return_value=set()
                    ),
                    patch.object(
                        package_binaries, "cargo_environment", return_value={}
                    ),
                    patch.object(package_binaries, "leased_cache"),
                    patch.object(
                        package_binaries.subprocess,
                        "run",
                        return_value=subprocess.CompletedProcess(
                            [], 0, json.dumps(artifact)
                        ),
                    ) as run,
                ):
                    result = package_binaries.build_binaries(
                        root,
                        spec,
                        {"ash-app-server": None},
                        cargo="cargo",
                        cargo_profile=profile,
                    )
                self.assertEqual(result, {"ash-app-server": executable})
                command = run.call_args.args[0]
                if optimized:
                    self.assertEqual(
                        command[command.index("--config") + 1],
                        "profile.release.codegen-units=1",
                    )
                else:
                    self.assertNotIn("--config", command)
