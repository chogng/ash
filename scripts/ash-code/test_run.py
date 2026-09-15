from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import run


class SourceRunnerTests(unittest.TestCase):
    def test_main_builds_once_and_runs_the_staged_ash(self) -> None:
        staged = self._executables(Path("C:/staged"))
        built = self._executables(Path("C:/built"))
        with (
            patch.dict(run.os.environ, {"PATH": "tools"}, clear=True),
            patch.object(run, "build_binaries", return_value=(0, built)) as build,
            patch.object(run, "stage_runtime", return_value=staged),
            patch.object(run, "resolve_tgrep") as tgrep,
            patch.object(run.subprocess, "run") as subprocess_run,
        ):
            tgrep.return_value.executable = built["tgrep"]
            subprocess_run.return_value = run.subprocess.CompletedProcess([], 0)

            self.assertEqual(run.main(["--help"]), 0)

        build.assert_called_once_with(
            run.development_binaries(code_mode=None), {"PATH": "tools"}
        )
        runtime = run.runtime_environment({"PATH": "tools"}, staged)
        self.assertNotIn("ASH_RG_PATH", runtime)
        self.assertEqual(runtime["ASH_TGREP_PATH"], str(staged["tgrep"].resolve()))
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
            patch.object(run, "built_executable") as built_executable,
            patch.object(run.subprocess, "run") as subprocess_run,
        ):
            first = Path(temporary) / "ash"
            second = Path(temporary) / "ash-app-server"
            first.touch()
            second.touch()
            built_executable.side_effect = [first, second]
            subprocess_run.return_value = run.subprocess.CompletedProcess([], 0)

            self.assertEqual(
                run.build_binaries(binaries, {"CARGO_BUILD_JOBS": "4"}),
                (0, {"ash": first, "ash-app-server": second}),
            )

        subprocess_run.assert_called_once_with(
            [
                run.sys.executable,
                "-B",
                "scripts/cargo.py",
                "build",
                "--workspace",
                "--profile",
                run.DEVELOPMENT_PROFILE,
                "--bin",
                "ash",
                "--bin",
                "ash-app-server",
            ],
            cwd=run.REPOSITORY_ROOT,
            env={"CARGO_BUILD_JOBS": "4"},
            check=False,
        )

    def test_development_binaries_include_platform_children(self) -> None:
        self.assertNotIn(
            "ash-command-runner",
            run.development_binaries(platform_name="win32"),
        )
        self.assertNotIn(
            "ash-windows-sandbox-service",
            run.development_binaries(platform_name="win32"),
        )
        self.assertNotIn(
            "ash-windows-sandbox-worker",
            run.development_binaries(platform_name="win32"),
        )
        self.assertNotIn(
            "ash-linux-sandbox", run.development_binaries(platform_name="linux")
        )
        self.assertIn(
            "bwrap",
            run.development_binaries(platform_name="linux"),
        )
        self.assertIn(
            "ash-code-mode-host",
            run.development_binaries(platform_name="darwin", code_mode="host"),
        )

    def test_stage_runtime_reuses_one_content_generation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = root / "built/ash.exe"
            second = root / "built/daemon.exe"
            first.parent.mkdir()
            first.write_bytes(b"ash")
            second.write_bytes(b"daemon")
            with patch.object(run, "DEVELOPMENT_RUNTIME_ROOT", root / "runtime"):
                staged = run.stage_runtime({"ash": first, "daemon": second})
                repeated = run.stage_runtime({"ash": first, "daemon": second})

            self.assertEqual(staged, repeated)
            self.assertEqual(staged["ash"].read_bytes(), b"ash")
            self.assertEqual(staged["daemon"].read_bytes(), b"daemon")
            self.assertEqual(len(list((root / "runtime").iterdir())), 1)

    @staticmethod
    def _executables(root: Path) -> dict[str, Path]:
        return {
            "ash": root / "ash.exe",
            "ash-app-server": root / "ash-app-server.exe",
            "tgrep": root / "tgrep.exe",
        }


if __name__ == "__main__":
    unittest.main()
