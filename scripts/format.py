#!/usr/bin/env python3
"""Format repository sources or check the configured formatters."""

from __future__ import annotations

import argparse
import shlex
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class Command:
    name: str
    args: tuple[str, ...]


def commands(check: bool) -> tuple[Command, ...]:
    just = ["just", "--unstable", "--fmt"]
    rust = ["cargo", "fmt", "--manifest-path", "Cargo.toml", "--all", "--"]
    python = [
        "uv",
        "run",
        "--frozen",
        "--project",
        "scripts",
        "ruff",
        "format",
    ]
    if check:
        just.append("--check")
        rust.append("--check")
        python.append("--check")
    python.extend(
        (
            "build",
            "scripts",
        )
    )
    return (
        Command("Just", tuple(just)),
        Command("Rust", tuple(rust)),
        Command("Python", tuple(python)),
    )


def run(command: Command) -> tuple[str, int, str]:
    try:
        result = subprocess.run(
            command.args,
            cwd=REPOSITORY_ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            encoding="utf-8",
            check=False,
        )
    except OSError as error:
        return command.name, 1, f"$ {shlex.join(command.args)}\n{error}\n"
    return command.name, result.returncode, result.stdout


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--check",
        action="store_true",
        help="check formatting without modifying files",
    )
    args = parser.parse_args()

    failures: list[str] = []
    configured = commands(args.check)
    with ThreadPoolExecutor(max_workers=len(configured)) as executor:
        futures = [executor.submit(run, command) for command in configured]
        for future in as_completed(futures):
            name, returncode, output = future.result()
            if returncode == 0:
                continue
            failures.append(name)
            print(f"==> {name} formatter failed", file=sys.stderr)
            print(output, end="" if output.endswith("\n") else "\n", file=sys.stderr)

    if failures:
        print(f"Formatting failed: {', '.join(sorted(failures))}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
