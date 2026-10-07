#!/usr/bin/env python3
"""Generate the Rust-owned App Server protocol fixtures."""

import argparse
import json
import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def protocol_source_directories(*, root: Path = ROOT) -> list[str]:
    """Find path dependencies of the generator, including shared contracts and macros."""
    tree = subprocess.check_output(
        [
            "cargo",
            "tree",
            "--locked",
            "-p",
            "ash-app-server-protocol",
            "--features",
            "export",
            "--edges",
            "normal,build",
            "--prefix",
            "none",
            "--format",
            "{p}",
        ],
        cwd=root,
        text=True,
    )
    directories = set()
    for line in tree.splitlines():
        # Cargo annotates repeated packages and procedural macros after the source path.
        package = re.sub(r"(?: \((?:\*|proc-macro)\))+$", "", line)
        source = re.search(r" \((.+)\)$", package)
        if source and (path := Path(source[1])).is_absolute():
            directories.add(str(path.resolve()))
    return sorted(directories)


def generate_protocol(*, root: Path = ROOT) -> None:
    # Match the development backend's profile so shared dependencies reuse its cache
    # and protocol edits retain the compact profile's lower optimization cost.
    subprocess.run(
        [
            "cargo",
            "run",
            "--quiet",
            "--locked",
            "--profile",
            "dev-small",
            "-p",
            "ash-app-server-protocol",
            "--features",
            "export",
            "--bin",
            "generate_protocol",
            "--",
            "fixtures",
        ],
        cwd=root,
        check=True,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-directories", action="store_true")
    arguments = parser.parse_args()
    if arguments.source_directories:
        print(json.dumps(protocol_source_directories()))
    else:
        generate_protocol()
