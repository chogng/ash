#!/usr/bin/env python3
"""Run the repository-owned Python test suites."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
TEST_SUITES = {
    "scripts": "scripts",
    "ash-code": "scripts/ash-code",
    "build": "build",
}


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("suites", nargs="*", metavar="SUITE")
    args = parser.parse_args(arguments)
    unknown = [suite for suite in args.suites if suite not in TEST_SUITES]
    if unknown:
        parser.error(
            f"unknown suite {unknown[0]!r}; choose from {', '.join(TEST_SUITES)}"
        )
    suites = args.suites or tuple(TEST_SUITES)

    environment = os.environ.copy()
    python_paths = [str(REPOSITORY_ROOT)]
    if existing := environment.get("PYTHONPATH"):
        python_paths.append(existing)
    environment["PYTHONPATH"] = os.pathsep.join(python_paths)

    for suite in suites:
        test_root = TEST_SUITES[suite]
        result = subprocess.run(
            [
                sys.executable,
                "-B",
                "-m",
                "unittest",
                "discover",
                "-s",
                test_root,
                "-p",
                "test_*.py",
                *(["-t", str(REPOSITORY_ROOT)] if suite == "build" else []),
            ],
            cwd=REPOSITORY_ROOT,
            env=environment,
            check=False,
        )
        if result.returncode != 0:
            return result.returncode
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
