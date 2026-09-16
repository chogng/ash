"""Verify bundled search engines through a real packaged App Server's stdio RPC."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import queue
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time


def process_alive(pid):
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
        if not handle:
            error = ctypes.get_last_error()
            if error == 87:  # ERROR_INVALID_PARAMETER: PID no longer exists.
                return False
            raise ctypes.WinError(error)
        try:
            result = kernel.WaitForSingleObject(handle, 0)
            if result not in (0, 258):  # WAIT_OBJECT_0 / WAIT_TIMEOUT
                raise ctypes.WinError(ctypes.get_last_error())
            return result == 258
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


class RpcProcess:
    """Own the subprocess, pipe reader and discovered tgrep servers for one smoke run."""

    def __init__(self, command, *, cwd, env, stderr, timeout=30):
        self.timeout = timeout
        self.stderr = stderr
        self.process = subprocess.Popen(
            command,
            cwd=cwd,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=stderr,
        )
        self.messages = queue.Queue()
        self.next_id = 1
        self.servers = []
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        try:
            for line in self.process.stdout:
                self.messages.put(json.loads(line))
        except (ValueError, OSError) as error:
            self.messages.put(error)
        finally:
            self.messages.put(None)

    def call(self, method, params):
        request_id = self.next_id
        self.next_id += 1
        self.process.stdin.write(
            (
                json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "method": method,
                        "params": params,
                    }
                )
                + "\n"
            ).encode()
        )
        self.process.stdin.flush()
        deadline = time.monotonic() + self.timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"RPC timed out: {method}")
            try:
                message = self.messages.get(timeout=remaining)
            except queue.Empty as error:
                raise TimeoutError(f"RPC timed out: {method}") from error
            if isinstance(message, Exception):
                raise RuntimeError("invalid stdio response") from message
            if message is None:
                raise RuntimeError(f"App Server exited before replying to {method}")
            if message.get("id") == request_id:
                if "error" in message:
                    raise RuntimeError(f"{method}: {message['error']}")
                return message["result"]

    def __enter__(self):
        return self

    def __exit__(self, _kind, primary, _traceback):
        failures = []
        try:
            self.process.stdin.close()
        except BrokenPipeError:
            pass
        try:
            code = self.process.wait(timeout=self.timeout)
            if code != 0:
                failures.append(f"App Server exited with {code}")
        except subprocess.TimeoutExpired:
            failures.append("App Server did not exit after stdin closed")
            self.process.kill()
            self.process.wait(timeout=5)
        self.reader.join(timeout=5)
        self.process.stdout.close()
        for server in self.servers:
            deadline = time.monotonic() + min(self.timeout, 5)
            while process_alive(server["pid"]) and time.monotonic() < deadline:
                time.sleep(0.01)
            if not process_alive(server["pid"]):
                continue
            failures.append(f"tgrep process {server['pid']} survived host exit")
            try:
                os.kill(server["pid"], signal.SIGTERM)
            except ProcessLookupError:
                pass
        if primary is not None or failures:
            self.stderr.flush()
            self.stderr.seek(0)
            diagnostic = self.stderr.read().decode(errors="replace")[-8000:]
            detail = "\n".join([*failures, diagnostic]).strip()
            if primary is not None:
                if detail:
                    primary.add_note(detail)
            else:
                raise RuntimeError(detail)


def search(client, pattern, freshness):
    started = client.call(
        "grep/search/start",
        {
            "query": pattern,
            "patternKind": "literal",
            "caseSensitivity": "sensitive",
            "includePatterns": [],
            "excludePatterns": [],
            "maxResults": 200,
            "freshness": freshness,
        },
    )
    rows, sizes = [], []
    deadline = time.monotonic() + client.timeout
    try:
        while time.monotonic() < deadline:
            page = client.call(
                "grep/search/read",
                {
                    "searchId": started["searchId"],
                    "afterMatch": len(rows),
                    "maxMatches": 100,
                },
            )
            assert page["error"] is None, page
            assert page["nextMatch"] == len(rows) + len(page["matches"]), page
            if page["matches"]:
                assert page["freshness"] == freshness, page
                sizes.append(len(page["matches"]))
                rows.extend(page["matches"])
            if page["completed"]:
                return rows, sizes
            time.sleep(0.01)
        raise TimeoutError("search did not finish")
    finally:
        # The subprocess owner handles cleanup if transport failure prevents this RPC.
        primary = sys.exception()
        try:
            client.call("grep/search/cancel", {"searchId": started["searchId"]})
        except Exception as cleanup:
            if primary is None:
                raise
            primary.add_note(f"search cleanup also failed: {cleanup}")


def verify(package, node=None):
    package = package.resolve(strict=True)
    metadata = json.loads((package / "ash-package.json").read_text())
    suffix = ".exe" if os.name == "nt" else ""
    executable = package / "bin" / f"ash-app-server{suffix}"
    tgrep = package / "ash-resources" / "tgrep" / f"tgrep{suffix}"
    component = metadata["components"]["tgrep"]
    assert hashlib.sha256(tgrep.read_bytes()).hexdigest() == component["binarySha256"]
    with tempfile.TemporaryDirectory(prefix="ash-search-package-") as temporary:
        root = Path(temporary).resolve()
        workspace, profile, empty_path = (
            root / "workspace",
            root / "profile",
            root / "empty-path",
        )
        for directory in (workspace, profile, empty_path):
            directory.mkdir()
        source = workspace / "marker.rs"
        source.write_text("packaged_tgrep_marker\n" * 150, encoding="utf-8")
        environment = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith("ASH_")
        }
        environment.update(
            ASH_HOME=str(profile),
            ASH_WORKSPACE_ROOT=str(workspace),
            PATH=str(empty_path),
        )
        if metadata["javascriptRuntime"]["kind"] == "hostProvidedNode":
            node = node or shutil.which("node")
            if not node:
                raise ValueError(
                    "host-provided package requires --node-bin or Node on the caller's PATH"
                )
            environment["ASH_ELECTRON_RUN_AS_NODE_PATH"] = str(
                Path(node).resolve(strict=True)
            )
        assert shutil.which("rg", path=environment["PATH"]) is None
        assert shutil.which("tgrep", path=environment["PATH"]) is None
        with tempfile.TemporaryFile() as errors:
            with RpcProcess(
                [str(executable), "--listen", "stdio://"],
                cwd=workspace,
                env=environment,
                stderr=errors,
            ) as client:
                initialized = client.call(
                    "initialize",
                    {
                        "clientInfo": {"name": "search-package-smoke", "version": "1"},
                        "capabilities": {},
                    },
                )
                assert initialized["protocolVersion"] == {
                    key: metadata["protocol"][key] for key in ("major", "revision")
                }
                status = client.call("grep/index/status", {})
                assert status["enabled"] and not status["active"], status
                status = client.call("grep/index/rebuild", {})
                discovery = list(profile.rglob("serve.json"))
                client.servers.extend(
                    json.loads(path.read_text()) for path in discovery
                )
                assert len(discovery) == 1, discovery
                assert status["ready"] and status["indexedFileCount"] == 1, status
                rows, pages = search(client, "packaged_tgrep_marker", "indexed")
                assert pages == [100, 50], pages
                assert [row["lineNumber"] for row in rows] == list(range(1, 151)), rows
                assert all(row["path"] == "marker.rs" for row in rows)
                with source.open("a", encoding="utf-8") as output:
                    output.write("latest_disk_marker\n")
                current, _ = search(client, "latest_disk_marker", "current")
                assert len(current) == 1 and current[0]["lineNumber"] == 151, current
                client.call("codebase/rebuild", {})
                for method in ("codebase/search", "codebase/retrieve"):
                    result = client.call(
                        method, {"query": "ckaged_tgrep_mark", "maxResults": 10}
                    )
                    assert result["hits"], (method, result)
                    assert all(hit["path"] == "marker.rs" for hit in result["hits"]), (
                        result
                    )
            return {
                "package": str(package),
                "buildId": metadata["buildId"],
                "tgrepVersion": component["version"],
                "indexedPages": pages,
                "currentDiskLine": 151,
                "codebaseSearch": True,
                "codebaseRetrieval": True,
                "enginesAbsentFromPath": True,
                "normalHostExit": True,
                "tgrepReaped": True,
            }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-dir", type=Path, required=True)
    parser.add_argument("--node-bin", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    report = json.dumps(verify(args.package_dir, args.node_bin), indent=2)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(report + "\n", encoding="utf-8")
    print(report)


if __name__ == "__main__":
    main()
