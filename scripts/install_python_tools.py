"""Sync the locked repository Python tools into scripts/.venv."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parent
ENVIRONMENT = SCRIPTS / ".venv"


def main() -> None:
    uv = shutil.which("uv")
    if uv is None:
        raise SystemExit(
            "Install the uv version required by scripts/pyproject.toml and add it to PATH."
        )
    # Keep the interpreter selected by Just/Node and their shared environment path.
    # A stale lock must fail rather than changing dependency versions during setup.
    subprocess.run(
        [
            uv,
            "sync",
            "--project",
            str(SCRIPTS),
            "--locked",
            "--python",
            sys.executable,
            "--no-python-downloads",
            "--no-build",
        ],
        env={**os.environ, "UV_PROJECT_ENVIRONMENT": str(ENVIRONMENT)},
        check=True,
    )


if __name__ == "__main__":
    main()
