#!/usr/bin/env python3
"""Exercise packaged Remote connections, editing, terminals and a deterministic Agent turn."""

from pathlib import Path
import argparse
import http.server
import json
import os
import queue
import shlex
import subprocess
import tempfile
import threading
import time


class Model(http.server.BaseHTTPRequestHandler):
    calls = []

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        Model.calls.append({"path": self.path, "body": body})
        response = {
            "type": "response.completed",
            "response": {
                "id": "release-fixture",
                "status": "completed",
                "output": [
                    {
                        "type": "message",
                        "id": "fixture-message",
                        "role": "assistant",
                        "content": [
                            {"type": "output_text", "text": "release-agent-ok"}
                        ],
                    }
                ],
                "usage": {"input_tokens": 1, "output_tokens": 1},
            },
        }
        data = (
            "event: response.completed\ndata: " + json.dumps(response) + "\n\n"
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


def verify(
    package: Path, report_path: Path, ssh: Path | None = None, host: str | None = None
) -> None:
    package = package.resolve()
    base = report_path.parent
    base.mkdir(parents=True, exist_ok=True)
    Model.calls = []
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Model)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    reports = []
    try:
        for managed in [False, True]:
            mode = "managed" if managed else "stdio"
            start_calls = len(Model.calls)
            with (
                tempfile.TemporaryDirectory(prefix="ash-release-remote-") as temp,
                (base / f"{mode}.stderr.log").open("w") as errors,
            ):
                home = Path(temp) / "profile"
                workspace = Path(temp) / "workspace"
                workspace.mkdir()
                env = {k: v for k, v in os.environ.items() if not k.startswith("ASH_")}
                env.update(ASH_HOME=str(home), ASH_WORKSPACE_ROOT=str(workspace))
                args = [str(package / "bin/ash-remote-server")] + (
                    ["connect"] if managed else ["app-server", "--listen", "stdio://"]
                )

                def command(arguments):
                    if ssh is None:
                        return arguments
                    remote = [
                        "env",
                        f"ASH_HOME={home}",
                        f"ASH_WORKSPACE_ROOT={workspace}",
                        *arguments,
                    ]
                    return [str(ssh), "-T", host, shlex.join(remote)]

                def start_connection():
                    return subprocess.Popen(
                        command(args),
                        env=env,
                        stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE,
                        stderr=errors,
                        text=True,
                    )

                process = start_connection()
                replies = queue.Queue()
                wire = []
                counter = 0

                def read():
                    for line in process.stdout:
                        try:
                            replies.put(json.loads(line))
                        except Exception:
                            replies.put({"parseError": line})

                reader = threading.Thread(target=read, daemon=True)
                reader.start()

                def rpc(method, params, error=None):
                    nonlocal counter
                    counter += 1
                    identifier = counter
                    request = {
                        "jsonrpc": "2.0",
                        "id": identifier,
                        "method": method,
                        "params": params,
                    }
                    wire.append({"request": request})
                    process.stdin.write(json.dumps(request) + "\n")
                    process.stdin.flush()
                    deadline = time.monotonic() + 40
                    while True:
                        value = replies.get(
                            timeout=max(0.01, deadline - time.monotonic())
                        )
                        wire.append({"received": value})
                        if value.get("id") == identifier:
                            if error is not None:
                                assert value.get("error", {}).get("code") == error, (
                                    value
                                )
                                return value["error"]
                            assert "error" not in value, value
                            return value["result"]

                try:
                    rpc(
                        "initialize",
                        {
                            "clientInfo": {
                                "name": "release-remote-check",
                                "version": "1",
                            },
                            "capabilities": {},
                        },
                    )
                    rpc(
                        "fs/writeFile",
                        {"path": "probe.txt", "content": "release-remote-edit-ok"},
                    )
                    assert (
                        rpc("fs/readFile", {"path": "probe.txt"})["content"]
                        == "release-remote-edit-ok"
                    )
                    rpc(
                        "terminal/create",
                        {
                            "rows": 24,
                            "cols": 80,
                            "profile": {"type": "default"},
                            "lifecycle": {"type": "connectionOwned"},
                            "execution": {
                                "type": "process",
                                "program": "/bin/sh",
                                "args": [
                                    "-c",
                                    "printf release-terminal-ok > terminal-marker.txt",
                                ],
                            },
                        },
                    )
                    deadline = time.monotonic() + 10
                    while (
                        not (workspace / "terminal-marker.txt").exists()
                        and time.monotonic() < deadline
                    ):
                        time.sleep(0.05)
                    assert (
                        rpc("fs/readFile", {"path": "terminal-marker.txt"})["content"]
                        == "release-terminal-ok"
                    )
                    rpc("session/list", {})
                    if managed:
                        rpc(
                            "provider/configure",
                            {
                                "commandId": "release-model-config",
                                "expectedRevision": 0,
                                "config": {
                                    "connection": "custom-release",
                                    "provider": "custom-release",
                                    "baseUrl": f"http://127.0.0.1:{server.server_port}/v1",
                                    "custom": {
                                        "name": "Release fixture",
                                        "protocol": "responses",
                                        "model": "fixture-model",
                                        "contextWindow": 272000,
                                    },
                                },
                            },
                        )
                        created = rpc(
                            "session/create",
                            {
                                "commandId": "release-create",
                                "title": "Release validation",
                                "executionTarget": None,
                            },
                        )
                        session = created["session"]["sessionId"]
                        thread = created["session"]["threads"][0]["threadId"]
                        initial = rpc(
                            "session/thread/read",
                            {"sessionId": session, "threadId": thread},
                        )
                        sequence = initial["thread"]["sequence"]
                        rpc(
                            "session/thread/subscribe",
                            {
                                "sessionId": session,
                                "threadId": thread,
                                "afterSequence": sequence,
                            },
                        )
                        rpc(
                            "session/request",
                            {
                                "commandId": "release-turn",
                                "sessionId": session,
                                "request": {
                                    "type": "startTurn",
                                    "threadId": thread,
                                    "expectedSequence": sequence,
                                    "model": {
                                        "provider": "custom-release",
                                        "model": "fixture-model",
                                    },
                                    "input": [
                                        {
                                            "type": "text",
                                            "text": "Reply release-agent-ok",
                                        }
                                    ],
                                },
                            },
                        )
                        deadline = time.monotonic() + 30
                        while True:
                            snapshot = rpc(
                                "session/thread/read",
                                {"sessionId": session, "threadId": thread},
                            )
                            turn = snapshot["thread"]["turns"][-1]
                            if turn["status"] not in [
                                "running",
                                "pending",
                                "queued",
                                "inProgress",
                            ]:
                                break
                            assert time.monotonic() < deadline, snapshot
                            time.sleep(0.1)
                        assert turn["status"] == "completed", snapshot
                        assert "release-agent-ok" in json.dumps(snapshot), snapshot
                        assert len(Model.calls) > start_calls, (
                            "Agent never called model"
                        )
                    for method, params in [
                        (
                            "call/start",
                            {
                                "resourceId": "release-call",
                                "operationId": "release-call-op",
                                "deviceId": "release-device",
                                "deployment": {"type": "local"},
                            },
                        ),
                        (
                            "dictation/options",
                            {"backend": {"type": "local", "modelId": "release-model"}},
                        ),
                        ("voice/stop", {"resourceId": "release-voice"}),
                    ]:
                        rpc(method, params, -32073)
                    assert not (home / "capabilities").exists(), (
                        "Remote installed optional capabilities"
                    )
                    if managed:
                        process.stdin.close()
                        try:
                            process.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait()
                        reader.join(timeout=2)
                        process = start_connection()
                        reader = threading.Thread(target=read, daemon=True)
                        reader.start()
                        rpc(
                            "initialize",
                            {
                                "clientInfo": {
                                    "name": "release-reconnect",
                                    "version": "1",
                                },
                                "capabilities": {},
                            },
                        )
                        assert (
                            rpc("fs/readFile", {"path": "probe.txt"})["content"]
                            == "release-remote-edit-ok"
                        )
                        restored = rpc(
                            "session/thread/read",
                            {"sessionId": session, "threadId": thread},
                        )
                        assert (
                            restored["thread"]["turns"][-1]["status"] == "completed"
                        ), restored
                        assert "release-agent-ok" in json.dumps(restored), restored
                        assert not (home / "capabilities").exists()
                    report = {
                        "mode": mode,
                        "package": str(package),
                        "files": True,
                        "terminal": True,
                        "agentTurn": "completed"
                        if managed
                        else "diagnostic session/list only",
                        "modelRequests": len(Model.calls) - start_calls,
                        "mediaRejected": 3,
                        "installedCapabilities": 0,
                        "transport": "OpenSSH" if ssh is not None else "local stdio",
                        "reconnected": managed,
                    }
                    reports.append(report)
                    print(json.dumps(report), flush=True)
                finally:
                    (base / f"{mode}-wire.json").write_text(
                        json.dumps(wire, indent=2) + "\n"
                    )
                    process.stdin.close()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
                    if managed:
                        stopped = subprocess.run(
                            command(
                                [str(package / "bin/ash-app-server-daemon"), "stop"]
                            ),
                            env=env,
                            stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE,
                            timeout=30,
                        )
                        assert stopped.returncode == 0, stopped.stderr
    finally:
        server.shutdown()
        server.server_close()
    report_path.write_text(
        json.dumps(
            {
                "status": "passed",
                "runs": reports,
                "model": "local deterministic HTTP SSE fixture; real packaged Agent runtime",
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-dir", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument(
        "--ssh", type=Path, help="OpenSSH executable for an isolated loopback host"
    )
    parser.add_argument(
        "--host", help="Loopback OpenSSH host alias; test paths share this filesystem"
    )
    args = parser.parse_args()
    if (args.ssh is None) != (args.host is None):
        parser.error("--ssh and --host must be supplied together")
    verify(args.package_dir, args.report, args.ssh, args.host)
