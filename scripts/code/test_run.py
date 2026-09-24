from __future__ import annotations

import tempfile
import unittest
import json
from pathlib import Path
from unittest.mock import patch

import run
from build.code import build


class SourceRunnerTests(unittest.TestCase):
    def test_main_builds_once_and_runs_the_staged_ash(self) -> None:
        staged = self._executables(Path("C:/staged"))
        built = self._executables(Path("C:/built"))
        with (
            patch.dict(run.os.environ, {"PATH": "tools"}, clear=True),
            patch.object(run, "build_binaries", return_value=(0, built)) as build,
            patch.object(run, "stage_runtime", return_value=staged),
            patch.object(run, "resolve_tgrep") as tgrep,
            patch.object(run, "default_target", return_value="x86_64-pc-windows-msvc"),
            patch.object(run.subprocess, "run") as subprocess_run,
        ):
            tgrep.return_value.executable = built["tgrep"]
            subprocess_run.return_value = run.subprocess.CompletedProcess([], 0)

            self.assertEqual(run.main(["--help"]), 0)

        build.assert_called_once_with(run.development_binaries(), {"PATH": "tools"})
        runtime = run.runtime_environment({"PATH": "tools"}, staged)
        self.assertNotIn("ASH_RG_PATH", runtime)
        self.assertEqual(runtime["ASH_TGREP_PATH"], str(staged["tgrep"].resolve()))
        self.assertEqual(
            runtime["ASH_CODE_MODE_HOST_BIN"],
            str(staged["ash-code-mode-host"].resolve()),
        )
        tgrep.assert_called_once()
        subprocess_run.assert_called_once_with(
            [str(staged["ash"]), "--help"],
            cwd=run.REPOSITORY_ROOT,
            env=runtime,
            check=False,
        )

    def test_build_binaries_uses_one_cargo_invocation(self) -> None:
        binaries = ["ash", "ash-app-server"]
        with (
            tempfile.TemporaryDirectory() as temporary,
            patch.object(
                build, "default_target", return_value="x86_64-pc-windows-msvc"
            ),
            patch.object(build, "resolve_v8_cargo_env", return_value={}),
            patch.object(build.subprocess, "run") as subprocess_run,
        ):
            first = Path(temporary) / "ash"
            second = Path(temporary) / "ash-app-server"
            first.touch()
            second.touch()
            messages = "\n".join(
                json.dumps(
                    {
                        "reason": "compiler-artifact",
                        "target": {"name": name, "kind": ["bin"]},
                        "executable": str(path),
                    }
                )
                for name, path in (("ash", first), ("ash-app-server", second))
            )
            subprocess_run.return_value = build.subprocess.CompletedProcess(
                [], 0, messages
            )

            self.assertEqual(
                build.build_binaries(binaries, {"CARGO_BUILD_JOBS": "4"}),
                (0, {"ash": first, "ash-app-server": second}),
            )

        subprocess_run.assert_called_once_with(
            [
                "cargo",
                "build",
                "--workspace",
                "--locked",
                "--profile",
                build.DEVELOPMENT_PROFILE,
                "--target-dir",
                str(
                    build.resolve_cargo_target_directory(
                        build.REPOSITORY_ROOT, {"CARGO_BUILD_JOBS": "4"}
                    )
                ),
                "--message-format=json-render-diagnostics",
                "--bin",
                "ash",
                "--bin",
                "ash-app-server",
            ],
            cwd=build.REPOSITORY_ROOT,
            env={"CARGO_BUILD_JOBS": "4"},
            capture_output=True,
            text=True,
            check=False,
        )

    def test_development_binaries_include_platform_children(self) -> None:
        self.assertNotIn(
            "ash-command-runner",
            build.development_binaries(platform_name="win32"),
        )
        self.assertNotIn(
            "ash-windows-sandbox-service",
            build.development_binaries(platform_name="win32"),
        )
        self.assertNotIn(
            "ash-windows-sandbox-worker",
            build.development_binaries(platform_name="win32"),
        )
        self.assertNotIn(
            "ash-linux-sandbox", build.development_binaries(platform_name="linux")
        )
        self.assertIn(
            "bwrap",
            build.development_binaries(platform_name="linux"),
        )
        self.assertIn(
            "ash-code-mode-host",
            build.development_binaries(platform_name="darwin"),
        )

    def test_stage_runtime_reuses_one_content_generation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = root / "built/ash.exe"
            second = root / "built/daemon.exe"
            first.parent.mkdir()
            first.write_bytes(b"ash")
            second.write_bytes(b"daemon")
            with patch.object(build, "DEVELOPMENT_RUNTIME_ROOT", root / "runtime"):
                staged = build.stage_runtime({"ash": first, "daemon": second})
                repeated = build.stage_runtime({"ash": first, "daemon": second})

            self.assertEqual(staged, repeated)
            self.assertEqual(staged["ash"].read_bytes(), b"ash")
            self.assertEqual(staged["daemon"].read_bytes(), b"daemon")
            self.assertEqual(len(list((root / "runtime").iterdir())), 1)

    @staticmethod
    def _executables(root: Path) -> dict[str, Path]:
        return {
            "ash": root / "ash.exe",
            "ash-app-server": root / "ash-app-server.exe",
            "ash-code-mode-host": root / "ash-code-mode-host.exe",
            "tgrep": root / "tgrep.exe",
        }


if __name__ == "__main__":
    unittest.main()
