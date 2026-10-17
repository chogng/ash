#!/usr/bin/env python3
"""Verify a published Remote release using Desktop bootstrap and real loopback SSH."""

from __future__ import annotations

import argparse
import getpass
import json
import os
from pathlib import Path
import shlex
import socket
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from build.remote_smoke import verify  # noqa: E402


def accept(package: Path, binding: Path, report: Path) -> None:
    package, binding, report = package.resolve(), binding.resolve(), report.resolve()
    report.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="ash-release-ssh-") as temporary:
        root = Path(temporary).resolve()
        fixture = root / "ssh"
        fixture.mkdir(mode=0o700)

        def run(*arguments: str) -> None:
            subprocess.run(arguments, cwd=ROOT, check=True, capture_output=True)

        for name in ("host", "user"):
            run(
                "ssh-keygen", "-q", "-t", "ed25519", "-f", str(fixture / name), "-N", ""
            )
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        (fixture / "authorized_keys").write_bytes((fixture / "user.pub").read_bytes())
        (fixture / "sshd_config").write_text(
            f"Port {port}\nListenAddress 127.0.0.1\nHostKey {fixture}/host\n"
            f"PidFile {fixture}/sshd.pid\nAuthorizedKeysFile {fixture}/authorized_keys\n"
            "StrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\n"
            f"UsePAM no\nAllowUsers {getpass.getuser()}\nLogLevel ERROR\n"
            f"SetEnv ASH_HOME={root}/remote-profile\n"
        )
        (fixture / "known_hosts").write_text(
            f"[127.0.0.1]:{port} " + (fixture / "host.pub").read_text()
        )
        (fixture / "ssh_config").write_text(
            f"Host ash-release-fixture\n HostName 127.0.0.1\n Port {port}\n"
            f" User {getpass.getuser()}\n IdentityFile {fixture}/user\n"
            f" IdentitiesOnly yes\n StrictHostKeyChecking yes\n UserKnownHostsFile {fixture}/known_hosts\n"
            " LogLevel ERROR\n"
        )
        ssh = fixture / "ssh"
        ssh.write_text(
            "#!/bin/sh\nexec /usr/bin/ssh -F "
            + shlex.quote(str(fixture / "ssh_config"))
            + ' "$@"\n'
        )
        ssh.chmod(0o700)
        with (report.parent / "release-sshd.log").open("w") as log:
            server = subprocess.Popen(
                ["/usr/sbin/sshd", "-D", "-e", "-f", str(fixture / "sshd_config")],
                stdout=log,
                stderr=log,
            )
            try:
                for _ in range(40):
                    probe = subprocess.run(
                        [str(ssh), "ash-release-fixture", "printf SSH_READY"],
                        capture_output=True,
                        text=True,
                        timeout=15,
                    )
                    if probe.returncode == 0 or server.poll() is not None:
                        break
                    time.sleep(0.1)
                if probe.returncode != 0:
                    raise RuntimeError(
                        f"OpenSSH fixture failed: {probe.stderr}; see {log.name}"
                    )
                script = root / "remoteReleaseAcceptance.js"
                run(
                    sys.executable,
                    "-B",
                    "build/protocol/generate.py",
                    "--package-root",
                    str(package),
                )
                run(
                    str(ROOT / "node_modules/bun/bin/bun.exe"),
                    "check",
                    "-p",
                    "test/remote/tsconfig.json",
                    "--all",
                )
                run(
                    str(ROOT / "node_modules/bun/bin/bun.exe"),
                    "build",
                    "test/remote/remoteReleaseAcceptance.ts",
                    "--target=node",
                    "--outfile",
                    str(script),
                )
                bootstrap_report = report.with_name("desktop-bootstrap.json")
                with (report.parent / "desktop-bootstrap.log").open("w") as output:
                    subprocess.run(
                        [
                            "node",
                            str(script),
                            "--package",
                            str(package),
                            "--binding",
                            str(binding),
                            "--ssh",
                            str(ssh),
                            "--host",
                            "ash-release-fixture",
                            "--root",
                            str(root / "bootstrap"),
                            "--report",
                            str(bootstrap_report),
                        ],
                        cwd=ROOT,
                        stdout=output,
                        stderr=subprocess.STDOUT,
                        check=True,
                        timeout=900,
                        env={
                            k: v
                            for k, v in os.environ.items()
                            if not k.startswith("ASH_")
                        },
                    )
                bootstrap = json.loads(bootstrap_report.read_text())
                installed = Path(bootstrap["runtime"]).parent.parent
                smoke_report = report.with_name("published-agent-smoke.json")
                verify(installed, smoke_report, ssh, "ash-release-fixture")
                assert not (root / "bootstrap/local-profile/capabilities").exists()
                assert not (root / "remote-profile/capabilities").exists()
                report.write_text(
                    json.dumps(
                        {
                            "status": "passed",
                            "binding": json.loads(binding.read_text()),
                            "desktopBootstrap": bootstrap,
                            "editingTerminalAgent": json.loads(
                                smoke_report.read_text()
                            ),
                            "mediaPackagesInstalled": False,
                        },
                        indent=2,
                    )
                    + "\n"
                )
            finally:
                for profile in (
                    root / "bootstrap/local-profile",
                    root / "remote-profile",
                ):
                    subprocess.run(
                        [str(package / "bin/ash-app-server-daemon"), "stop"],
                        env={**os.environ, "ASH_HOME": str(profile)},
                        capture_output=True,
                        timeout=30,
                        check=False,
                    )
                server.terminate()
                server.wait(timeout=15)
    print(report)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-dir", type=Path, required=True)
    parser.add_argument("--binding-file", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    accept(args.package_dir, args.binding_file, args.report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
