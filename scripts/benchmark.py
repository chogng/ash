#!/usr/bin/env python3
"""Measure clean, unchanged, and touch rebuilds for one Cargo package."""

from __future__ import annotations

import argparse
import errno
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time


ROOT = Path(__file__).resolve().parents[1]
SCENARIOS = ("clean", "unchanged", "touch")
BUILD_ENV = (
    "ASH_BUILD_COMMIT",
    "RUSTC",
    "RUSTFLAGS",
    "CARGO_ENCODED_RUSTFLAGS",
    "CARGO_INCREMENTAL",
    "RUSTC_WRAPPER",
    "RUSTC_WORKSPACE_WRAPPER",
)


def output(command: list[str], root: Path = ROOT) -> str:
    return subprocess.check_output(command, cwd=root, text=True).strip()


def max_rss(log: str, system: str) -> int:
    if system == "Darwin":
        match = re.search(r"(\d+)\s+maximum resident set size", log)
        multiplier = 1
    else:
        match = re.search(r"Maximum resident set size \(kbytes\):\s*(\d+)", log)
        multiplier = 1024
    if match is None:
        raise ValueError("time did not report maximum RSS; see the build log")
    return int(match[1]) * multiplier


def measure(command: list[str], log: Path, system: str, root: Path = ROOT) -> dict:
    environment = os.environ.copy()
    environment["LC_ALL"] = "C"
    started = time.perf_counter()
    with log.open("w") as stream:
        result = subprocess.run(
            ["/usr/bin/time", "-l" if system == "Darwin" else "-v", *command],
            cwd=root,
            env=environment,
            stdout=stream,
            stderr=subprocess.STDOUT,
            check=False,
        )
    seconds = time.perf_counter() - started
    text = log.read_text()
    if result.returncode:
        raise RuntimeError(
            f"Build exited {result.returncode}; see {log}\n"
            + "\n".join(text.splitlines()[-20:])
        )
    return {"seconds": seconds, "max_rss_bytes": max_rss(text, system), "log": str(log)}


def touch_build(
    source: Path, command: list[str], log: Path, system: str, root: Path = ROOT
) -> dict:
    original = source.stat()
    os.utime(source, None)
    touched = source.stat().st_mtime_ns
    try:
        return measure(command, log, system, root)
    finally:
        # Do not overwrite a concurrent editor's newer timestamp.
        if source.stat().st_mtime_ns == touched:
            os.utime(source, ns=(original.st_atime_ns, original.st_mtime_ns))


def artifacts(log: Path, package_id: str, target: Path) -> dict[str, int]:
    sizes = {}
    for line in log.read_text().splitlines():
        if not line.startswith("{"):
            continue
        entry = json.loads(line)
        if (
            entry.get("reason") != "compiler-artifact"
            or entry.get("package_id") != package_id
        ):
            continue
        for filename in entry["filenames"]:
            path = Path(filename)
            if path.is_file():
                sizes[str(path.relative_to(target))] = path.stat().st_size
    return sizes


def remove_run_target(target: Path) -> None:
    # Finder can add .DS_Store while rmtree walks a macOS build output tree.
    for attempt in range(3):
        try:
            shutil.rmtree(target)
            return
        except OSError as error:
            if error.errno != errno.ENOTEMPTY or attempt == 2:
                raise


def tracked_build_timestamps(root: Path) -> dict[str, int]:
    names = output(["git", "ls-files", "-z", "--", "*.rs", "*.toml"], root)
    return {
        name: (root / name).stat().st_mtime_ns
        for name in names.split("\0")
        if name
    }


