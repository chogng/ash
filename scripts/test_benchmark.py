"""Verify measurement units, comparison constraints, and source restoration."""

import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import benchmark


class BenchmarkTests(unittest.TestCase):
    def test_selected_workspace_is_used_for_commands(self):
        root = Path("/selected/workspace")
        with patch("benchmark.subprocess.check_output", return_value="ok\n") as run:
            self.assertEqual(benchmark.output(["cargo", "-V"], root), "ok")
        run.assert_called_once_with(["cargo", "-V"], cwd=root, text=True)

    def test_comparison_requires_both_relative_and_absolute_regression(self):
        baseline = {
            "environment": {},
            "medians": {s: {"seconds": 1} for s in benchmark.SCENARIOS},
        }
        current = {
            "environment": {},
            "medians": {s: {"seconds": 1.5} for s in benchmark.SCENARIOS},
        }
        self.assertEqual(benchmark.compare(baseline, current, 25, 2), [])
        current["medians"]["touch"]["seconds"] = 4
        self.assertEqual(len(benchmark.compare(baseline, current, 25, 2)), 1)

    def test_rss_units_are_normalized(self):
        self.assertEqual(
            benchmark.max_rss(" 2048 maximum resident set size", "Darwin"), 2048
        )
        self.assertEqual(
            benchmark.max_rss("Maximum resident set size (kbytes): 2", "Linux"), 2048
        )
        with self.assertRaises(ValueError):
            benchmark.max_rss("no measurements", "Linux")

    def test_source_timestamp_is_restored_after_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "lib.rs"
            source.write_text("pub fn value() {}\n")
            os.utime(source, ns=(1000000000, 2000000000))
            with patch(
                "benchmark.measure", side_effect=RuntimeError("compiler failed")
            ):
                with self.assertRaises(RuntimeError):
                    benchmark.touch_build(
                        source, [], Path(directory) / "build.log", "Linux"
                    )
            self.assertEqual(source.stat().st_mtime_ns, 2000000000)
            self.assertEqual(source.read_text(), "pub fn value() {}\n")

    def test_concurrent_source_update_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "lib.rs"
            source.write_text("before")

            def edit(*args):
                source.write_text("after")
                os.utime(source, ns=(3000000000, 4000000000))
                return {}

            with patch("benchmark.measure", side_effect=edit):
                benchmark.touch_build(
                    source, [], Path(directory) / "build.log", "Linux"
                )
            self.assertEqual(source.stat().st_mtime_ns, 4000000000)
            self.assertEqual(source.read_text(), "after")

    def test_comparison_rejects_environment_changes_and_detects_regressions(self):
        baseline = {
            "environment": {"jobs": 4},
            "medians": {s: {"seconds": 10} for s in benchmark.SCENARIOS},
        }
        current = {
            "environment": {"jobs": 4},
            "medians": {s: {"seconds": 12} for s in benchmark.SCENARIOS},
        }
        self.assertEqual(len(benchmark.compare(baseline, current, 10)), 3)
        self.assertEqual(benchmark.compare(baseline, current, 25), [])
        current["environment"]["jobs"] = 8
        with self.assertRaises(ValueError):
            benchmark.compare(baseline, current, 25)


if __name__ == "__main__":
    unittest.main()
