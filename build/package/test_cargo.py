"""Release binary selection and Cargo output validation."""

import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from build.lib.targets import TARGETS
from build.package.cargo import build_binaries
from build.package.cargo import resolve_windows_sandbox_binary


class CargoBuildTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.spec = TARGETS["aarch64-apple-darwin"]

    def executable(self, name: str) -> Path:
        path = self.root / name
        path.write_bytes(name.encode())
        path.chmod(0o755)
        return path

    def test_prebuilt_inputs_skip_cargo_and_v8_resolution(self) -> None:
        inputs = {"ash-app-server": self.executable("prebuilt")}
        with (
            patch("build.package.cargo.subprocess.run") as run,
            patch("build.package.cargo.cargo_environment") as environment,
        ):
            result = build_binaries(
                self.root, self.spec, inputs, cargo="cargo", cargo_profile="release"
            )
        self.assertEqual(inputs, result)
        run.assert_not_called()
        environment.assert_not_called()

    def test_mixed_inputs_build_only_missing_binaries_in_one_call(self) -> None:
        prebuilt = self.executable("prebuilt")
        reported = self.executable("cargo-reported-output")
        artifact = {
            "reason": "compiler-artifact",
            "target": {"kind": ["bin"], "name": "ash-remote"},
            "executable": str(reported),
        }
        completed = subprocess.CompletedProcess(["cargo"], 0, json.dumps(artifact))
        with (
            patch("build.package.cargo.subprocess.run", return_value=completed) as run,
            patch(
                "build.package.cargo.cargo_environment",
                return_value={"V8": "locked"},
            ) as environment,
        ):
            result = build_binaries(
                self.root,
                self.spec,
                {"ash-app-server": prebuilt, "ash-remote": None},
                cargo="cargo",
                cargo_profile="release",
            )
        self.assertEqual({"ash-app-server": prebuilt, "ash-remote": reported}, result)
        run.assert_called_once()
        command = run.call_args.args[0]
        self.assertEqual(1, command.count("--bin"))
        self.assertEqual("ash-remote", command[command.index("--bin") + 1])
        self.assertEqual(
            "ash-remote-connections", command[command.index("--package") + 1]
        )
        self.assertEqual(self.spec.target, command[command.index("--target") + 1])
        self.assertEqual({"V8": "locked"}, run.call_args.kwargs["env"])
        environment.assert_called_once_with(self.spec)

    def test_success_without_reported_executable_rejects_stale_output(self) -> None:
        stale = self.root / ".build/cargo" / self.spec.target / "release/ash-app-server"
        stale.parent.mkdir(parents=True)
        stale.write_bytes(b"stale")
        stale.chmod(0o755)
        with (
            patch(
                "build.package.cargo.subprocess.run",
                return_value=subprocess.CompletedProcess(["cargo"], 0, ""),
            ),
            patch("build.package.cargo.cargo_environment", return_value={}),
            self.assertRaisesRegex(RuntimeError, "did not report an executable"),
        ):
            build_binaries(
                self.root,
                self.spec,
                {"ash-app-server": None},
                cargo="cargo",
                cargo_profile="release",
            )

    def test_failed_build_preserves_compiler_diagnostics(self) -> None:
        diagnostic = {
            "reason": "compiler-message",
            "message": {"rendered": "compile failed\n"},
        }
        with (
            patch(
                "build.package.cargo.subprocess.run",
                return_value=subprocess.CompletedProcess(
                    ["cargo"], 101, json.dumps(diagnostic)
                ),
            ),
            patch("build.package.cargo.cargo_environment", return_value={}),
            patch("sys.stderr", new_callable=io.StringIO) as stderr,
            self.assertRaises(subprocess.CalledProcessError) as error,
        ):
            build_binaries(
                self.root,
                self.spec,
                {"ash-app-server": None},
                cargo="cargo",
                cargo_profile="release",
            )
        self.assertEqual(101, error.exception.returncode)
        self.assertEqual("compile failed\n", stderr.getvalue())

    def test_windows_sandbox_rejects_other_targets_before_building(self) -> None:
        with (
            patch("build.package.cargo.subprocess.run") as run,
            self.assertRaisesRegex(RuntimeError, "requires a Windows target"),
        ):
            resolve_windows_sandbox_binary(
                self.root, self.spec, self.executable("sandbox"), "cargo", "release"
            )
        run.assert_not_called()

    def test_windows_sandbox_build_does_not_resolve_v8(self) -> None:
        executable = self.executable("sandbox.exe")
        artifact = {
            "reason": "compiler-artifact",
            "target": {"kind": ["bin"], "name": "ash-windows-sandbox"},
            "executable": str(executable),
        }
        with (
            patch(
                "build.package.cargo.subprocess.run",
                return_value=subprocess.CompletedProcess(
                    ["cargo"], 0, json.dumps(artifact)
                ),
            ),
            patch("build.package.cargo.cargo_environment") as environment,
        ):
            result = resolve_windows_sandbox_binary(
                self.root, TARGETS["x86_64-pc-windows-msvc"], None, "cargo", "release"
            )
        self.assertEqual(executable, result)
        environment.assert_not_called()


if __name__ == "__main__":
    unittest.main()
