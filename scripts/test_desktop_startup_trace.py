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
                        *(
                            []
                            if failed
                            else [
                                {
                                    "phase": "workbench-ready",
                                    "elapsedMs": duration + index,
                                }
                            ]
                        ),
                    ],
                    **(
                        {
                            "renderer": None
                            if failed
                            else {
                                "responseEndMs": 10,
                                "marks": [
                                    {"name": name, "startTimeMs": time}
                                    for name, time in (
                                        ("ash.desktop.contributions-start", 18),
                                        ("ash.desktop.contributions-ready", 19),
                                        ("ash.desktop.open-start", 20),
                                        ("ash.rendererApi.start", 21),
                                        ("ash.appServer.acquire-start", 22),
                                        ("ash.appServer.acquired", 23),
                                        *(
                                            (
                                                ("ash.rendererApi.initialized", 24),
                                                (
                                                    "ash.rendererApi.workspace-initialized",
                                                    25,
                                                ),
                                            )
                                            if cohort != "ui-only"
                                            else ()
                                        ),
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
                            }
                        }
                        if version == 3
                        else {}
                    ),
                    **({"error": "launch failed"} if failed else {}),
                }
            )
    return {
        "schemaVersion": version,
        "metadata": {
            key: "same"
            for key in desktop_startup_trace.CONDITIONS
            + desktop_startup_trace.V2_CONDITIONS
            + (desktop_startup_trace.V3_CONDITIONS if version == 3 else ())
        },
        "samples": samples,
    }


