"""Check Git-owned text, including new files, without reading ignored outputs."""

from __future__ import annotations

import contextlib
import subprocess
from pathlib import Path

import codespell_lib


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    inventory = subprocess.check_output(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        cwd=REPOSITORY_ROOT,
    ).decode("utf-8")
    files = sorted(
        {
            name
            for name in inventory.split("\0")
            if name and (REPOSITORY_ROOT / name).is_file()
        }
    )
    if not files:
        return 0
    with contextlib.chdir(REPOSITORY_ROOT):
        return codespell_lib.main("--config", ".codespellrc", "--", *files)


if __name__ == "__main__":
    raise SystemExit(main())
