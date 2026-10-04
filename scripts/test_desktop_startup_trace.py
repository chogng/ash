"""Verify that Desktop trace comparisons keep conditions and failures visible."""

import unittest

import desktop_startup_trace


def report(duration=100, error=False, version=2):
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
                    **({"renderer": None if failed else {
                        "responseEndMs": 10,
                        "marks": [
                            {"name": name, "startTimeMs": time}
                            for name, time in (
                                ("ash.desktop.contributions-start", 18),
                                ("ash.desktop.contributions-ready", 19),
                                ("ash.desktop.open-start", 20),
                                ("ash.rendererApi.start", 21),
                                ("ash.rendererApi.acquire-start", 22),
                                ("ash.rendererApi.acquired", 23),
                                *((("ash.rendererApi.initialized", 24), ("ash.rendererApi.workspace-initialized", 25)) if cohort != "ui-only" else ()),
                                ("ash.desktop.api-ready", 26),
                                ("ash.desktop.themes-ready", 27),
                                ("ash.desktop.workspace-ready", 28),
                                ("ash.desktop.configuration-ready", 29),
                                ("ash.desktop.workbench-start", 30),
                                ("ash.workbench.constructor-start", 30),
                                ("ash.workbench.services-ready", 30.2),
                                ("ash.workbench.shell-ready", 30.4),
                                ("ash.workbench.views-restored", 31.5),
                                ("ash.workbench.constructor-done", 30.8),
                                ("ash.desktop.workbench-created", 31),
                                ("ash.desktop.lifecycle-ready", 32),
                            )
                        ],
                    }} if version == 3 else {}),
                    **({"error": "launch failed"} if failed else {}),
                }
            )
    return {
        "schemaVersion": version,
        "metadata": {key: "same" for key in desktop_startup_trace.CONDITIONS + desktop_startup_trace.V2_CONDITIONS + (desktop_startup_trace.V3_CONDITIONS if version == 3 else ())},
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

    def test_renderer_stages_are_compared_on_one_window_clock(self):
        baseline = report(version=3)
        candidate = report(90, version=3)
        baseline["metadata"]["rendererBuildId"] = "sha256:before"
        candidate["metadata"]["rendererBuildId"] = "sha256:after"
        output, status = desktop_startup_trace.compare_reports(baseline, candidate)
        self.assertEqual(status, 0)
        self.assertIn("Baseline renderer build: sha256:before", output)
        self.assertIn("Candidate renderer build: sha256:after", output)
        self.assertIn("Renderer stages, one window performance clock", output)
        self.assertIn("shell-ready → ash.workbench.views-restored | 1.1,1.1,1.1,1.1,1.1", output)
        self.assertIn("shell-ready → ash.workbench.constructor-done | 0.4,0.4,0.4,0.4,0.4", output)
        self.assertIn("reused | response-end → ash.desktop.open-start | 10.0,10.0,10.0,10.0,10.0", output)

    def test_missing_renderer_mark_is_rejected(self):
        candidate = report(version=3)
        candidate["samples"][0]["renderer"]["marks"].pop()
        with self.assertRaisesRegex(ValueError, "missing renderer mark"):
            desktop_startup_trace.compare_reports(report(version=3), candidate)

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
