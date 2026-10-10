"""Check independent task acceptance, artifact links and bounded process failures."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import agent_eval


class AgentEvalTests(unittest.TestCase):
    def test_declared_experiment_allows_only_named_profile_and_model_changes(self):
        declaration = {
            "schemaVersion": 1,
            "id": "tool-ablation",
            "variant": "control",
            "hypothesis": "Changing one tool should improve results",
            "changedFactors": ["profile:/tools/search/enabled"],
        }
        config = {
            "suiteDigest": "suite",
            "timeoutSeconds": 120,
            "approval": "denyInteractiveRequests",
            "repetitions": 2,
            "model": "p/m",
            "profileConfigDigest": "old",
            "experiment": declaration,
            "profileFactors": agent_eval.profile_factors(
                b"[tools.search]\nenabled = false\n[tools.shell]\nenabled = true\n"
            ),
        }
        candidate = {
            **config,
            "profileConfigDigest": "new",
            "experiment": {**declaration, "variant": "candidate"},
            "profileFactors": agent_eval.profile_factors(
                b"[tools.search]\nenabled = true\n[tools.shell]\nenabled = true\n"
            ),
        }
        self.assertEqual(
            set(agent_eval.changed_conditions(candidate, config)),
            {"profile:/tools/search/enabled"},
        )
        candidate["profileFactors"] = agent_eval.profile_factors(
            b"[tools.search]\nenabled = true\n[tools.shell]\nenabled = false\n"
        )
        with self.assertRaisesRegex(ValueError, "undeclared.*shell"):
            agent_eval.changed_conditions(candidate, config)
        with self.assertRaisesRegex(ValueError, "undeclared.*model"):
            agent_eval.changed_conditions({**config, "model": "p/another"}, config)
        self.assertNotIn("false", json.dumps(config["profileFactors"]))

    def test_experiment_manifest_cannot_allow_task_or_permission_policy_drift(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "experiment.json"
            declaration = {
                "schemaVersion": 1,
                "id": "routing",
                "variant": "control",
                "hypothesis": "A model change affects completion",
                "changedFactors": ["model"],
            }
            path.write_text(json.dumps(declaration))
            self.assertEqual(agent_eval.load_experiment(path), declaration)
            for factor in (
                "suiteDigest",
                "approval",
                "timeoutSeconds",
                "repetitions",
                "profileConfigDigest",
            ):
                path.write_text(json.dumps({**declaration, "changedFactors": [factor]}))
                with self.assertRaises(ValueError):
                    agent_eval.load_experiment(path)

    def test_grader_failures_are_separate_from_completed_task_failures(self):
        runs = [
            {
                "caseId": "case",
                "repetition": index,
                "taskPassed": False,
                "executionStatus": "completed",
                "execution": {"elapsedSeconds": 1},
                "verification": {"status": status},
            }
            for index, status in enumerate(("failed", "error", "timedOut"), 1)
        ]
        self.assertEqual(
            agent_eval.summarize(runs)["grading"],
            {"gradedRuns": 1, "errorRuns": 1, "timedOutRuns": 1, "unknownRuns": 0},
        )

    def test_verification_uses_retained_turn_results_and_rejects_partial_captures(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workspace = root / "workspace"
            workspace.mkdir()
            original = workspace / "before.py"
            original.write_bytes(b"old\r\n")
            identity = {"sessionId": "s", "threadId": "t", "turnId": "turn"}
            entry = {
                "file": {
                    "path": "after.py",
                    "previousPath": "before.py",
                    "kind": "renamed",
                    "binary": False,
                    "afterMode": "100755",
                },
                "content": {
                    "path": "after.py",
                    "binary": False,
                    "truncated": False,
                    "before": "old\r\n",
                    "after": "新\r\n",
                },
            }
            artifact = {
                "formatVersion": 1,
                **identity,
                "changeSets": [
                    {"summary": {"captureState": "sealed"}, "files": [entry]}
                ],
            }
            path = root / "changes.json"
            for invalid in [
                {**artifact, "turnId": "other"},
                {
                    **artifact,
                    "changeSets": [
                        {"summary": {"captureState": "incomplete"}, "files": [entry]}
                    ],
                },
                {
                    **artifact,
                    "changeSets": [
                        {
                            "summary": {"captureState": "sealed"},
                            "files": [
                                {
                                    **entry,
                                    "content": {**entry["content"], "truncated": True},
                                }
                            ],
                        }
                    ],
                },
                {
                    **artifact,
                    "changeSets": [
                        {
                            "summary": {"captureState": "sealed"},
                            "files": [
                                {
                                    **entry,
                                    "file": {**entry["file"], "path": "../outside.py"},
                                }
                            ],
                        }
                    ],
                },
            ]:
                path.write_text(json.dumps(invalid))
                with self.assertRaises(ValueError):
                    agent_eval.restore_turn_changes(path, workspace, identity)
                self.assertEqual(original.read_bytes(), b"old\r\n")
                self.assertFalse((workspace / "after.py").exists())
            path.write_text(json.dumps(artifact))
            self.assertEqual(
                agent_eval.restore_turn_changes(path, workspace, identity),
                {"status": "restored", "files": 1},
            )
            self.assertFalse(original.exists())
            self.assertEqual((workspace / "after.py").read_bytes(), "新\r\n".encode())

    def test_seed_verifiers_reject_the_unmodified_bugs(self):
        suite = agent_eval.ROOT / "test/agent-eval"
        for case in agent_eval.load_suite(suite)["cases"]:
            with self.subTest(case=case["id"]):
                result = subprocess.run(
                    [
                        sys.executable,
                        "-B",
                        str(suite / case["verifier"]),
                        str(suite / case["fixture"]),
                    ],
                    capture_output=True,
                )
                self.assertNotEqual(result.returncode, 0)

    def test_hard_process_timeout_and_missing_executable_are_reported(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            timeout = agent_eval.run_process(
                [sys.executable, "-c", "import threading; threading.Event().wait()"],
                root,
                dict(os.environ),
                0.1,
                root / "out",
                root / "err",
            )
            self.assertTrue(timeout["timedOut"])
            self.assertNotEqual(timeout["exitCode"], 0)
            missing = agent_eval.run_process(
                [str(root / "missing")],
                root,
                dict(os.environ),
                1,
                root / "out",
                root / "err",
            )
            self.assertIsNone(missing["exitCode"])
            self.assertIn("spawnError", missing)

    def test_typed_timeout_is_distinct_from_a_completed_but_failed_verification(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "events.jsonl"
            path.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "event": {
                            "type": "runCompleted",
                            "outcome": {"type": "interrupted", "reason": "turnTimeout"},
                        },
                    }
                )
                + "\n"
            )
            self.assertEqual(
                agent_eval.execution_status(path, {"timedOut": False})[0], "timedOut"
            )
            path.write_text('{"schemaVersion":1,"event":{"type":"runStarted"}}\n')
            self.assertEqual(
                agent_eval.execution_status(path, {"timedOut": False}),
                ("outcomeUnknown", None),
            )

    def test_comparison_rejects_changed_tasks_or_execution_policy(self):
        configuration = {
            "suiteDigest": "suite",
            "profileConfigDigest": "profile",
            "timeoutSeconds": 120,
            "approval": "denyInteractiveRequests",
            "repetitions": 2,
            "model": "p/m",
        }
        runs = [
            {
                "caseId": "case",
                "repetition": repetition,
                "taskPassed": passed,
                "executionStatus": "completed",
                "execution": {"elapsedSeconds": 1},
            }
            for repetition, passed in enumerate([True, False], 1)
        ]
        baseline = {"configuration": configuration, "runs": runs}
        current = {
            "configuration": {**configuration, "model": "p/new"},
            "runs": [{**run, "taskPassed": True} for run in runs],
        }
        self.assertEqual(
            agent_eval.compare(current, baseline)["cases"]["case"]["passRateDelta"], 0.5
        )
        with self.assertRaisesRegex(ValueError, "suiteDigest"):
            agent_eval.compare(
                {
                    **current,
                    "configuration": {**configuration, "suiteDigest": "changed"},
                },
                baseline,
            )

    def test_baseline_comparison_rejects_missing_duplicate_and_replaced_trials(self):
        configuration = {
            "suiteDigest": "suite",
            "profileConfigDigest": "profile",
            "timeoutSeconds": 120,
            "approval": "denyInteractiveRequests",
            "repetitions": 2,
            "model": "p/m",
        }
        runs = [
            {
                "caseId": "case",
                "repetition": repetition,
                "taskPassed": True,
                "executionStatus": "completed",
                "execution": {"elapsedSeconds": 1},
            }
            for repetition in [1, 2]
        ]
        report = {"configuration": configuration, "runs": runs}
        for invalid in [
            runs[:1],
            [runs[0], runs[0]],
            [{**run, "caseId": "other"} for run in runs],
            [{**run, "taskPassed": "false"} for run in runs],
        ]:
            with self.subTest(trials=invalid), self.assertRaises(ValueError):
                agent_eval.compare(report, {**report, "runs": invalid})

    def test_repeated_success_and_complete_measurements_are_distinct_from_partial_reports(
        self,
    ):
        configuration = {
            "suiteDigest": "suite",
            "profileConfigDigest": "profile",
            "timeoutSeconds": 120,
            "approval": "denyInteractiveRequests",
            "repetitions": 3,
            "model": "p/m",
        }
        runs = [
            {
                "caseId": identity,
                "repetition": repetition,
                "taskPassed": identity == "stable" or repetition != 2,
                "executionStatus": "completed",
                "execution": {"elapsedSeconds": 2},
                "trace": {
                    "analysisVersion": 1,
                    "captureStatus": "saved",
                    "modelCalls": 2,
                    "inputTokensReported": 10,
                    "outputTokensReported": None,
                    "usage": {
                        "inputTokens": {"complete": repetition != 2},
                        "outputTokens": {"complete": False},
                    },
                    "modelAttempts": None,
                    "failedAttempts": None,
                    "diagnosticEvidenceComplete": False,
                    "usageComparisonComplete": True,
                },
            }
            for identity in ["stable", "variable"]
            for repetition in [1, 2, 3]
        ]
        summary = agent_eval.summarize(runs)
        self.assertEqual(summary["passRate"], 5 / 6)
        reliability = summary["repeatReliability"]
        self.assertEqual(reliability["observedAnyPassRate"], 1)
        self.assertEqual(reliability["observedAllPassRate"], 0.5)
        self.assertEqual(reliability["trialsPerCase"], 3)
        self.assertEqual(
            summary["processMetrics"]["inputTokensReported"]["reportedRuns"], 6
        )
        self.assertEqual(
            summary["processMetrics"]["inputTokensReported"]["completeRuns"], 4
        )
        self.assertIsNone(
            summary["processMetrics"]["outputTokensReported"]["meanComplete"]
        )
        current = {
            "configuration": {
                **configuration,
                "model": "p/new",
                "ashExecutableDigest": "new-product",
            },
            "runs": [
                {
                    **run,
                    "taskPassed": True,
                    "trace": {**run["trace"], "inputTokensReported": 8},
                }
                for run in runs
            ],
        }
        comparison = agent_eval.compare(
            current, {"configuration": configuration, "runs": runs}
        )
        self.assertEqual(
            set(comparison["changedFactors"]), {"model", "ashExecutableDigest"}
        )
        variable = comparison["cases"]["variable"]
        self.assertEqual(variable["recoveredTrials"], 1)
        tokens = variable["processMetrics"]["inputTokensReported"]
        self.assertEqual(tokens["pairedRuns"], 2)
        self.assertEqual(tokens["excludedRuns"], 1)
        self.assertEqual(tokens["meanDelta"], -2)
        self.assertIsNone(variable["processMetrics"]["modelAttempts"]["meanDelta"])
        environment_changed = agent_eval.compare(
            {
                **current,
                "configuration": {
                    **current["configuration"],
                    "platform": "another-platform",
                },
            },
            {"configuration": configuration, "runs": runs},
        )
        self.assertEqual(
            environment_changed["cases"]["stable"]["processMetrics"]["elapsedSeconds"][
                "pairedRuns"
            ],
            0,
        )
        for value in [True, -1, "10", float("nan")]:
            with (
                self.subTest(metric=value),
                self.assertRaisesRegex(ValueError, "metric"),
            ):
                agent_eval.metric_observation(
                    {"execution": {"elapsedSeconds": value}}, "elapsedSeconds"
                )

    @unittest.skipIf(
        os.name == "nt",
        "The fixture executable uses a Unix shebang; process bounds are tested on every platform.",
    )
    def test_completed_exec_cannot_pass_without_an_independent_verifier(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            executable = root / "ash-fixture"
            executable.write_text(
                f"#!{sys.executable}\n"
                + """import json, pathlib, sys
