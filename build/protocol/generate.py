#!/usr/bin/env python3
"""Generate the Rust-owned App Server protocol fixtures."""

import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


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
    generate_protocol()
