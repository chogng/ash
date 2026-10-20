"""Build the unmodified rust-analyzer library bridge and query one Rust function."""

import argparse
from contextlib import nullcontext
import json
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from build.lib.cargo import cargo_artifact_executable, parse_cargo_message
from build.lib.cargo_cache import leased_cache

ROOT = Path(__file__).resolve().parents[2]
PROFILE = "ci-test"
MAX_RESPONSE_BYTES = 8 * 1024 * 1024


def build_bridge(root: Path = ROOT) -> str:
    result = subprocess.run(
        [
            sys.executable,
            "-B",
            "scripts/cargo.py",
            "build",
            "--locked",
            "-p",
            "ash-rust-analysis",
            "--bin",
            "ash-rust-analysis",
            "--profile",
            PROFILE,
            "--message-format=json-render-diagnostics",
        ],
        cwd=root,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        text=True,
        check=False,
    )
    executable = None
    for line in result.stdout.splitlines():
        message = parse_cargo_message(line)
        if message and message.get("reason") == "compiler-message":
            sys.stderr.write(message.get("message", {}).get("rendered", ""))
        executable = (
            cargo_artifact_executable(message, "ash-rust-analysis") or executable
        )
    if result.returncode:
        raise subprocess.CalledProcessError(result.returncode, result.args)
    if executable is None:
        raise RuntimeError("Cargo reported no ash-rust-analysis executable")
    return executable


def read_response(stream) -> dict:
    line = stream.readline(MAX_RESPONSE_BYTES + 1)
    if not line or len(line) > MAX_RESPONSE_BYTES:
        raise RuntimeError("Missing or oversized analysis bridge response")
    response = json.loads(line)
    if not isinstance(response, dict) or response.get("protocol_version") != 1:
        raise RuntimeError("Unsupported analysis bridge response")
    if "error" in response:
        raise RuntimeError(f"Analysis bridge rejected query: {response['error']}")
    if not isinstance(response.get("result"), dict):
        raise RuntimeError("Analysis bridge returned no result object")
    return response


def analyze(
    workspace: Path, path: str, byte_offset: int, *, build_scripts: bool = False
) -> dict:
    if not 0 <= byte_offset <= 2**32 - 1:
        raise ValueError("byte offset must fit an unsigned 32-bit integer")
    executable = build_bridge()
    with (
        leased_cache(ROOT, profile=PROFILE),
        leased_cache(workspace.resolve(), profile="dev-small")
        if build_scripts
        else nullcontext(),
    ):
        child = subprocess.Popen(
            [executable, str(workspace.resolve())]
            + (["--build-scripts"] if build_scripts else []),
            cwd=ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
        )
        try:
            ready = read_response(child.stdout)
            if (
                ready.get("id") is not None
                or ready.get("revision") != 0
                or ready["result"].get("event") != "ready"
            ):
                raise RuntimeError("Analysis bridge did not announce readiness")
            request = {
                "protocol_version": 1,
                "id": 1,
                "revision": 0,
                "query": {
                    "method": "function",
                    "path": path,
                    "byte_offset": byte_offset,
                },
            }
            child.stdin.write(json.dumps(request).encode("utf-8") + b"\n")
            child.stdin.flush()
            response = read_response(child.stdout)
            if response.get("id") != 1 or response.get("revision") != 0:
                raise RuntimeError("Analysis bridge returned a mismatched response")
            return {"workspace": ready["result"], "analysis": response["result"]}
        finally:
            child.stdin.close()
            child.stdout.close()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
            if child.returncode and sys.exc_info()[0] is None:
                raise RuntimeError(
                    f"Analysis bridge exited with status {child.returncode}"
                )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", help="Rust source path relative to the workspace")
    parser.add_argument(
        "byte_offset", type=int, help="UTF-8 byte offset inside a function"
    )
    parser.add_argument("--workspace", type=Path, default=ROOT)
    parser.add_argument("--build-scripts", action="store_true")
    arguments = parser.parse_args()
    try:
        result = analyze(
            arguments.workspace,
            arguments.path,
            arguments.byte_offset,
            build_scripts=arguments.build_scripts,
        )
        print(json.dumps(result, ensure_ascii=True, indent=2))
    except subprocess.CalledProcessError as error:
        raise SystemExit(error.returncode) from None
    except (OSError, RuntimeError, ValueError) as error:
        print(f"[rust-analysis] {error}", file=sys.stderr)
        raise SystemExit(1) from None