class DesktopStartupTraceComparisonTests(unittest.TestCase):
    def test_complete_comparison_shows_samples_and_observer_stages(self):
        output, status = desktop_startup_trace.compare_reports(report(), report(90))
        self.assertEqual(status, 0)
        self.assertIn(
            "fresh | 100,101,102,103,104 | 90,91,92,93,94 | 102.0 | 92.0 | -10.0 | 0/0",
            output,
        )
        self.assertIn(
            "first-window → workbench-ready | 60,61,62,63,64 | 50,51,52,53,54 | 62.0 | 52.0 | -10.0",
            output,
        )

    def test_failed_sample_is_reported_and_comparison_is_incomplete(self):
        output, status = desktop_startup_trace.compare_reports(
            report(), report(90, error=True)
        )
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
        self.assertIn(
            "shell-ready → ash.workbench.views-restored | 1.1,1.1,1.1,1.1,1.1", output
        )
        self.assertIn(
            "shell-ready → ash.workbench.constructor-done | 0.4,0.4,0.4,0.4,0.4", output
        )
        self.assertIn(
            "reused | response-end → ash.desktop.open-start | 10.0,10.0,10.0,10.0,10.0",
            output,
        )

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

    def test_profiled_run_cannot_be_compared_to_unprofiled_run(self):
        baseline = report(version=3)
        candidate = report(version=3)
        baseline["metadata"]["cpuProfiles"] = "disabled"
        candidate["metadata"]["cpuProfiles"] = "first sample per cohort"
        with self.assertRaisesRegex(
            ValueError, "measurement conditions differ: cpuProfiles"
        ):
            desktop_startup_trace.compare_reports(baseline, candidate)

    def test_unmatched_connection_nonce_is_incomplete(self):
        baseline = report(version=3)
        candidate = report(version=3)
        for value in (baseline, candidate):
            value["metadata"]["connectionClock"] = "same Main clock"
            for sample in value["samples"]:
                sample["renderer"]["marks"].append(
                    {
                        "name": "ash.appServer.port-acquire-start",
                        "startTimeMs": 22,
                        "detail": {"nonce": "renderer-nonce"},
                    }
                )
                sample["main"] = [
                    {
                        "name": f"ash.appServer.main.{phase}",
                        "startTimeMs": index,
                        "detail": {"nonce": "renderer-nonce"},
                    }
                    for index, phase in enumerate(
                        (
                            "acquire",
                            "validated",
                            "carrier-ready",
                            "port-attached",
                            "first-write",
                            "first-read",
                            "initialized",
                        )
                    )
                ]
        output, status = desktop_startup_trace.compare_reports(baseline, candidate)
        self.assertEqual(status, 0)
        self.assertIn("first-write → first-read", output)
        candidate["samples"][0]["main"][0]["detail"]["nonce"] = "another-connection"
        output, status = desktop_startup_trace.compare_reports(baseline, candidate)
        self.assertEqual(status, 2)
        self.assertIn("incomplete comparison", output)

    def test_rust_scopes_require_the_current_port_and_carrier_lineage(self):
        sample = {
            "renderer": {
                "marks": [
                    {
                        "name": "ash.appServer.port-acquire-start",
                        "detail": {"nonce": "current"},
                    }
                ]
            },
            "main": [
                {
                    "name": "ash.appServer.main.carrier-ready",
                    "detail": {"nonce": "current", "carrierPid": 42},
                }
            ],
            "rust": [
                {
                    "traceId": "11111111-1111-1111-1111-111111111111",
                    "carrierPid": 42,
                    "pid": pid,
                    "scope": "connection",
                    "phase": "initialize",
                    "durationMs": elapsed,
                }
                for pid, elapsed in ((42, 3.0), (43, 4.0))
            ],
        }
        duration = desktop_startup_trace.rust_stage_duration
        self.assertEqual(duration(sample, "server", "connection", "initialize"), 4.0)
        self.assertIsNone(duration(sample, "server", "probe", "initialize"))
        sample["rust"][1]["traceId"] = "22222222-2222-2222-2222-222222222222"
        self.assertIsNone(duration(sample, "server", "connection", "initialize"))
        sample["rust"][1]["traceId"] = sample["rust"][0]["traceId"]
        sample["rust"][1]["carrierPid"] = 99
        self.assertIsNone(duration(sample, "server", "connection", "initialize"))
        sample["rust"][1]["carrierPid"] = 42
        sample["main"][0]["detail"]["nonce"] = "retired"
        self.assertIsNone(duration(sample, "server", "connection", "initialize"))
        sample["main"][0]["detail"]["nonce"] = "current"
        sample["rust"][1]["durationMs"] = float("nan")
        with self.assertRaisesRegex(ValueError, "invalid Rust startup"):
            duration(sample, "server", "connection", "initialize")

    def test_control_handshake_reports_unperformed_probe_separately_from_missing_data(
        self,
    ):
        def with_rust(mode):
            value = report(version=3)
            value["metadata"].update(
                connectionClock="same Main clock", rustClock="local Instant scopes"
            )
            for sample in value["samples"]:
                sample["main"] = []
                if sample["cohort"] == "ui-only":
                    continue
                sample["connectionHealthCheck"] = mode
                sample["renderer"]["marks"].append(
                    {
                        "name": "ash.appServer.port-acquire-start",
                        "startTimeMs": 22,
                        "detail": {"nonce": "current"},
                    }
                )
                sample["main"] = [
                    {
                        "name": f"ash.appServer.main.{phase}",
                        "startTimeMs": index,
                        "detail": {"nonce": "current", "carrierPid": 42},
                    }
                    for index, phase in enumerate(
                        (
                            "acquire",
                            "validated",
                            "carrier-ready",
                            "port-attached",
                            "first-write",
                            "first-read",
                            "initialized",
                        )
                    )
                ]
                sample["rust"] = [
                    {
                        "traceId": "11111111-1111-1111-1111-111111111111",
                        "carrierPid": 42,
                        "pid": 42 if owner == "carrier" else 43,
                        "scope": scope,
                        "phase": phase,
                        "durationMs": 1.0,
                    }
                    for owner, scope, phase in desktop_startup_trace.RUST_STAGES
                    if desktop_startup_trace.rust_stage_applies(
                        sample, owner, scope, phase
                    )
                    and not (
                        phase == "managed-startup" and sample["cohort"] == "reused"
                    )
                ]
            return value

        baseline, candidate = with_rust("initialize"), with_rust("control")
        output, status = desktop_startup_trace.compare_reports(baseline, candidate)
        self.assertEqual(status, 0)
        self.assertIn(
            "server/probe/initialize | 1.000,1.000,1.000,1.000,1.000 | not-run", output
        )
        candidate["samples"][0]["rust"] = [
            record
            for record in candidate["samples"][0]["rust"]
            if record["phase"] != "control-contract"
        ]
        output, status = desktop_startup_trace.compare_reports(baseline, candidate)
        self.assertEqual(status, 2)
        self.assertIn(
            "carrier/connection/control-contract | not-run,not-run,not-run,not-run,not-run | ERROR",
            output,
        )
        candidate = with_rust("control")
        candidate["samples"][0]["rust"][0]["scope"] = "probe"
        with self.assertRaisesRegex(ValueError, "unexpectedly opened a probe"):
            desktop_startup_trace.compare_reports(baseline, candidate)
        candidate = with_rust("control")
        candidate["samples"][0].update(
            error="deliberate startup failure",
            readyMs=None,
            connectionHealthCheck=None,
            rust=[],
        )
        output, status = desktop_startup_trace.compare_reports(baseline, candidate)
        self.assertEqual(status, 2)
        self.assertIn("candidate fresh[0] error: deliberate startup failure", output)

    def test_missing_rust_scopes_make_comparison_incomplete(self):
        baseline = report(version=3)
        candidate = report(version=3)
        for value in (baseline, candidate):
            value["metadata"]["rustClock"] = "local Instant scopes"
        output, status = desktop_startup_trace.compare_reports(baseline, candidate)
        self.assertEqual(status, 2)
        self.assertIn("server/probe/initialize | ERROR", output)

    def test_malformed_main_timing_is_rejected(self):
        candidate = report(version=3)
        candidate["metadata"]["connectionClock"] = "same Main clock"
        candidate["samples"][0]["main"] = [
            {"name": "acquire", "startTimeMs": 1, "detail": "invalid"}
        ]
        with self.assertRaisesRegex(ValueError, "invalid Main timings"):
            desktop_startup_trace.validate(candidate, "candidate")

    def test_missing_first_use_is_rejected(self):
        candidate = report(version=3)
        candidate["metadata"]["firstUse"] = "actual UI"
        with self.assertRaisesRegex(ValueError, "invalid first use"):
            desktop_startup_trace.validate(candidate, "candidate")

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
