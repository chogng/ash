#!/usr/bin/env python3
"""Exercise the production Windows installer over isolated SSH before packaging."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from build.release.verify_remote import ssh_fixture  # noqa: E402
from build.remote_smoke import remote_fixture_directory  # noqa: E402


def verify(target: str, reports: Path) -> None:
    reports = reports.resolve()
    reports.mkdir(parents=True, exist_ok=True)
    with remote_fixture_directory(prefix="awi-") as temporary:
        with ssh_fixture(Path(temporary).resolve(), reports) as ssh:
            with (reports / "installer.log").open("w") as log:
                subprocess.run(
                    [
                        sys.executable,
                        "-B",
                        "scripts/cargo.py",
                        "test",
                        "-p",
                        "ash-remote-connections",
                        "--profile",
                        "ci-test",
                        "--locked",
                        "--target",
                        target,
                        "--lib",
                        "install_tests::powershell_installer_preserves_binary_uploads_and_reuses_immutable_runtime",
                        "--",
                        "--exact",
                    ],
                    cwd=ROOT,
                    env={**os.environ, "ASH_REMOTE_INSTALLER_TEST_SSH": str(ssh)},
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    check=True,
                    timeout=300,
                )
    (reports / "report.json").write_text(
        json.dumps(
            {
                "status": "passed",
                "target": target,
                "transport": "OpenSSH",
                "binaryFixtureBytes": 8 * 1024 * 1024,
            }
        )
        + "\n"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--target",
        choices=("x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"),
        required=True,
    )
    parser.add_argument("--reports", type=Path, required=True)
    args = parser.parse_args()
    if os.name != "nt":
        parser.error("Windows OpenSSH preflight requires a native Windows host")
    verify(args.target, args.reports)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
