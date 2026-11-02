"""Check Rust coverage selection, failure reporting and environment boundaries."""

from contextlib import redirect_stderr, redirect_stdout
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from scripts.coverage import coverage_environment, main


class CoverageTests(unittest.TestCase):
    def test_show_env_preserves_quoted_paths_and_flags_without_shell_evaluation(self):
        result = coverage_environment(
            "LLVM_PROFILE_FILE='/path with spaces/%p.profraw'\n"
            "CARGO_LLVM_COV_TARGET_DIR='C:\\coverage output'\n"
            "RUSTFLAGS='-C instrument-coverage --cfg=\"name\"'\n"
            "LITERAL='$(never-run)'\n"
        )
        self.assertEqual(result["LLVM_PROFILE_FILE"], "/path with spaces/%p.profraw")
        self.assertEqual(result["CARGO_LLVM_COV_TARGET_DIR"], "C:\\coverage output")
        self.assertEqual(result["LITERAL"], "$(never-run)")
        self.assertEqual(result["RUSTFLAGS"], '-C instrument-coverage --cfg="name"')
        for output in ("bad line", "A=1; touch /tmp/no", "A=1", "1BAD=value"):
            with self.subTest(output=output), self.assertRaises(ValueError):
                coverage_environment(output)

    def run_coverage(self, arguments, test_code=0, report_code=0, tests=3):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        child = MagicMock()
        child.__enter__.return_value = child
        child.stdout = io.StringIO(
            f"test result: {'ok' if test_code == 0 else 'FAILED'}. {tests} passed; 0 failed; 0 ignored;\n"
        )
        child.wait.return_value = test_code
        calls = []

        def run(command, **options):
            calls.append((command, options))
            return subprocess.CompletedProcess(
                command, report_code if "report" in command else 0
            )

        with (
            patch("scripts.coverage.ROOT", root),
            patch("scripts.coverage.subprocess.run", side_effect=run),
            patch("scripts.coverage.subprocess.Popen", return_value=child) as popen,
            patch(
                "scripts.coverage.subprocess.check_output",
                return_value="LLVM_PROFILE_FILE='/raw/%p.profraw'\nCARGO_LLVM_COV_TARGET_DIR='/coverage-target'\n",
            ),
            redirect_stdout(io.StringIO()),
            redirect_stderr(io.StringIO()),
        ):
            code = main(arguments)
        directory = next((root / ".build/coverage").glob("rust-*"))
        return code, json.loads((directory / "run.json").read_text()), calls, popen

    def test_selected_tests_keep_the_owning_cargo_wrapper_and_build_settings(self):
        code, metadata, calls, popen = self.run_coverage(
            [
                "-p",
                "one",
                "-p",
                "two",
                "--profile",
                "test",
                "--features",
                "feature",
                "-j",
                "2",
                "--",
                "test_name",
                "--exact",
            ]
        )
        self.assertEqual(code, 0)
        self.assertEqual(metadata["status"], "passed")
        command = popen.call_args.args[0]
        self.assertEqual(command[2:4], ["scripts/cargo.py", "test"])
        self.assertEqual(command[4:8], ["-p", "one", "-p", "two"])
        self.assertIn("--lib", command)
        self.assertIn("--bins", command)
        self.assertEqual(command[-3:], ["--", "test_name", "--exact"])
        self.assertIn("--profile", calls[1][0])
        self.assertEqual(len(calls), 5)
        self.assertEqual(metadata["executedTests"], 3)
        self.assertIn(".build", popen.call_args.kwargs["env"]["CARGO_TARGET_DIR"])

    def test_failed_tests_still_generate_reports_and_keep_the_test_exit_status(self):
        code, metadata, calls, _ = self.run_coverage([], test_code=7)
        self.assertEqual(code, 7)
        self.assertEqual(metadata["status"], "failed")
        self.assertEqual(metadata["packages"], ["--workspace"])
        self.assertEqual(len(calls), 5)

    def test_report_failure_and_zero_executed_tests_are_not_passes(self):
        code, metadata, _, _ = self.run_coverage([], report_code=2)
        self.assertEqual(code, 2)
        self.assertEqual(metadata["reportExitCode"], 2)
        code, metadata, _, _ = self.run_coverage([], tests=0)
        self.assertEqual(code, 1)
        self.assertEqual(metadata["status"], "failed")

    def test_conflicting_selection_and_invalid_jobs_fail_before_tool_execution(self):
        for arguments in (
            ["--workspace", "-p", "one"],
            ["--jobs", "0"],
            ["unseparated-filter"],
        ):
            with (
                self.subTest(arguments=arguments),
                patch("scripts.coverage.subprocess.run") as run,
                redirect_stderr(io.StringIO()),
                self.assertRaises(SystemExit),
            ):
                main(arguments)
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
