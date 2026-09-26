"""Install the pinned repository Python tools into scripts/.venv."""

from __future__ import annotations

import os
import subprocess
import venv
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parent
ENVIRONMENT = SCRIPTS / ".venv"


def main() -> None:
    python = ENVIRONMENT / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not (ENVIRONMENT / "pyvenv.cfg").is_file():
        venv.EnvBuilder(with_pip=False).create(ENVIRONMENT)
    subprocess.run([str(python), "-m", "ensurepip", "--upgrade"], check=True)
    subprocess.run(
        [
            str(python),
            "-m",
            "pip",
            "--disable-pip-version-check",
            "install",
            "--require-hashes",
            "--no-deps",
            "--only-binary=:all:",
            "-r",
            str(SCRIPTS / "requirements.txt"),
        ],
        check=True,
    )


if __name__ == "__main__":
    main()
