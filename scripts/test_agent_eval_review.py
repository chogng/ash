"""Saved-evidence review, calibrated graders and conservative experiment gates."""

from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
import copy
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

import agent_eval
import agent_eval_review as review
from test_agent_eval_trace import accounting_fixture


def saved_batch(root: Path, name: str, passes: list[bool], tokens: int = 20) -> Path:
    directory = root / name
    directory.mkdir()
    runs = []
    for index, passed in enumerate(passes, 1):
        trial = directory / "runs" / f"case-{index}"
        trial.mkdir(parents=True)
        owner, diagnostic = accounting_fixture()
        owner["events"][0]["event"]["record"]["usage"]["inputTokens"] = tokens
        trace = {
            "formatVersion": 3,
            "sessionId": "session",
            "threads": [owner],
            "diagnostics": diagnostic,
        }
        review.write_json(trial / "trace.json", trace)
        for artifact in [
            "verifier.stderr",
            "verifier.stdout",
            "execution.stderr",
            "events.jsonl",
            "changes.patch",
            "cleanup.stderr",
        ]:
            (trial / artifact).write_text("recorded evidence\n")
        run = {
            "caseId": "case",
            "repetition": index,
            "taskPassed": passed,
            "artifactDirectory": trial.relative_to(directory).as_posix(),
            "executionStatus": "completed",
            "execution": {"exitCode": 0, "timedOut": False, "elapsedSeconds": 2},
            "outcome": {
                "type": "completed",
                "sessionId": "session",
                "threadId": "root",
                "turnId": "turn",
            },
            "materialization": {"status": "restored"},
            "verification": {
                "status": "passed" if passed else "failed",
                "exitCode": 0 if passed else 1,
                "timedOut": False,
            },
            "cleanup": {"exitCode": 0, "timedOut": False},
            "trace": {"modelCalls": 999},
        }
        review.write_json(trial / "result.json", run)
        (trial / "events.jsonl").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "event": {"type": "runCompleted", "outcome": run["outcome"]},
                }
            )
            + "\n"
        )
        runs.append(run)
    report = {
        "schemaVersion": 2,
        "configuration": {
            "suiteDigest": "suite",
            "profileConfigDigest": "profile",
            "timeoutSeconds": 30,
            "approval": "denyInteractiveRequests",
            "repetitions": len(passes),
            "model": "fixture/" + name,
            "platform": "fixed",
            "python": "fixed",
        },
        "runs": runs,
        "summary": {"passed": 999},
    }
    path = directory / "report.json"
    review.write_json(path, report)
    return path


def feedback_for(path: Path) -> dict:
    report = review.load_report(path)
    evidence = review.evidence_file(path, report["runs"][0], "trace.json")
    return {
        "schemaVersion": 1,
        "reportSha256": review.source_identity(path)["sha256"],
        "findings": [
            {
                "caseId": "case",
                "repetition": 1,
                "component": "context",
                "observation": "The saved trial did not pass independent acceptance.",
                "hypothesis": "The retained constraint should survive a context change.",
                "proposedChange": "Investigate the context owner and retain the constraint at the existing boundary.",
                "acceptance": "Recover this task while preserving existing passing cases and a separate holdout family.",
                "evidence": [
                    {
                        "artifact": "trace.json",
                        "sha256": evidence["sha256"],
                        "eventId": "root-1",
                    }
                ],
            }
        ],
    }


