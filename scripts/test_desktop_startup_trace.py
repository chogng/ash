"""Verify that Desktop trace comparisons keep conditions and failures visible."""

import unittest

import desktop_startup_trace


def report(duration=100, error=False):
    samples = []
    for cohort in desktop_startup_trace.COHORTS:
        for index in range(5):
            failed = error and cohort == "fresh" and index == 0
            samples.append(
                {
                    "cohort": cohort,
                    "index": index,
                    "readyMs": None if failed else duration + index,
                    "milestones": [
                        {"phase": "launch-requested", "elapsedMs": 0},
                        {"phase": "electron-launch-resolved", "elapsedMs": 20},
                        {"phase": "first-window", "elapsedMs": 40},
                        *([] if failed else [{"phase": "workbench-ready", "elapsedMs": duration + index}]),
                    ],
                    **({"error": "launch failed"} if failed else {}),
                }
            )
    return {
        "schemaVersion": 2,
        "metadata": {key: "same" for key in desktop_startup_trace.CONDITIONS + desktop_startup_trace.V2_CONDITIONS},
        "samples": samples,
    }


class DesktopStartupTraceComparisonTests(unittest.TestCase):
    def test_complete_comparison_shows_samples_and_observer_stages(self):
        output, status = desktop_startup_trace.compare_reports(report(), report(90))
        self.assertEqual(status, 0)
        self.assertIn("fresh | 100,101,102,103,104 | 90,91,92,93,94 | 102.0 | 92.0 | -10.0 | 0/0", output)
        self.assertIn("first-window → workbench-ready | 60,61,62,63,64 | 50,51,52,53,54 | 62.0 | 52.0 | -10.0", output)

    def test_failed_sample_is_reported_and_comparison_is_incomplete(self):
        output, status = desktop_startup_trace.compare_reports(report(), report(90, error=True))
        self.assertEqual(status, 2)
        self.assertIn("candidate fresh[0] error: launch failed", output)
        self.assertIn("errors (B/C)", output)
        self.assertIn("Result: incomplete comparison", output)

    def test_mismatched_conditions_are_rejected(self):
        candidate = report()
        candidate["metadata"]["cache"] = "cache cleared"
        with self.assertRaisesRegex(ValueError, "measurement conditions differ: cache"):
            desktop_startup_trace.compare_reports(report(), candidate)

    def test_mismatched_instrumentation_is_rejected(self):
        candidate = report()
        candidate["schemaVersion"] = 1
        with self.assertRaisesRegex(ValueError, "schema versions differ"):
            desktop_startup_trace.compare_reports(report(), candidate)

    def test_out_of_order_milestones_are_rejected(self):
        candidate = report()
        candidate["samples"][0]["milestones"][2]["elapsedMs"] = 10
        with self.assertRaisesRegex(ValueError, "invalid milestone order"):
            desktop_startup_trace.compare_reports(report(), candidate)

    def test_setup_failure_is_visible(self):
        candidate = report()
        candidate["metadata"]["failure"] = "package missing"
        output, status = desktop_startup_trace.compare_reports(report(), candidate)
        self.assertEqual(status, 2)
        self.assertIn("candidate setup error: package missing", output)


if __name__ == "__main__":
    unittest.main()
