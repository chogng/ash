#!/usr/bin/env python3
"""Submit one final macOS release container for notarization."""

from __future__ import annotations

import argparse
import os
import sys
from typing import Optional
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT))

from build.lib.signing import CommandRunner, require_environment, run_command


def notarize(
    artifact: Path,
    runner: Optional[CommandRunner] = None,
    *,
    staple: bool = False,
) -> None:
    artifact = artifact.expanduser().resolve()
    if artifact.is_symlink() or not artifact.exists():
        raise RuntimeError(f"notarization artifact does not exist: {artifact}")
    profile = require_environment("ASH_MACOS_NOTARY_PROFILE")
    xcrun = os.environ.get("ASH_MACOS_XCRUN") or "xcrun"
    run_command(
        [
            xcrun,
            "notarytool",
            "submit",
            str(artifact),
            "--keychain-profile",
            profile,
            "--wait",
        ],
        runner,
    )
    if staple:
        run_command([xcrun, "stapler", "staple", str(artifact)], runner)
        run_command([xcrun, "stapler", "validate", str(artifact)], runner)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("artifact", type=Path)
    parser.add_argument("--staple", action="store_true")
    arguments = parser.parse_args()
    notarize(arguments.artifact, staple=arguments.staple)
    print(f"Notarized {arguments.artifact.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
