#!/usr/bin/env python3
"""Run the read-only formatting and whitespace gate before committing or publishing."""

from __future__ import annotations

import argparse
from pathlib import Path
import shlex
import subprocess
import sys


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base", help="comparison ref for the complete branch change")
    parser.add_argument(
        "--full",
        action="store_true",
        help="also check the entire repository after formatter configuration changes",
    )
    args = parser.parse_args(arguments)
    commands = [["just", "fmt-check", "--changed", args.base]]
    if args.full:
        commands.append(["just", "fmt-check"])
    commands.extend(
        (
            ["git", "diff", "--check"],
            ["git", "diff", "--cached", "--check"],
        )
    )
    for command in commands:
        print(f"$ {shlex.join(command)}", flush=True)
        try:
            result = subprocess.run(command, cwd=REPOSITORY_ROOT, check=False)
        except OSError as error:
            print(f"Commit checks failed: {error}", file=sys.stderr)
            return 1
        if result.returncode:
            return result.returncode
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
