"""Build prerequisites fail before discovery, regardless of suite ordering."""

import importlib.util
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "test_python_runner", Path(__file__).with_name("test-python.py")
)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class PythonTestRunnerTests(unittest.TestCase):
    def test_preflight_failure_stops_before_scripts_or_build_tests(self):
        for suites in (["scripts", "build"], ["build"], []):
            with (
                self.subTest(suites=suites),
                patch.object(
                    runner.subprocess,
                    "run",
                    return_value=subprocess.CompletedProcess([], 1),
                ) as run,
            ):
                self.assertEqual(runner.main(suites), 1)
                self.assertEqual(run.call_count, 1)
                self.assertTrue(
                    run.call_args.args[0][-1].endswith("check_build_tools.py")
                )

    def test_scripts_and_code_suites_do_not_require_symbol_tools(self):
        with patch.object(
            runner.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)
        ) as run:
            self.assertEqual(runner.main(["scripts", "code"]), 0)
        self.assertEqual(run.call_count, 2)
        for call in run.call_args_list:
            self.assertIn("unittest", call.args[0])

    def test_successful_preflight_runs_all_selected_suites(self):
        with patch.object(
            runner.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)
        ) as run:
            self.assertEqual(runner.main(["build", "scripts"]), 0)
        self.assertEqual(run.call_count, 3)
        self.assertTrue(
            run.call_args_list[0].args[0][-1].endswith("check_build_tools.py")
        )
        self.assertIn("unittest", run.call_args_list[1].args[0])


if __name__ == "__main__":
    unittest.main()
