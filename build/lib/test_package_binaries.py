import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from build.lib import package_binaries
from build.lib.targets import TARGETS


class BinaryIsolationTests(unittest.TestCase):
    def test_fresh_and_failed_builds_do_not_start_image_loading(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            executable = root / "ash-app-server.exe"
            executable.touch()
            artifact = {
                "reason": "compiler-artifact",
                "target": {"name": "ash-app-server", "kind": ["bin"]},
                "executable": str(executable),
                "fresh": True,
            }
            for exit_code in (0, 101):
                artifact["fresh"] = exit_code == 0
                callback = Mock()
                with (
                    self.subTest(exit_code=exit_code),
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
                            [], exit_code, json.dumps(artifact)
                        ),
                    ),
                ):
                    if exit_code:
                        with self.assertRaises(subprocess.CalledProcessError):
                            package_binaries.build_binaries(
                                root,
                                TARGETS["x86_64-pc-windows-msvc"],
                                {"ash-app-server": None},
                                cargo="cargo",
                                cargo_profile="dev-small",
                                on_rebuilt_binary=callback,
                            )
                    else:
                        package_binaries.build_binaries(
                            root,
                            TARGETS["x86_64-pc-windows-msvc"],
                            {"ash-app-server": None},
                            cargo="cargo",
                            cargo_profile="dev-small",
                            on_rebuilt_binary=callback,
                        )
                    callback.assert_not_called()

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
                                    "fresh": False,
                                }
                            )
                        )
                return subprocess.CompletedProcess(command, 0, "\n".join(output))

            with (
                patch.object(
                    package_binaries,
                    "cargo_command_packages",
                    return_value={"ash-app-server-protocol", "sherpa-onnx-sys"},
                ) as packages,
                patch.object(
                    package_binaries,
                    "cargo_environment",
                    return_value={"SHERPA_ONNX_LIB_DIR": "prepared-speech"},
                ) as environment,
                patch.object(package_binaries, "generate_protocol") as protocol,
                patch.object(
                    package_binaries,
                    "validate_input_binary",
                    side_effect=lambda path, *_: path,
                ),
                patch.object(package_binaries, "leased_cache"),
                patch.object(package_binaries.subprocess, "run", side_effect=run),
            ):
                rebuilt = []
                result = package_binaries.build_binaries(
                    root,
                    TARGETS["aarch64-apple-darwin"],
                    dict.fromkeys(names),
                    cargo="cargo",
                    cargo_profile="dev-small",
                    on_rebuilt_binary=lambda name, path: rebuilt.append(
                        (name, path, len(commands))
                    ),
                )
            self.assertEqual(set(result), set(names))
            self.assertEqual(
                [(name, root / name, index + 1) for index, name in enumerate(names)],
                rebuilt,
            )
            packages.assert_called_once()
            environment.assert_called_once_with(
                TARGETS["aarch64-apple-darwin"],
                {"ash-app-server-protocol", "sherpa-onnx-sys"},
            )
            protocol.assert_called_once_with(root=root, cargo="cargo")
            selection = packages.call_args.args[1]
            for name in names[1:]:
                self.assertIn(name + "/host", selection)
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
