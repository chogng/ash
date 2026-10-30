from __future__ import annotations

import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from build.code import debug


class NativeDebugPreparationTests(unittest.TestCase):
    def test_success_publishes_literal_tool_paths_after_a_symbol_build(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with (
                patch.object(debug, "ROOT", root),
                patch.object(
                    debug,
                    "prepare_runtime_environment",
                    return_value=(
                        0,
                        {"ASH_DEV_RUNTIME_ROOT": str(root / "shared resources")},
                    ),
                ),
                patch.object(debug, "resolve_ripgrep") as ripgrep,
                patch.object(debug, "resolve_tgrep") as tgrep,
                patch.object(debug.subprocess, "run") as run,
            ):
                ripgrep.return_value.executable = root / "tools with spaces/rg.exe"
                tgrep.return_value.executable = root / "tools/tgrep.exe"
                run.return_value = subprocess.CompletedProcess([], 0)
                self.assertEqual(debug.main(), 0)
                arguments = run.call_args.args[0]
                self.assertIn("profile.ci-test.package.ash-cli.debug=2", arguments)
                self.assertIn("profile.ci-test.package.ash-tui.debug=2", arguments)
                self.assertEqual(run.call_args.kwargs["cwd"], root)
                values = {
                    key: json.loads(value)
                    for key, value in (
                        line.split("=", 1)
                        for line in (root / ".build/code/debug.env")
                        .read_text()
                        .splitlines()
                    )
                }
                self.assertEqual(
                    values["ASH_DEV_RUNTIME_ROOT"],
                    (root / "shared resources").resolve().as_posix(),
                )
                self.assertEqual(
                    values["ASH_RG_PATH"],
                    ripgrep.return_value.executable.resolve().as_posix(),
                )
                self.assertEqual(
                    values["ASH_TGREP_PATH"],
                    tgrep.return_value.executable.resolve().as_posix(),
                )
                self.assertFalse((root / ".build/code/debug.env.partial").exists())

    def test_failed_build_preserves_the_previous_environment_and_its_failure_status(
        self,
    ):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / ".build/code/debug.env"
            output.parent.mkdir(parents=True)
            output.write_text("previous")
            with (
                patch.object(debug, "ROOT", root),
                patch.object(
                    debug,
                    "prepare_runtime_environment",
                    return_value=(
                        0,
                        {"ASH_DEV_RUNTIME_ROOT": str(root / "shared resources")},
                    ),
                ),
                patch.object(debug, "resolve_ripgrep"),
                patch.object(debug, "resolve_tgrep"),
                patch.object(
                    debug.subprocess,
                    "run",
                    return_value=subprocess.CompletedProcess([], 23),
                ),
            ):
                self.assertEqual(debug.main(), 23)
                self.assertEqual(output.read_text(), "previous")


if __name__ == "__main__":
    unittest.main()
