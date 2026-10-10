"""Opt-in real ash exec -> model stream -> tool -> retained result -> verifier contract."""

from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import shutil
import tempfile
import threading
import unittest

import agent_eval
import agent_eval_review


SOLUTIONS = {
    path.name: path.read_text(encoding="utf-8")
    for path in (agent_eval.ROOT / "test/agent-eval/reference-solutions").rglob("*.py")
}


@unittest.skipUnless(
    os.environ.get("ASH_AGENT_EVAL_TEST_BINARY"),
    "Requires an explicitly built ash product executable.",
)
class AgentEvalProductTests(unittest.TestCase):
    def test_product_tools_produce_independently_verified_results_and_importable_traces(
        self,
    ):
        executable = Path(os.environ["ASH_AGENT_EVAL_TEST_BINARY"]).resolve()
        self.assertTrue(executable.is_file())
        requests = []
        failures = []
        suite = agent_eval.ROOT / "test/agent-eval"
        behavior = {"name": "repair"}

        class FixtureHandler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                try:
                    request = json.loads(
                        self.rfile.read(int(self.headers["Content-Length"]))
                    )
                    requests.append(request)
                    control_request = self.path == "/control/v1/chat/completions"
                    if behavior["name"] == "hang":
                        self.send_response(200)
                        self.send_header("Content-Type", "text/event-stream")
                        self.end_headers()
                        self.wfile.write(
                            b'data: {"choices":[{"index":0,"delta":{"content":"fixture partial output"},"finish_reason":null}]}\n\n'
                        )
                        self.wfile.flush()
                        threading.Event().wait(5)
                        self.close_connection = True
                        return
                    if behavior["name"] == "retry" and behavior.get("remaining", 0):
                        behavior["remaining"] -= 1
                        body = b'{"error":{"message":"fixture temporary failure","type":"server_error"}}'
                        self.send_response(500)
                        self.send_header("Content-Type", "application/json")
                        self.send_header("Retry-After", "0")
                        self.send_header("Content-Length", str(len(body)))
                        self.end_headers()
                        self.wfile.write(body)
                        return
                    if behavior["name"] == "reject":
                        body = json.dumps(
                            {
                                "error": {
                                    "message": "fixture model failure",
                                    "type": "invalid_request_error",
                                }
                            }
                        ).encode()
                        self.send_response(400)
                        self.send_header("Content-Type", "application/json")
                        self.send_header("Content-Length", str(len(body)))
                        self.end_headers()
                        self.wfile.write(body)
                        return
                    if (
                        self.path
                        not in {"/v1/chat/completions", "/control/v1/chat/completions"}
                        or request["model"] != "fixture-model"
                    ):
                        raise ValueError(
                            "expected the explicit custom model's chat completions route"
                        )
                    messages = request["messages"]
                    if control_request:
                        delta, finish = (
                            {
                                "content": "Fixture claimed completion without repairing the files."
                            },
                            "stop",
                        )
                    elif any(message.get("role") == "tool" for message in messages):
                        delta, finish = {"content": "Fixture repair completed."}, "stop"
                    else:
                        prompt = json.dumps(messages)
                        filename = next(name for name in SOLUTIONS if name in prompt)
                        case = next(
                            case
                            for case in agent_eval.load_suite(suite)["cases"]
                            if filename in case["prompt"]
                        )
                        before = (suite / case["fixture"] / filename).read_text()
                        patch = (
                            "\n".join(
                                [
                                    "*** Begin Patch",
                                    f"*** Update File: {filename}",
                                    "@@",
                                    *["-" + line for line in before.splitlines()],
                                    *[
                                        "+" + line
                                        for line in SOLUTIONS[filename].splitlines()
                                    ],
                                    "*** End Patch",
                                ]
                            )
                            + "\n"
                        )
                        tools = [tool["function"]["name"] for tool in request["tools"]]
                        if "apply_patch" in tools:
                            tool, arguments = "apply_patch", {"patch": patch}
                        elif "exec" in tools:
                            tool = "exec"
                            source = (
                                "const entry = ALL_TOOLS.find(t => t.toolName === 'apply_patch' || t.name === 'apply_patch' || t.name.endsWith('_apply_patch')); if (!entry) throw new Error('Missing patch tool'); text(await tools[entry.name]("
                                + json.dumps({"patch": patch})
                                + "));"
                            )
                            arguments = {
                                "source": source,
                                "yieldTimeMs": 10000,
                                "maxOutputTokens": 2000,
                            }
                        else:
                            raise ValueError(
                                f"missing the product patch or code tool: {tools}"
                            )
                        delta = {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "id": f"fixture-{filename}",
                                    "type": "function",
                                    "function": {
                                        "name": tool,
                                        "arguments": json.dumps(arguments),
                                    },
                                }
                            ]
                        }
                        finish = "tool_calls"
                    payload = {
                        "choices": [
                            {"index": 0, "delta": delta, "finish_reason": finish}
                        ],
                        "usage": {"prompt_tokens": 20, "completion_tokens": 5},
                    }
                    data = (
                        "data: " + json.dumps(payload) + "\n\ndata: [DONE]\n\n"
                    ).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except Exception as error:
                    failures.append(str(error))
                    self.send_error(500, "Fixture contract failed")

        server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory(
                prefix="ash-agent-eval-product-"
            ) as temporary:
                root = Path(temporary)
                template = root / "profile"
                template.mkdir()
                (template / "config.toml").write_text(f"""schemaVersion = 10
[connections.custom-eval]
provider = "custom-eval"
connection = "custom-eval"
baseUrl = "http://127.0.0.1:{server.server_port}/v1"
[connections.custom-eval.custom]
model = "fixture-model"
name = "Eval contract fixture"
protocol = "chatCompletions"
contextWindow = 272000
order = 0
""")
                environment = {
                    **os.environ,
                    "ASH_HOME": str(template),
                    "ASH_WORKSPACE_ROOT": str(root),
                }
                try:
                    login = subprocess.run(
                        [str(executable), "login", "api-key", "custom-eval"],
                        input="eval-fixture-not-a-real-key\n",
                        text=True,
                        env=environment,
                        cwd=root,
                        capture_output=True,
                        timeout=30,
                    )
                    self.assertEqual(login.returncode, 0, login.stderr)
                    output = (
                        Path(os.environ["ASH_AGENT_EVAL_TEST_OUTPUT"]).resolve()
                        if os.environ.get("ASH_AGENT_EVAL_TEST_OUTPUT")
                        else root / "results"
                    )
                    help_result = subprocess.run(
                        [str(executable), "exec", "--help"],
                        env={**environment, "LC_ALL": "zh_CN.UTF-8"},
                        capture_output=True,
                        text=True,
                        timeout=15,
                    )
                    self.assertEqual(help_result.returncode, 0, help_result.stderr)
                    self.assertIn(
                        "本次 Turn 使用的准确 provider/model 标识", help_result.stdout
                    )
                    self.assertIn("保存本次 Turn 的变更记录", help_result.stdout)
                    audit = agent_eval_review.audit_suite(
                        suite, output.parent / f"{output.name}-audit"
                    )
                    self.assertTrue(audit["passed"])
                    control_template = root / "control-profile"
                    shutil.copytree(template, control_template)
                    control_config = (control_template / "config.toml").read_text()
                    (control_template / "config.toml").write_text(
                        control_config.replace('/v1"', '/control/v1"')
                    )
                    declaration = {
                        "schemaVersion": 1,
                        "id": "scripted-product-loop-contract",
                        "variant": "control",
                        "hypothesis": "The scripted candidate repairs independently checked files while the scripted control only claims completion. This validates the workflow, not real model quality.",
                        "changedFactors": ["profile:/connections/custom-eval/baseUrl"],
                    }
                    control_manifest = root / "experiment.control.json"
                    candidate_manifest = root / "experiment.candidate.json"
                    agent_eval_review.write_json(control_manifest, declaration)
                    agent_eval_review.write_json(
                        candidate_manifest, {**declaration, "variant": "candidate"}
                    )
                    control_output = output.parent / f"{output.name}-control"
                    self.assertEqual(
                        agent_eval.main(
                            [
                                "--ash",
                                str(executable),
                                "--profile-template",
                                str(control_template),
                                "--model",
                                "custom-eval/fixture-model",
                                "--output",
                                str(control_output),
                                "--timeout-seconds",
                                "30",
                                "--approval",
                                "bypassPermissions",
                                "--experiment",
                                str(control_manifest),
                            ]
                        ),
                        1,
                    )
                    control_report = agent_eval_review.load_report(
                        control_output / "report.json"
                    )
                    self.assertEqual(control_report["summary"]["executionCompleted"], 3)
                    self.assertEqual(control_report["summary"]["passed"], 0)
                    exit_code = agent_eval.main(
                        [
                            "--ash",
                            str(executable),
                            "--profile-template",
                            str(template),
                            "--model",
                            "custom-eval/fixture-model",
                            "--output",
                            str(output),
                            "--timeout-seconds",
                            "30",
                            "--approval",
                            "bypassPermissions",
                            "--baseline",
                            str(control_output / "report.json"),
                            "--experiment",
                            str(candidate_manifest),
                        ]
                    )
                    report = json.loads((output / "report.json").read_text())
                    diagnostics = {
                        "failures": failures,
                        "runs": report["runs"],
                        "stderr": [
                            (
                                output / run["artifactDirectory"] / "execution.stderr"
                            ).read_text()
                            for run in report["runs"]
                        ],
                        "serverLogs": [
                            (
                                output / run["artifactDirectory"] / "server.log"
                            ).read_text()
                            if (
                                output / run["artifactDirectory"] / "server.log"
                            ).is_file()
                            else "not captured"
                            for run in report["runs"]
                        ],
                    }
                    self.assertEqual(exit_code, 0, json.dumps(diagnostics, indent=2))
                    self.assertEqual(report["summary"]["passed"], 3)
                    self.assertEqual(len(requests), 9)
                    comparison_output = output.parent / f"{output.name}-comparison"
                    self.assertEqual(
                        agent_eval_review.main(
                            [
                                "compare",
                                "--baseline",
                                str(control_output / "report.json"),
                                "--current",
                                str(output / "report.json"),
                                "--output",
                                str(comparison_output),
                            ]
                        ),
                        0,
                    )
                    comparison = agent_eval_review.read_json(
                        comparison_output / "comparison.json"
                    )
                    self.assertEqual(comparison["gate"]["recoveredTrials"], 3)
                    self.assertEqual(comparison["gate"]["regressedTrials"], 0)
                    review_output = output.parent / f"{output.name}-review"
                    self.assertEqual(
                        agent_eval_review.main(
                            [
                                "review",
                                "--report",
                                str(control_output / "report.json"),
                                "--output",
                                str(review_output),
                            ]
                        ),
                        0,
                    )
                    finding = {
                        "caseId": "prefix-filter",
                        "repetition": 1,
                        "component": "unknown",
                        "observation": "The scripted control completed without file edits and failed the independent verifier.",
                        "hypothesis": declaration["hypothesis"],
                        "proposedChange": "Exercise the scripted repair candidate through the same Ash tools and retained-result contract.",
                        "acceptance": "All three independent task checks recover; no trial regresses. This is contract coverage, not a real harness quality score.",
                        "evidence": [],
                    }
                    for artifact in ("trace.json", "verifier.stderr", "changes.patch"):
                        evidence = agent_eval_review.evidence_file(
                            control_output / "report.json",
                            control_report["runs"][0],
                            artifact,
                        )
                        finding["evidence"].append(
                            {"artifact": artifact, "sha256": evidence["sha256"]}
                        )
                    feedback = {
                        "schemaVersion": 1,
                        "reportSha256": agent_eval_review.source_identity(
                            control_output / "report.json"
                        )["sha256"],
                        "findings": [finding],
                    }
                    feedback_path = review_output / "feedback.json"
                    agent_eval_review.write_json(feedback_path, feedback)
                    self.assertEqual(
                        agent_eval_review.main(
                            [
                                "handoff",
                                "--report",
                                str(control_output / "report.json"),
                                "--feedback",
                                str(feedback_path),
                                "--finding",
                                "1",
                                "--experiment-id",
                                "reviewed-contract-fixture",
                                "--factor",
                                "profile:/connections/custom-eval/baseUrl",
                                "--output",
                                str(output.parent / f"{output.name}-handoff"),
                            ]
                        ),
                        0,
                    )
                    for run in report["runs"]:
                        trace = json.loads(
                            (
                                output / run["artifactDirectory"] / "trace.json"
                            ).read_text()
                        )
                        events = [
                            record["event"]
                            for item in trace["threads"]
                            for record in item["events"]
                        ]
                        self.assertEqual(
                            sum(
                                event["type"] == "modelInvocationRecorded"
                                for event in events
                            ),
                            2,
                        )
                        self.assertTrue(
                            any(
                                event["type"] == "itemCompleted"
                                and event.get("item", {}).get("type") == "toolCall"
                                for event in events
                            )
                        )
                        self.assertTrue(
                            any(
                                event["type"] == "itemCompleted"
                                and event.get("item", {}).get("type") == "toolResult"
                                for event in events
                            )
                        )
                        self.assertTrue(run["trace"]["usageComplete"])
                        self.assertEqual(run["trace"]["analysisVersion"], 2)
                        self.assertTrue(run["trace"]["diagnosticEvidenceComplete"])
                        self.assertTrue(run["trace"]["usageComparisonComplete"])
                        self.assertGreaterEqual(run["trace"]["toolCalls"], 1)
                        self.assertEqual(
                            run["trace"]["toolResults"], run["trace"]["toolCalls"]
                        )
                        self.assertEqual(run["trace"]["failedToolResults"], 0)
                        selection = run["trace"]["instructionSelections"][0]
                        self.assertEqual(
                            len(selection["instructions"]["snapshotDigest"]), 64
                        )
                        self.assertTrue(
                            any(
                                record["eventId"] == selection["source"]["eventId"]
                                for thread in trace["threads"]
                                for record in thread["events"]
                            )
                        )
                        self.assertEqual(run["trace"]["modelAttempts"], 2)
                        self.assertEqual(
                            run["trace"]["diagnosticRecordingStatus"], "recording"
                        )
                        diagnostic = trace["diagnostics"]
                        self.assertEqual(diagnostic["formatVersion"], 2)
                        self.assertEqual(diagnostic["pendingRecords"], 0)
                        self.assertEqual(len(diagnostic["events"]), 8)
                        self.assertEqual(len(diagnostic["payloads"]), 6)
                        self.assertEqual(len(run["trace"]["accountingLinks"]), 2)
                        for receipt in run["trace"]["accountingLinks"]:
                            source = receipt["accountingSource"]
                            self.assertIsNotNone(source)
                            committed = next(
                                record
                                for thread in trace["threads"]
                                if thread["threadId"] == source["threadId"]
                                for record in thread["events"]
                                if record["eventId"] == source["eventId"]
                            )
                            self.assertEqual(
                                committed["event"]["record"]["invocationId"],
                                receipt["invocationId"],
                            )
                        for observation in diagnostic["events"]:
                            event = observation["event"]
                            for field in ["requestPayload", "responsePayload"]:
                                if field in event:
                                    self.assertIn(
                                        event[field]["payloadId"],
                                        diagnostic["payloads"],
                                    )
                        self.assertTrue(
                            any(
                                edge["kind"] == "requestsTool"
                                for edge in trace["graph"]["edges"]
                            )
                        )
                        self.assertEqual(
                            sum(
                                edge["kind"] == "accountsFor"
                                for edge in trace["graph"]["edges"]
                            ),
                            2,
                        )
                        self.assertNotIn("retainedProfile", run)
                    failure_suite = root / "failure-suite"
                    shutil.copytree(suite, failure_suite)
                    manifest = agent_eval.load_suite(suite)
                    manifest["cases"] = manifest["cases"][:1]
                    (failure_suite / "suite.json").write_text(json.dumps(manifest))
                    for mode, expected_status in [
                        ("reject", "failed"),
                        ("hang", "timedOut"),
                        ("retry", "completed"),
                    ]:
                        with self.subTest(behavior=mode):
                            behavior["name"] = mode
                            behavior["remaining"] = 1
                            failed_output = output.parent / f"{output.name}-{mode}"
                            failed_exit = agent_eval.main(
                                [
                                    "--ash",
                                    str(executable),
                                    "--profile-template",
                                    str(template),
                                    "--model",
                                    "custom-eval/fixture-model",
                                    "--output",
                                    str(failed_output),
                                    "--suite",
                                    str(failure_suite),
                                    "--timeout-seconds",
                                    "30" if mode == "retry" else "1",
                                    "--approval",
                                    "bypassPermissions",
                                ]
                            )
                            failed_report = json.loads(
                                (failed_output / "report.json").read_text()
                            )
                            failed = failed_report["runs"][0]
                            self.assertEqual(failed_exit, 0 if mode == "retry" else 1)
                            self.assertEqual(
                                failed["executionStatus"],
                                expected_status,
                                json.dumps(failed, indent=2),
                            )
                            self.assertEqual(failed["trace"]["captureStatus"], "saved")
                            self.assertEqual(
                                failed["materialization"]["status"], "restored"
                            )
                            self.assertEqual(failed["taskPassed"], mode == "retry")
                            captured = json.loads(
                                (
                                    failed_output
                                    / failed["artifactDirectory"]
                                    / "trace.json"
                                ).read_text()
                            )
                            observations = captured["diagnostics"]["events"]
                            kinds = [record["event"]["type"] for record in observations]
                            self.assertIn("modelAttemptStarted", kinds)
                            if mode in ["reject", "retry"]:
                                self.assertIn("modelAttemptFailed", kinds)
                            if mode == "retry":
                                self.assertFalse(
                                    failed["trace"]["usageComparisonComplete"]
                                )
                                self.assertEqual(
                                    failed_report["summary"]["processMetrics"][
                                        "inputTokensReported"
                                    ]["completeRuns"],
                                    0,
                                )
                                self.assertEqual(failed["trace"]["modelAttempts"], 3)
                                self.assertEqual(failed["trace"]["failedAttempts"], 1)
                                evidence = next(
                                    item
                                    for item in failed["trace"]["observations"]
                                    if item["kind"] == "modelAttemptFailed"
                                )
                                self.assertIn(
                                    evidence["source"]["eventId"],
                                    {record["eventId"] for record in observations},
                                )
                            if mode == "hang":
                                self.assertFalse(failed["trace"]["usageComplete"])
                                self.assertIn("modelAttemptCancelled", kinds)
                                ended = next(
                                    record["event"]
                                    for record in observations
                                    if record["event"]["type"]
                                    == "modelAttemptCancelled"
                                )
                                partial = captured["diagnostics"]["payloads"][
                                    ended["partialOutput"]["payloadId"]
                                ]
                                self.assertEqual(
                                    partial["text"], "fixture partial output"
                                )
                            self.assertNotIn("retainedProfile", failed)
                finally:
                    subprocess.run(
                        [str(executable), "app-server", "daemon", "stop"],
                        env=environment,
                        cwd=root,
                        capture_output=True,
                        timeout=15,
                        check=True,
                    )
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
