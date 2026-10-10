"""Bounded, offline tool execution shared by release and crash analysis."""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import tempfile
import time
from pathlib import Path

MAX_OUTPUT = 8 * 1024 * 1024


def tool(name: str) -> str:
    directory = os.environ.get("ASH_LLVM_BIN")
    candidates = [Path(directory) / name] if directory else []
    candidates += [Path("/opt/homebrew/opt/llvm/bin") / name]
    for candidate in candidates:
        for path in (candidate, candidate.with_suffix(".exe")):
            if path.is_file():
                return str(path)
    if found := shutil.which(name):
        return found
    if name == "llvm-dwarfdump" and shutil.which("dwarfdump"):
        return shutil.which("dwarfdump")
    raise RuntimeError(
        f"Required tool {name} missing; install LLVM or set ASH_LLVM_BIN"
    )


def run(command: list[str], *, timeout: float = 120) -> str:
    # Temporary files bound memory; polling bounds disk growth and cancellation
    # reaps the whole process group, including debugger helpers on POSIX.
    with tempfile.TemporaryFile() as output:
        environment = os.environ.copy()
        environment.pop("LLVM_SYMBOLIZER_OPTS", None)
        environment["DEBUGINFOD_URLS"] = ""
        environment["LC_ALL"] = "C"
        process = subprocess.Popen(
            command,
            stdout=output,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            env=environment,
            start_new_session=os.name != "nt",
        )
        deadline = time.monotonic() + timeout
        try:
            while process.poll() is None:
                if (
                    time.monotonic() > deadline
                    or os.fstat(output.fileno()).st_size > MAX_OUTPUT
                ):
                    raise RuntimeError(f"Tool exceeded time/output limit: {command[0]}")
                time.sleep(0.02)
            if os.fstat(output.fileno()).st_size > MAX_OUTPUT:
                raise RuntimeError(f"Tool exceeded output limit: {command[0]}")
            output.seek(0)
            result = output.read().decode("utf-8", errors="replace")
            if process.returncode:
                raise RuntimeError(
                    f"{command[0]} exited {process.returncode}: {result[-4000:]}"
                )
            return result
        finally:
            if process.poll() is None:
                if os.name == "nt":
                    subprocess.run(
                        ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        check=False,
                    )
                else:
                    os.killpg(process.pid, signal.SIGKILL)
                process.kill()
            process.wait()
