"""Validate host tools used by the build integration tests, without downloads."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from build.release.tools import check_build_tools  # noqa: E402


def main() -> int:
    try:
        resolved = check_build_tools()
    except RuntimeError as error:
        print(error, file=sys.stderr)
        return 1
    for name, executable in resolved.items():
        print(f"{name}: {executable}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
