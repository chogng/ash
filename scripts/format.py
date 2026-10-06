#!/usr/bin/env python3
"""Format repository sources or check the configured formatters."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
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


def rust_command(check: bool) -> Command:
    metadata = json.loads(
        subprocess.check_output(
            ["cargo", "metadata", "--no-deps", "--format-version", "1"],
            cwd=REPOSITORY_ROOT,
            encoding="utf-8",
        )
    )
    members = set(metadata["workspace_members"])
    packages = []
    for package in metadata["packages"]:
        if package["id"] not in members:
            continue
        manifest = Path(package["manifest_path"]).relative_to(REPOSITORY_ROOT)
        # Cargo can include path dependencies from copied upstream workspaces.
        if "vendor" not in manifest.parts and "third_party" not in manifest.parts:
            packages.append(package["name"])
    if not packages:
        raise ValueError("No first-party Rust workspace packages found.")
    args = ["cargo", "fmt", "--manifest-path", "Cargo.toml"]
    for package in sorted(packages):
        args.extend(("--package", package))
    if check:
        args.extend(("--", "--check"))
    return Command("Rust", tuple(args))


def commands(check: bool, language: str | None = None) -> tuple[Command, ...]:
    if language == "rust":
        return (rust_command(check),)
    just = ["just", "--unstable", "--fmt"]
    ruff = (
        REPOSITORY_ROOT
        / "scripts"
        / ".venv"
        / ("Scripts/ruff.exe" if os.name == "nt" else "bin/ruff")
    )
    python = [str(ruff), "format"]
    if check:
        just.append("--check")
        python.append("--check")
    python.extend(
        (
            "build",
            "scripts",
        )
    )
    pnpm = shutil.which("pnpm")
    if pnpm is None:
        raise FileNotFoundError("Install the pnpm version declared in package.json.")
    action = "" if check else ":fix"
    return (
        Command("Just", tuple(just)),
        rust_command(check),
        Command("Python", tuple(python)),
        Command("TypeScript/JavaScript", (pnpm, f"format:ts{action}")),
        Command("Configuration/documentation", (pnpm, f"format:config{action}")),
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
    parser.add_argument(
        "--language",
        choices=("rust",),
        help="run only the selected language's formatter",
    )
    args = parser.parse_args()

    failures: list[str] = []
    configured = commands(args.check, args.language)
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
