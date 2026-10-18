"""Compare the pinned no-emit checkers on prepared CI inputs."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import statistics
import subprocess
import sys
import time
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
RENDERER = "tsconfig.renderer.json"


def save(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def windows_memory_reader():
    import ctypes
    from ctypes import wintypes

    class Counters(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
            (name, ctypes.c_size_t)
            for name in (
                "PeakWorkingSetSize",
                "WorkingSetSize",
                "QuotaPeakPagedPoolUsage",
                "QuotaPagedPoolUsage",
                "QuotaPeakNonPagedPoolUsage",
                "QuotaNonPagedPoolUsage",
                "PagefileUsage",
                "PeakPagefileUsage",
            )
        ]

    read = ctypes.windll.psapi.GetProcessMemoryInfo
    read.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
    read.restype = wintypes.BOOL

    def peak(process: subprocess.Popen) -> int:
        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        if not read(int(process._handle), ctypes.byref(counters), counters.cb):
            raise OSError("Cannot read checker peak working set")
        return counters.PeakWorkingSetSize

    return peak


def run(
    command: list[str],
    directory: Path,
    label: str,
    measure=False,
    *,
    cwd: Path | None = None,
    environment: dict[str, str] | None = None,
    timeout: int = 1200,
) -> dict:
    log = directory / f"{label}.log"
    memory = directory / f"{label}.memory"
    measured = command
    if measure and sys.platform == "linux":
        measured = ["/usr/bin/time", "-f", "%M", "-o", str(memory), *command]
    elif measure and sys.platform != "win32":
        raise ValueError("Peak memory measurement supports Linux and Windows")
    read_memory = (
        windows_memory_reader() if measure and sys.platform == "win32" else None
    )
    started = time.perf_counter()
    peak = 0
    print(f"{label}: starting", flush=True)
    with log.open("wb") as output:
        process = subprocess.Popen(
            measured,
            cwd=cwd or ROOT,
            env={**os.environ, **(environment or {})},
            stdin=subprocess.DEVNULL,
            stdout=output,
            stderr=subprocess.STDOUT,
            start_new_session=sys.platform != "win32",
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
        try:
            while True:
                if read_memory:
                    peak = max(peak, read_memory(process))
                try:
                    code = process.wait(timeout=0.01)
                    break
                except subprocess.TimeoutExpired:
                    if time.perf_counter() - started > (180 if measure else timeout):
                        raise TimeoutError(f"{label} timed out")
            if read_memory:
                peak = max(peak, read_memory(process))
        except BaseException:
            if sys.platform == "win32":
                subprocess.run(
                    ["taskkill", "/T", "/F", "/PID", str(process.pid)],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )
            else:
                os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            raise
    elapsed = (time.perf_counter() - started) * 1000
    if measure and sys.platform == "linux":
        # GNU time prefixes nonzero exits with a status line before the RSS.
        peak = int(memory.read_text().splitlines()[-1]) * 1024
    if measure and peak <= 0:
        raise RuntimeError(f"Missing peak memory measurement for {label}")
    result = {
        "command": command,
        "exitCode": code,
        "elapsedMs": elapsed,
        "log": log.name,
        "cwd": str(cwd or ROOT),
    }
    if measure:
        result["peakMemoryBytes"] = peak
    print(f"{label}: exit={code}, {elapsed:.1f} ms", flush=True)
    return result


def checkers(directory: Path) -> dict[str, str]:
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node is required to resolve the pinned TS7 executable")
    resolver = run(
        [
            node,
            "--input-type=module",
            "-e",
            "import get from './node_modules/@ash/typescript-compiler/lib/getExePath.js'; console.log(get());",
        ],
        directory,
        "resolve-ts7",
    )
    if resolver["exitCode"]:
        raise RuntimeError("Cannot resolve TS7")
    return {
        "bun": str(ROOT / "node_modules/bun/bin/bun.exe"),
        "ts7": (directory / resolver["log"]).read_text(encoding="utf-8").strip(),
    }


def command(executable: str, checker: str, config: str) -> list[str]:
    if checker == "bun":
        return [executable, "check", "-p", config, "--all", "--no-pretty"]
    return [
        executable,
        "-p",
        config,
        "--noEmit",
        "--incremental",
        "false",
        "--pretty",
        "false",
    ]


def diagnostics(text: str) -> list[dict]:
    found = []
    for line in re.sub(r"\x1b\[[0-9;]*m", "", text).splitlines():
        match = re.match(r"^(.+)\((\d+),(\d+)\): error TS(\d+): (.+)$", line)
        if match:
            file, row, column, code, message = match.groups()
            found.append(
                {
                    "file": str((ROOT / file).resolve()),
                    "line": int(row),
                    "column": int(column),
                    "code": int(code),
                    "message": message,
                }
            )
    return sorted(
        found,
        key=lambda item: (item["file"], item["line"], item["column"], item["code"]),
    )


def manifest(executables: dict[str, str], directory: Path, label: str) -> dict:
    listing = run(
        [
            executables["ts7"],
            "-p",
            "tsconfig.renderer.json",
            "--listFilesOnly",
            "--incremental",
            "false",
            "--pretty",
            "false",
        ],
        directory,
        f"files-{label}",
    )
    if listing["exitCode"]:
        raise RuntimeError("Cannot enumerate Renderer inputs")
    files = [
        Path(line)
        for line in (directory / listing["log"])
        .read_text(encoding="utf-8")
        .splitlines()
    ]
    files += [
        ROOT / name
        for name in (RENDERER, "tsconfig.base.json", "package.json", "pnpm-lock.yaml")
    ]
    files += [Path(path) for path in executables.values()]
    hashes = {
        str(path.resolve()): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in files
    }
    return {
        "digest": hashlib.sha256(
            json.dumps(hashes, sort_keys=True).encode()
        ).hexdigest(),
        "files": hashes,
    }


def benchmark(directory: Path) -> None:
    executables = checkers(directory)
    versions = {}
    for checker, executable in executables.items():
        result = run([executable, "--version"], directory, f"version-{checker}")
        if result["exitCode"]:
            raise RuntimeError(f"Cannot read {checker} version")
        versions[checker] = (
            (directory / result["log"]).read_text(encoding="utf-8").strip()
        )
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    expected = {
        "bun": package["devDependencies"]["bun"],
        "ts7": package["devDependencies"]["@ash/typescript-compiler"].rsplit("@", 1)[1],
    }
    if any(
        not re.search(rf"\b{re.escape(version)}\b", versions[checker])
        for checker, version in expected.items()
    ):
        raise RuntimeError(f"Unexpected checker versions: {versions}")
    report = {
        "environment": {
            "platform": sys.platform,
            "architecture": platform.machine(),
            "cpus": os.cpu_count(),
            "runner": os.environ.get("RUNNER_NAME"),
            "versions": versions,
        },
        "memoryMetric": "peak working set"
        if sys.platform == "win32"
        else "GNU time maximum RSS",
        "scope": "warm filesystem cache; full checks with incremental disabled; direct compiler processes",
    }
    report_path = directory / "results.json"
    before = manifest(executables, directory, "before")
    save(directory / "inputs-before.json", before)
    warmup = {
        checker: run(
            command(executable, checker, RENDERER), directory, f"warmup-{checker}", True
        )
        for checker, executable in executables.items()
    }
    report["warmup"] = warmup
    save(report_path, report)
    if any(result["exitCode"] for result in warmup.values()):
        raise RuntimeError("Renderer baseline failed; inspect warmup logs")
    rounds = []
    for index in range(5):
        order = ("bun", "ts7") if index % 2 == 0 else ("ts7", "bun")
        pair = {
            checker: run(
                command(executables[checker], checker, "tsconfig.renderer.json"),
                directory,
                f"renderer-{index}-{checker}",
                True,
            )
            for checker in order
        }
        rounds.append(pair)
        if any(result["exitCode"] for result in pair.values()):
            raise RuntimeError("Renderer measurement failed")
    after = manifest(executables, directory, "after")
    save(directory / "inputs-after.json", after)
    report["renderer"] = {
        "rounds": rounds,
        "inputsStable": before == after,
        "inputDigest": before["digest"],
        "medians": {
            checker: {
                key: statistics.median(pair[checker][key] for pair in rounds)
                for key in ("elapsedMs", "peakMemoryBytes")
            }
            for checker in executables
        },
    }
    save(report_path, report)
    if before != after:
        raise RuntimeError("Input hashes changed; discard these measurements")
    probe = directory / "probe"
    probe.mkdir()
    save(
        probe / "tsconfig.json",
        {
            "extends": str(ROOT / "tsconfig.renderer.json"),
            "files": [
                str(ROOT / "src/typings/thenable.d.ts"),
                str(probe / "errors.ts"),
            ],
            "compilerOptions": {"noEmit": True, "incremental": False},
        },
    )
    (probe / "errors.ts").write_text(
        "export const wrong: number = 'invalid';\nfunction accept(value: number): number { return value; }\naccept('invalid');\n",
        encoding="utf-8",
    )
    probe_files = sorted(path.name for path in probe.iterdir())
    pair = {
        checker: run(
            command(executables[checker], checker, str(probe / "tsconfig.json")),
            directory,
            f"probe-{checker}",
            True,
        )
        for checker in executables
    }
    normalized = {
        checker: diagnostics((directory / result["log"]).read_text(encoding="utf-8"))
        for checker, result in pair.items()
    }
    report["diagnostics"] = {
        "runs": pair,
        "normalized": normalized,
        "match": normalized["bun"] == normalized["ts7"],
        "noEmittedProbeFiles": probe_files
        == sorted(path.name for path in probe.iterdir()),
    }
    save(report_path, report)
    if (
        any(result["exitCode"] == 0 for result in pair.values())
        or not report["diagnostics"]["match"]
        or sorted(item["code"] for item in normalized["bun"]) != [2322, 2345]
        or not report["diagnostics"]["noEmittedProbeFiles"]
    ):
        raise RuntimeError("Injected-error acceptance failed; inspect probe logs")


def install(directory: Path, phase: str) -> None:
    store = Path(os.environ["BUN_CI_STORE"])
    if phase == "cold" and store.exists() and any(store.iterdir()):
        raise RuntimeError("Cold installation requires an empty pnpm store")
    pnpm = shutil.which("pnpm")
    if not pnpm:
        raise RuntimeError("pnpm is unavailable")
    result = run(
        [
            pnpm,
            "install",
            "--frozen-lockfile",
            *(["--offline"] if phase == "warm" else []),
        ],
        directory,
        "install",
    )
    save(directory / "install.json", {"phase": phase, **result})
    if result["exitCode"]:
        raise RuntimeError("Dependency installation failed; inspect install.log")


def summarize(directory: Path) -> None:
    from datetime import datetime

    request = Request(
        f"https://api.github.com/repos/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}/jobs?per_page=100",
        headers={
            "Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "Ash-Bun-Acceptance",
        },
    )
    with urlopen(request, timeout=30) as response:
        jobs = json.load(response)["jobs"]
    rows = []
    for runner in ("ubuntu-24.04", "windows-latest"):
        for phase in ("cold", "warm"):
            job = next(
                job for job in jobs if job["name"] == f"{phase} ({runner}) / benchmark"
            )
            if job["conclusion"] != "success":
                raise RuntimeError(
                    f"Incomplete acceptance: {job['name']} = {job['conclusion']}"
                )
            path = directory / runner / phase
            report = json.loads((path / "results.json").read_text())
            install_result = json.loads((path / "install.json").read_text())
            duration = (
                datetime.fromisoformat(job["completed_at"])
                - datetime.fromisoformat(job["started_at"])
            ).total_seconds()
            row = {
                "runner": runner,
                "phase": phase,
                "jobSeconds": duration,
                "installMs": install_result["elapsedMs"],
                "renderer": report["renderer"]["medians"],
                "job": job,
            }
            rows.append(row)
    save(directory / "summary.json", {"run": os.environ["GITHUB_RUN_ID"], "jobs": rows})
    lines = [
        "| Runner | Install | Job (s) | Install (s) | Bun (ms / MiB) | TS7 (ms / MiB) |",
        "| --- | --- | ---: | ---: | ---: | ---: |",
    ]
    for row in rows:
        values = [
            f"{row['renderer'][checker]['elapsedMs']:.1f} / {row['renderer'][checker]['peakMemoryBytes'] / 1048576:.1f}"
            for checker in ("bun", "ts7")
        ]
        lines.append(
            f"| {row['runner']} | {row['phase']} | {row['jobSeconds']:.0f} | {row['installMs'] / 1000:.1f} | {values[0]} | {values[1]} |"
        )
    lines.append(
        "\nFull job time includes setup, installation, input preparation, both checkers and artifact upload. It is not a comparison of two product CI jobs. Checks use a warm filesystem cache; cold refers to dependency installation. Windows records peak working set; Linux records maximum RSS. Raw job steps include cache restoration time."
    )
    markdown = "\n".join(lines) + "\n"
    (directory / "summary.md").write_text(markdown, encoding="utf-8")
    with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a", encoding="utf-8") as output:
        output.write(markdown)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("install", "benchmark", "summarize"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--phase", choices=("cold", "warm"))
    args = parser.parse_args()
    if args.operation == "install" and args.phase is None:
        parser.error("install requires --phase")
    directory = args.output.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    if args.operation == "install":
        install(directory, args.phase)
    elif args.operation == "benchmark":
        benchmark(directory)
    else:
        summarize(directory)


if __name__ == "__main__":
    main()