def compare(
    baseline: dict, current: dict, limit: float, absolute: float = 0
) -> list[str]:
    if baseline["environment"] != current["environment"]:
        raise ValueError(
            "benchmark environments differ; compare the same package, profile, machine, toolchain, jobs, source, and flags"
        )
    errors = []
    for scenario in SCENARIOS:
        previous = baseline["medians"][scenario]["seconds"]
        if previous <= 0:
            raise ValueError("baseline times must be positive")
        delta = current["medians"][scenario]["seconds"] - previous
        change = delta / previous * 100
        if change > limit and delta > absolute:
            errors.append(
                f"{scenario}: +{change:.1f}% / +{delta:.2f}s exceeds {limit:.1f}% / {absolute:.2f}s (repeat under matching load before accepting a regression)"
            )
    return errors


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", help="one Cargo package name")
    parser.add_argument(
        "--root",
        type=Path,
        default=ROOT,
        help="workspace to measure; CI uses sibling base/head checkouts",
    )
    parser.add_argument(
        "--absolute-regression",
        type=float,
        default=0,
        help="additional seconds of noise allowance when comparing",
    )
    parser.add_argument("--profile", default="dev")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--jobs", type=int, default=os.cpu_count() or 1)
    parser.add_argument("--target")
    parser.add_argument(
        "--source",
        type=Path,
        help="Rust source to touch; defaults to the package library or binary root",
    )
    parser.add_argument(
        "--compare", type=Path, help="existing report from the same environment"
    )
    parser.add_argument(
        "--max-regression",
        type=float,
        help="explicit wall-time percentage limit when comparing",
    )
    args = parser.parse_args(arguments)
    root = args.root.resolve()
    if args.absolute_regression < 0 or (args.absolute_regression and not args.compare):
        parser.error("a nonnegative --absolute-regression requires --compare")
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]*", args.profile):
        parser.error("profile must be a Cargo profile name")
    if args.runs < 3 or args.jobs < 1:
        parser.error("use at least three runs and a positive job count")
    if bool(args.compare) != (args.max_regression is not None) or (
        args.max_regression is not None and args.max_regression < 0
    ):
        parser.error(
            "--compare and a nonnegative --max-regression must be supplied together"
        )
    system = platform.system()
    if system not in {"Darwin", "Linux"}:
        parser.error("RSS measurement requires macOS or Linux /usr/bin/time")
    run_dir = None
    try:
        metadata = json.loads(
            output(
                [
                    "cargo",
                    "metadata",
                    "--offline",
                    "--locked",
                    "--no-deps",
                    "--format-version",
                    "1",
                ],
                root,
            )
        )
        package = next(
            p
            for p in metadata["packages"]
            if p["name"] == args.package and p["id"] in metadata["workspace_members"]
        )
        targets = [
            t for t in package["targets"] if "lib" in t["kind"] or "bin" in t["kind"]
        ]
        targets.sort(key=lambda t: "lib" not in t["kind"])
        source = (
            (root / args.source) if args.source else Path(targets[0]["src_path"])
        ).resolve()
        source.relative_to(Path(package["manifest_path"]).parent)
        if source.suffix != ".rs" or not source.is_file():
            raise ValueError(
                "source must be an existing .rs file in the selected package"
            )
        parent = root / ".build/build-health"
        parent.mkdir(parents=True, exist_ok=True)
        run_dir = Path(
            tempfile.mkdtemp(prefix=f"{args.package}-{args.profile}-", dir=parent)
        )
        report = {
            "environment": {
                "package": args.package,
                "profile": args.profile,
                "target": args.target,
                "system": platform.platform(),
                "machine": platform.machine(),
                "host": platform.node(),
                "cpu_count": os.cpu_count(),
                "jobs": args.jobs,
                "runs": args.runs,
                "rustc": output(["rustc", "-vV"], root),
                "cargo": output(["cargo", "-V"], root),
                "source": str(source.relative_to(root)),
                "flags": {
                    name: value
                    for name, value in os.environ.items()
                    if name in BUILD_ENV
                    or name.startswith(("CARGO_PROFILE_", "CARGO_TARGET_"))
                },
            },
            "commit": output(["git", "rev-parse", "HEAD"], root),
            "dirty": bool(output(["git", "status", "--porcelain"], root)),
            "lock_sha256": hashlib.sha256(
                (root / "Cargo.lock").read_bytes()
            ).hexdigest(),
            "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "measurements": {scenario: [] for scenario in SCENARIOS},
        }
        inputs = {
            root / name
            for name in (
                "Cargo.toml",
                "Cargo.lock",
                ".cargo/config.toml",
                "scripts/cargo.py",
            )
        }
        inputs.update((source, Path(package["manifest_path"])))
        report["inputs"] = {
            str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(inputs)
        }
        build_timestamps = tracked_build_timestamps(root)
        if args.compare:
            baseline = json.loads(args.compare.read_text())
            if baseline["environment"] != report["environment"]:
                raise ValueError("baseline environment differs; no builds were started")
        for trial in range(args.runs):
            target = run_dir / f"target-{trial + 1}"
            command = [
                sys.executable,
                "-B",
                "scripts/cargo.py",
                "build",
                "--locked",
                "--offline",
                "-p",
                args.package,
                "--profile",
                args.profile,
                "--jobs",
                str(args.jobs),
                "--target-dir",
                str(target),
                "--timings",
                "--message-format=json-render-diagnostics",
            ]
            if args.target:
                command += ["--target", args.target]
            try:
                for scenario in SCENARIOS:
                    log = run_dir / f"{trial + 1}-{scenario}.log"
                    print(
                        f"{args.package} {trial + 1}/{args.runs}: {scenario}",
                        flush=True,
                    )
                    measurement = (
                        touch_build(source, command, log, system, root)
                        if scenario == "touch"
                        else measure(command, log, system, root)
                    )
                    measurement["command"] = command
                    measurement["artifacts"] = artifacts(log, package["id"], target)
                    report["measurements"][scenario].append(measurement)
                    timings = target / "cargo-timings/cargo-timing.html"
                    if timings.exists():
                        shutil.copy2(timings, run_dir / f"{trial + 1}-{scenario}.html")
            finally:
                # This directory was allocated by this run; shared Cargo output is never cleaned.
                if target.exists():
                    remove_run_target(target)
        for name, digest in report["inputs"].items():
            if hashlib.sha256((root / name).read_bytes()).hexdigest() != digest:
                raise ValueError(
                    f"{name} changed during measurement; repeat with stable inputs"
                )
        if output(["git", "rev-parse", "HEAD"], root) != report["commit"]:
            raise ValueError("HEAD changed during measurement; repeat with stable inputs")
        if tracked_build_timestamps(root) != build_timestamps:
            raise ValueError(
                "tracked Rust or TOML timestamps changed during measurement; repeat with stable inputs"
            )
        report["medians"] = {
            scenario: {
                metric: statistics.median(v[metric] for v in values)
                for metric in ("seconds", "max_rss_bytes")
            }
            for scenario, values in report["measurements"].items()
        }
        destination = run_dir / "report.json"
        destination.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report["medians"], indent=2))
        print(f"Report: {destination}")
        if args.compare:
            errors = compare(
                baseline, report, args.max_regression, args.absolute_regression
            )
            for error in errors:
                print(error, file=sys.stderr)
            return int(bool(errors))
        return 0
    except (
        OSError,
        ValueError,
        KeyError,
        IndexError,
        StopIteration,
        RuntimeError,
        subprocess.CalledProcessError,
    ) as error:
        print(f"Build benchmark failed: {error}. Logs: {run_dir}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
