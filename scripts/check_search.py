"""Compile the public search APIs and every workspace crate that directly consumes them."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
SEARCH_APIS = {"ash-grep", "ash-file-search"}


def search_packages(metadata: dict) -> list[str]:
    members = set(metadata["workspace_members"])
    packages = [p for p in metadata["packages"] if p["id"] in members]
    if not SEARCH_APIS <= {p["name"] for p in packages}:
        raise ValueError("workspace search APIs are missing")
    return sorted(
        p["name"]
        for p in packages
        if p["name"] in SEARCH_APIS | {"ash-tgrep"}
        or any(d["name"] in SEARCH_APIS for d in p["dependencies"])
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--deny-warnings", action="store_true")
    args = parser.parse_args()
    metadata = json.loads(
        subprocess.check_output(
            ["cargo", "metadata", "--locked", "--no-deps", "--format-version", "1"],
            cwd=ROOT,
        )
    )
    packages = search_packages(metadata)
    print("Search API consumers: " + ", ".join(packages), flush=True)
    command = [sys.executable, "-B", "scripts/cargo.py"]
    if args.deny_warnings:
        command.append("--deny-warnings")
    command.append("check")
    for package in packages:
        command.extend(["-p", package])
    if args.deny_warnings:
        command.append("--all-targets")
    return subprocess.call(command, cwd=ROOT)


if __name__ == "__main__":
    raise SystemExit(main())
