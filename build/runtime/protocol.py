#!/usr/bin/env python3
"""Generate the Rust-owned App Server protocol fixtures."""

import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def generate_protocol(*, root: Path = ROOT) -> None:
    subprocess.run(
        [
            "cargo",
            "run",
            "--quiet",
            "--locked",
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
