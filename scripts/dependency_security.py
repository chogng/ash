"""Check Ash's dependency security policy with the pinned cargo-deny tool."""

from __future__ import annotations

import argparse
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
DENY_VERSION = "0.20.2"


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--deny", default="cargo-deny", help="path to pinned cargo-deny"
    )
    args = parser.parse_args(arguments)
    try:
        version = subprocess.check_output([args.deny, "--version"], text=True).strip()
        if version != f"cargo-deny {DENY_VERSION}":
            raise ValueError(f"expected cargo-deny {DENY_VERSION}, got {version}")
        return subprocess.run(
            [
                args.deny,
                "--workspace",
                "--locked",
                "--config",
                str(ROOT / ".cargo/deny.toml"),
                "check",
                "advisories",
                "licenses",
                "sources",
            ],
            cwd=ROOT,
            check=False,
        ).returncode
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"Dependency security check failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
