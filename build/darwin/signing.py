"""macOS executable signing and verification commands."""

import os
from pathlib import Path


def sign_command(artifact: Path, identity: str) -> list[str]:
    return [
        os.environ.get("ASH_MACOS_CODESIGN") or "codesign",
        "--force",
        "--sign",
        identity,
        "--timestamp",
        "--options",
        "runtime",
        str(artifact),
    ]


def verify_command(artifact: Path) -> list[str]:
    return [
        os.environ.get("ASH_MACOS_CODESIGN") or "codesign",
        "--verify",
        "--strict",
        "--verbose=2",
        str(artifact),
    ]