class AgentEvalReviewTests(unittest.TestCase):
    def test_suite_identity_tracks_actual_inputs_and_grading_resources(self):
        with tempfile.TemporaryDirectory() as temporary:
            suite = Path(temporary).resolve() / "suite"
            shutil.copytree(agent_eval.ROOT / "test/agent-eval", suite)
            original = agent_eval.suite_digest(suite)
            (suite / "README.md").write_text("Documentation changed.\n")
            (suite / "experiment.example.json").write_text("{}\n")
            manifest = agent_eval.load_suite(suite)
            (suite / "suite.json").write_text(
                json.dumps(manifest, separators=(",", ":"))
            )
            self.assertEqual(agent_eval.suite_digest(suite), original)
            helper = suite / "verifiers/helper.py"
            helper.write_text("# grader dependency\n")
            self.assertNotEqual(agent_eval.suite_digest(suite), original)
            helper.unlink()
            fixture = suite / "fixtures/prefix-filter/app.py"
            before = fixture.read_bytes()
            fixture.write_bytes(before + b"\n")
            self.assertNotEqual(agent_eval.suite_digest(suite), original)
            fixture.write_bytes(before)
            rubric = suite / "rubric.json"
            rubric.write_text("{}\n")
            manifest["gradingResources"] = ["rubric.json"]
            review.write_json(suite / "suite.json", manifest)
            with_resource = agent_eval.suite_digest(suite)
            rubric.write_text('{"criterion":"changed"}\n')
            self.assertNotEqual(agent_eval.suite_digest(suite), with_resource)

    def test_saved_reports_are_reanalyzed_without_rewriting_originals(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = saved_batch(root, "control", [False, True])
            before = path.read_bytes()
            output = root / "review"
            self.assertEqual(
                review.main(["review", "--report", str(path), "--output", str(output)]),
                0,
            )
            result = review.read_json(output / "review.json")
            self.assertEqual(result["summary"]["passed"], 1)
            self.assertEqual(
                result["summary"]["processMetrics"]["modelCalls"]["meanComplete"], 1
            )
            failed = next(
                group for group in result["groups"] if group["kind"] == "grader:failed"
            )
            self.assertEqual((failed["affectedTrials"], failed["totalTrials"]), (1, 2))
            self.assertIn("verifier.stderr", (output / "review.md").read_text())
            self.assertEqual(path.read_bytes(), before)
            template = review.read_json(output / "feedback.template.json")
            self.assertEqual(
                template["reportSha256"], review.source_identity(path)["sha256"]
            )

    def test_quality_gate_reports_recovery_and_rejects_regression_and_ungradable_trials(
        self,
    ):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old = saved_batch(root, "control", [False, True])
            new = saved_batch(root, "candidate", [True, True])
            self.assertEqual(
                review.compare_saved(new, old, "quality")["gate"]["status"], "passed"
            )
            self.assertEqual(
                review.compare_saved(new, new, "regression")["gate"]["status"], "passed"
            )
            self.assertEqual(
                review.compare_saved(new, new, "quality")["gate"]["status"], "failed"
            )
            regressed = saved_batch(root, "regressed", [True, False])
            result = review.compare_saved(regressed, old, "quality")["gate"]
            self.assertEqual(
                (result["status"], result["regressedTrials"]), ("failed", 1)
            )
            document = review.read_json(new)
            document["runs"][0].update(
                taskPassed=False,
                verification={"status": "error", "exitCode": 2, "timedOut": False},
            )
            review.write_json(new, document)
            unknown = review.compare_saved(new, old, "quality")["gate"]
            self.assertEqual(
                (unknown["status"], unknown["ungradableTrials"]), ("inconclusive", 1)
            )

    def test_resource_gate_uses_successful_pairs_and_requires_complete_accounting(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old = saved_batch(root, "control", [True, False], tokens=20)
            new = saved_batch(root, "candidate", [True, False], tokens=10)
            gate = review.compare_saved(new, old, "input-tokens")["gate"]
            self.assertEqual(gate["status"], "passed")
            self.assertEqual(gate["successfulPairMetric"]["measuredTrials"], 1)
            self.assertEqual(gate["successfulPairMetric"]["excludedTrials"], 1)
            self.assertEqual(gate["successfulPairMetric"]["meanDelta"], -10)
            trace_path = new.parent / "runs/case-1/trace.json"
            trace = review.read_json(trace_path)
            trace["diagnostics"]["droppedRecords"] = 1
            review.write_json(trace_path, trace)
            self.assertEqual(
                review.compare_saved(new, old, "input-tokens")["gate"]["status"],
                "inconclusive",
            )

    def test_faster_failed_tasks_and_different_platforms_cannot_pass_latency_gate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old = saved_batch(root, "control", [True])
            new = saved_batch(root, "candidate", [False])
            document = review.read_json(new)
            document["runs"][0]["execution"]["elapsedSeconds"] = 0.1
            review.write_json(new, document)
            self.assertEqual(
                review.compare_saved(new, old, "latency")["gate"]["status"], "failed"
            )
            document["runs"][0].update(
                taskPassed=True,
                verification={"status": "passed", "exitCode": 0, "timedOut": False},
            )
            document["configuration"]["platform"] = "different"
            review.write_json(new, document)
            self.assertEqual(
                review.compare_saved(new, old, "latency")["gate"]["status"],
                "inconclusive",
            )

    def test_offline_compare_links_actual_artifacts_and_returns_a_gate_status(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old = saved_batch(root, "control", [False])
            new = saved_batch(root, "candidate", [True])
            output = root / "comparison"
            self.assertEqual(
                review.main(
                    [
                        "compare",
                        "--current",
                        str(new),
                        "--baseline",
                        str(old),
                        "--output",
                        str(output),
                    ]
                ),
                0,
            )
            report = (output / "comparison.md").read_text()
            for label, artifact in (
                ("result", "result.json"),
                ("trace", "trace.json"),
                ("changes", "changes.patch"),
            ):
                # Report links use canonical paths, including macOS /var aliases.
                path = (new.parent / "runs/case-1" / artifact).resolve()
                self.assertIn(f"[{label}]({path.as_posix()})", report)
            result = review.read_json(output / "comparison.json")
            self.assertEqual(result["gate"]["recoveredTrials"], 1)
            self.assertNotIn("current", result)

    def test_feedback_binds_report_artifact_and_existing_event_before_handoff(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = saved_batch(root, "control", [False])
            feedback_path = root / "feedback.json"
            feedback = feedback_for(path)
            review.write_json(feedback_path, feedback)
            loaded = review.load_feedback(feedback_path, path, review.load_report(path))
            self.assertEqual(
                loaded["findings"][0]["evidence"][0]["source"]["threadId"], "root"
            )
            output = root / "handoff"
            self.assertEqual(
                review.main(
                    [
                        "handoff",
                        "--report",
                        str(path),
                        "--feedback",
                        str(feedback_path),
                        "--finding",
                        "1",
                        "--experiment-id",
                        "context-retention",
                        "--factor",
                        "ashExecutableDigest",
                        "--factor",
                        "appServerExecutable",
                        "--output",
                        str(output),
                    ]
                ),
                0,
            )
            control = agent_eval.load_experiment(output / "experiment.control.json")
            candidate = agent_eval.load_experiment(output / "experiment.candidate.json")
            self.assertEqual(control["id"], candidate["id"])
            self.assertNotEqual(control["variant"], candidate["variant"])
            self.assertIn("holdout", (output / "handoff.md").read_text())
            for alteration in ("report", "artifact", "event", "trial"):
                invalid = copy.deepcopy(feedback)
                if alteration == "report":
                    invalid["reportSha256"] = "changed"
                elif alteration == "artifact":
                    invalid["findings"][0]["evidence"][0]["sha256"] = "changed"
                elif alteration == "event":
                    invalid["findings"][0]["evidence"][0]["eventId"] = "missing"
                else:
                    invalid["findings"][0]["repetition"] = 2
                review.write_json(feedback_path, invalid)
                with self.subTest(alteration=alteration), self.assertRaises(ValueError):
                    review.load_feedback(feedback_path, path, review.load_report(path))

    def test_saved_acceptance_and_artifact_scope_are_validated(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = saved_batch(root, "control", [False])
            original = review.read_json(path)
            invalid = copy.deepcopy(original)
            invalid["runs"][0]["taskPassed"] = True
            review.write_json(path, invalid)
            with self.assertRaisesRegex(ValueError, "acceptance"):
                review.load_report(path)
            invalid = copy.deepcopy(original)
            invalid["runs"][0]["artifactDirectory"] = "../../outside"
            review.write_json(path, invalid)
            with self.assertRaisesRegex(ValueError, "within"):
                review.load_report(path)
            invalid = copy.deepcopy(original)
            invalid["runs"][0]["verification"]["status"] = "passed"
            review.write_json(path, invalid)
            with self.assertRaisesRegex(ValueError, "verifier status"):
                review.load_report(path)

    def test_execution_evidence_missing_or_inconsistent_prevents_quality_promotion(
        self,
    ):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old = saved_batch(root, "control", [False])
            new = saved_batch(root, "candidate", [True])
            events = new.parent / "runs/case-1/events.jsonl"
            events.write_text('{"schemaVersion":1,"event":{"type":"runStarted"}}\n')
            result = review.compare_saved(new, old, "quality")
            self.assertEqual(
                result["current"]["runs"][0]["executionEvidence"]["status"],
                "inconsistent",
            )
            self.assertEqual(result["gate"]["status"], "inconclusive")
            events.unlink()
            self.assertEqual(
                review.compare_saved(new, old, "quality")["gate"]["status"],
                "inconclusive",
            )

    def test_audit_runs_both_controls_and_detects_a_grader_that_always_passes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            suite = agent_eval.ROOT / "test/agent-eval"
            result = review.audit_suite(suite, root / "audit")
            self.assertTrue(result["passed"])
            self.assertEqual(len(result["cases"]), 3)
            self.assertTrue(all(len(case["controls"]) == 2 for case in result["cases"]))
            copied = root / "invalid-suite"
            shutil.copytree(suite, copied)
            (copied / "verifiers/prefix_filter.py").write_text("pass\n")
            result = review.audit_suite(copied, root / "bad-audit")
            self.assertFalse(result["passed"])
            self.assertEqual(result["cases"][0]["controls"][0]["status"], "failed")
            (copied / "verifiers/prefix_filter.py").write_text(
                "import sys\nsys.exit(2)\n"
            )
            result = review.audit_suite(copied, root / "error-audit")
            self.assertEqual(
                result["cases"][0]["controls"][1]["verification"]["status"], "error"
            )

    @unittest.skipIf(os.name == "nt", "Fixture executable uses a Unix shebang.")
    def test_preflight_rejects_changed_conditions_before_launching_any_model(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            marker = root / "model-was-called"
            executable = root / "ash"
            executable.write_text(
                f"#!{sys.executable}\nfrom pathlib import Path\nPath({str(marker)!r}).touch()\n"
            )
            executable.chmod(0o755)
            template = root / "profile"
            template.mkdir()
            args = [
                "--ash",
                str(executable),
                "--profile-template",
                str(template),
                "--model",
                "fixture/model",
                "--output",
                str(root / "candidate"),
                "--split",
                "holdout",
            ]
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                self.assertEqual(agent_eval.main([*args, "--preflight-only"]), 0)
            configuration = json.loads(stdout.getvalue())["configuration"]
            self.assertEqual(
                configuration["caseSelection"]["caseIds"], ["atomic-settings"]
            )
            self.assertFalse((root / "candidate").exists())
            baseline = {
                "schemaVersion": 2,
                "configuration": {**configuration, "timeoutSeconds": 1},
                "runs": [],
            }
            path = root / "baseline.json"
            review.write_json(path, baseline)
            with (
                redirect_stderr(io.StringIO()),
                self.assertRaises(SystemExit) as failure,
            ):
                agent_eval.main([*args, "--baseline", str(path)])
            self.assertEqual(failure.exception.code, 2)
            self.assertFalse(marker.exists())
            self.assertFalse((root / "candidate").exists())


if __name__ == "__main__":
    unittest.main()
