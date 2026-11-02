"""Collect Rust unit coverage through Ash's Cargo runner and cargo-llvm-cov."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]


def coverage_environment(output: str) -> dict[str, str]:
    """Parse show-env assignments as data, without evaluating shell commands."""
    environment = {}
    for line in output.splitlines():
        if not line.strip():
            continue
        fields = shlex.split(line)
        if len(fields) != 1 or "=" not in fields[0]:
            raise ValueError("Invalid cargo llvm-cov show-env assignment")
        name, value = fields[0].split("=", 1)
        if re.fullmatch(r"[A-Z_][A-Z_0-9]*", name) is None:
            raise ValueError("Invalid cargo llvm-cov environment name")
        environment[name] = value
    if not {"LLVM_PROFILE_FILE", "CARGO_LLVM_COV_TARGET_DIR"} <= environment.keys():
        raise ValueError("cargo llvm-cov did not provide a coverage environment")
    return environment


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("-p", "--package", action="append", default=[])
    selection.add_argument("--workspace", action="store_true")
    parser.add_argument("--profile", default="ci-test")
    parser.add_argument("--target")
    parser.add_argument("--features", action="append", default=[])
    parser.add_argument("--all-features", action="store_true")
    parser.add_argument("--no-default-features", action="store_true")
    parser.add_argument("-j", "--jobs", type=int)
    parser.add_argument("--coveragePath", type=Path)
    parser.add_argument("test_arguments", nargs=argparse.REMAINDER)
    args = parser.parse_args(arguments)
    if args.jobs is not None and args.jobs < 1:
        parser.error("--jobs must be positive")
    if args.test_arguments and args.test_arguments[0] != "--":
        parser.error("libtest arguments must follow --")

    # Detect missing tools before reserving a report directory or starting builds.
    subprocess.run(["cargo", "llvm-cov", "--version"], cwd=ROOT, check=True)
    parent = ROOT / ".build/coverage"
    parent.mkdir(parents=True, exist_ok=True)
    if args.coveragePath:
        directory = args.coveragePath.resolve()
        directory.mkdir()  # Do not erase or merge an earlier run's data.
    else:
        directory = Path(tempfile.mkdtemp(prefix="rust-", dir=parent))
    environment = os.environ.copy()
    environment["CARGO_TARGET_DIR"] = str(directory / "target")
    environment["CARGO_LLVM_COV_TARGET_DIR"] = environment["CARGO_TARGET_DIR"]
    target = ["--target", args.target] if args.target else []
    shown = subprocess.check_output(
        ["cargo", "llvm-cov", "show-env", "--no-cfg-coverage", *target],
        cwd=ROOT,
        env=environment,
        text=True,
    )
    environment.update(coverage_environment(shown))
    packages = (
        [option for package in args.package for option in ("-p", package)]
        if args.package
        else ["--workspace"]
    )
    build = ["--profile", args.profile, *target]
    for feature in args.features:
        build.extend(("--features", feature))
    if args.all_features:
        build.append("--all-features")
    if args.no_default_features:
        build.append("--no-default-features")
    if args.jobs:
        build.extend(("--jobs", str(args.jobs)))
    command = [
        sys.executable,
        "-B",
        "scripts/cargo.py",
        "test",
        *packages,
        *build,
        "--lib",
        "--bins",
        "--no-fail-fast",
        *args.test_arguments,
    ]
    metadata = {
        "command": command,
        "status": "incomplete",
        "scope": "Rust library and binary unit tests in the selected root-workspace packages and their instrumented workspace dependencies; excludes integration tests, doctests, external dependencies and separately distributed workspaces. No frontend coverage is included.",
        "profile": args.profile,
        "target": args.target,
        "packages": args.package or ["--workspace"],
        "branchCoverage": "not collected on the pinned stable Rust toolchain",
    }
    try:
        with (directory / "tests.log").open("w") as log:
            with subprocess.Popen(
                command,
                cwd=ROOT,
                env=environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
            ) as child:
                assert child.stdout is not None
                for line in child.stdout:
                    sys.stdout.write(line)
                    log.write(line)
                code = child.wait()
        executed = sum(
            int(passed) + int(failed)
            for passed, failed in re.findall(
                r"test result: .*? (\d+) passed; (\d+) failed;",
                (directory / "tests.log").read_text(),
            )
        )
        metadata.update(
            status="passed" if code == 0 and executed else "failed",
            testExitCode=code,
            executedTests=executed,
        )
        # Report even failed tests, while preserving their failing exit status.
        # A fresh target directory prevents stale profiles/binaries from entering
        # this run and keeps instrumentation out of normal development artifacts.
        report = [
            "cargo",
            "llvm-cov",
            "report",
            "--profile",
            args.profile,
            *target,
            "--ignore-filename-regex",
            r"[/\\](third_party|test-support)[/\\]",
        ]
        for options in (
            ["--html", "--output-dir", str(directory)],
            ["--lcov", "--output-path", str(directory / "lcov.info")],
            ["--json", "--output-path", str(directory / "coverage.json")],
            [],
        ):
            completed = subprocess.run(
                [*report, *options], cwd=ROOT, env=environment, check=False
            )
            if completed.returncode:
                metadata["reportExitCode"] = completed.returncode
                metadata["status"] = "failed"
                return code or completed.returncode
        if not executed:
            print(
                "No Rust unit tests executed; this is not a coverage pass.",
                file=sys.stderr,
            )
        print(f"Rust coverage ({metadata['status']} test run): {directory}")
        return code or (0 if executed else 1)
    except KeyboardInterrupt:
        metadata["status"] = "interrupted"
        raise
    finally:
        (directory / "run.json").write_text(json.dumps(metadata, indent=2) + "\n")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"Rust coverage failed: {error}", file=sys.stderr)
        print(
            "Prerequisites: cargo install cargo-llvm-cov --version 0.9.1 --locked; rustup component add llvm-tools-preview",
            file=sys.stderr,
        )
        raise SystemExit(1)
