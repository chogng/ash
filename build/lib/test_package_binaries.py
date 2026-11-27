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

    def test_core_and_media_build_together_for_development_preparation(self):
        names = [
            "ash-app-server",
            "ash-code-mode-host",
            "ash-livekit-client",
            "ash-realtime-voice",
            "ash-voice-host",
        ]
        core, media = names[:2], names[2:]
        for target, profile, host_build, preload, groups in (
            ("aarch64-apple-darwin", "dev-small", True, True, [names]),
            ("x86_64-pc-windows-msvc", "dev-small", True, False, [names]),
            ("x86_64-pc-windows-msvc", "dev-small", True, True, [core, media]),
            (
                "aarch64-apple-darwin",
                "dev-small",
                False,
                True,
                [core, *[[name] for name in media]],
            ),
            (
                "aarch64-apple-darwin",
                "release",
                True,
                True,
                [core, *[[name] for name in media]],
            ),
        ):
            with self.subTest(
                target=target, profile=profile, host_build=host_build, preload=preload
            ):
                self.assert_build_groups(
                    target, profile, host_build, preload, names, groups
                )

    def assert_build_groups(self, target, profile, host_build, preload, names, groups):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
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

            rebuilt = []

            def completed(name, path):
                rebuilt.append((name, path, len(commands)))

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
                result = package_binaries.build_binaries(
                    root,
                    TARGETS[target],
                    dict.fromkeys(names),
                    cargo="cargo",
                    cargo_profile=profile,
                    host_build=host_build,
                    on_rebuilt_binary=completed if preload else None,
                )
            self.assertEqual(set(result), set(names))
            self.assertEqual(
                [
                    (name, root / name, index + 1)
                    for index, group in enumerate(groups)
                    for name in group
                ]
                if preload
                else [],
                rebuilt,
            )
            packages.assert_called_once()
            environment.assert_called_once_with(
                TARGETS[target],
                {"ash-app-server-protocol", "sherpa-onnx-sys"},
                environ=None,
            )
            protocol.assert_called_once_with(root=root, cargo="cargo")
            binary_packages = {
                "ash-app-server": "ash-app-server",
                "ash-code-mode-host": "ash-code-mode-host",
                "ash-livekit-client": "ash-livekit-host",
                "ash-realtime-voice": "ash-recognizer-host",
                "ash-voice-host": "ash-audio-host",
            }
            self.assertEqual(len(commands), len(groups))
            for group, command in zip(groups, commands, strict=True):
                self.assertEqual(
                    {
                        command[i + 1]
                        for i, flag in enumerate(command)
                        if flag == "--features"
                    },
                    {
                        f"{binary_packages[name]}/host"
                        for name in group
                        if name in names[2:]
                    },
                )
                self.assertEqual(
                    [
                        command[i + 1]
                        for i, flag in enumerate(command)
                        if flag == "--bin"
                    ],
                    group,
                )
                self.assertEqual(
                    [
                        command[i + 1]
                        for i, flag in enumerate(command)
                        if flag == "--package"
                    ],
                    [binary_packages[name] for name in group],
                )

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
                # Input validation returns the physical path, including macOS /var aliases.
                self.assertEqual(result, {"ash-app-server": executable.resolve()})
                command = run.call_args.args[0]
                if optimized:
                    self.assertEqual(
                        command[command.index("--config") + 1],
                        "profile.release.codegen-units=1",
                    )
                else:
                    self.assertNotIn("--config", command)