if sys.argv[1] == 'exec':
    path = pathlib.Path(sys.argv[sys.argv.index('--trace-output') + 1])
    path.write_text(json.dumps({'formatVersion':3,'sessionId':'s','threads':[{'threadId':'root','events':[]}],'historyPrefixes':[]}))
    changes = pathlib.Path(sys.argv[sys.argv.index('--changes-output') + 1])
    changes.write_text(json.dumps({'formatVersion':1,'sessionId':'s','threadId':'root','turnId':'t','changeSets':[{'summary':{'captureState':'sealed'},'files':[]}]}))
    print(json.dumps({'schemaVersion':1,'event':{'type':'runCompleted','outcome':{'type':'completed','sessionId':'s','threadId':'root','turnId':'t'}}}))
"""
            )
            executable.chmod(0o755)
            profile = root / "template"
            profile.mkdir()
            output = root / "results"
            exit_code = agent_eval.main(
                [
                    "--ash",
                    str(executable),
                    "--profile-template",
                    str(profile),
                    "--model",
                    "fixture/model",
                    "--output",
                    str(output),
                    "--repeat",
                    "2",
                ]
            )
            report = json.loads((output / "report.json").read_text())
            self.assertEqual(exit_code, 1)
            self.assertEqual(report["summary"]["executionCompleted"], 6)
            self.assertEqual(report["summary"]["passed"], 0)
            self.assertEqual(report["schemaVersion"], 2)
            self.assertEqual(
                report["summary"]["repeatReliability"]["casesWithAllPasses"], 0
            )
            self.assertEqual(
                report["summary"]["processMetrics"]["inputTokensReported"][
                    "reportedRuns"
                ],
                0,
            )
            self.assertIn("unknown", (output / "report.md").read_text())
            self.assertTrue(
                all(run["verification"]["status"] == "failed" for run in report["runs"])
            )
            self.assertTrue(
                all(
                    (output / run["artifactDirectory"] / "trace.json").is_file()
                    for run in report["runs"]
                )
            )
            self.assertTrue(all("retainedProfile" not in run for run in report["runs"]))


if __name__ == "__main__":
    unittest.main()
