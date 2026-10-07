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


SOLUTIONS = {
    "app.py": "def select_names(names, prefix):\n    return [name for name in names if name.casefold().startswith(prefix.casefold())]\n",
    "document.py": 'import re\n\n\ndef line_count(text):\n    return len(re.split(r"\\r\\n|\\r|\\n", text))\n',
    "settings.py": """import json


class Settings:
    def __init__(self):
        self.current = {"name": "default", "enabled": False}

    def reload(self, path):
        candidate = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(candidate, dict) or set(candidate) != {"name", "enabled"} or not isinstance(candidate["name"], str) or not isinstance(candidate["enabled"], bool):
            raise ValueError("invalid settings")
        self.current = candidate
""",
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
                    if behavior["name"] == "hang":
                        self.send_response(200)
                        self.send_header("Content-Type", "text/event-stream")
                        self.end_headers()
                        self.wfile.write(b'data: {"choices":[{"index":0,"delta":{"content":"fixture partial output"},"finish_reason":null}]}\n\n')
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
                        self.path != "/v1/chat/completions"
                        or request["model"] != "fixture-model"
                    ):
                        raise ValueError(
                            "expected the explicit custom model's chat completions route"
                        )
                    messages = request["messages"]
                    if any(message.get("role") == "tool" for message in messages):
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
                    self.assertEqual(len(requests), 6)
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
                        self.assertEqual(run["trace"]["modelAttempts"], 2)
                        self.assertEqual(run["trace"]["diagnosticRecordingStatus"], "recording")
                        diagnostic = trace["diagnostics"]
                        self.assertEqual(len(diagnostic["events"]), 6)
                        self.assertEqual(len(diagnostic["payloads"]), 6)
                        for observation in diagnostic["events"]:
                            event = observation["event"]
                            for field in ["requestPayload", "responsePayload"]:
                                if field in event:
                                    self.assertIn(event[field]["payloadId"], diagnostic["payloads"])
                        self.assertTrue(any(edge["kind"] == "requestsTool" for edge in trace["graph"]["edges"]))
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
                            failed = json.loads(
                                (failed_output / "report.json").read_text()
                            )["runs"][0]
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
                            captured = json.loads((failed_output / failed["artifactDirectory"] / "trace.json").read_text())
                            observations = captured["diagnostics"]["events"]
                            kinds = [record["event"]["type"] for record in observations]
                            self.assertIn("modelAttemptStarted", kinds)
                            if mode in ["reject", "retry"]:
                                self.assertIn("modelAttemptFailed", kinds)
                            if mode == "retry":
                                self.assertEqual(failed["trace"]["modelAttempts"], 3)
                                self.assertEqual(failed["trace"]["failedAttempts"], 1)
                            if mode == "hang":
                                self.assertIn("modelAttemptCancelled", kinds)
                                ended = next(record["event"] for record in observations if record["event"]["type"] == "modelAttemptCancelled")
                                partial = captured["diagnostics"]["payloads"][ended["partialOutput"]["payloadId"]]
                                self.assertEqual(partial["text"], "fixture partial output")
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
