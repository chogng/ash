#!/usr/bin/env python3
"""Verify a local or published Remote release through Desktop bootstrap and loopback SSH."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import getpass
import json
import os
from pathlib import Path
import shlex
import socket
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from build.remote_smoke import remote_fixture_directory, verify  # noqa: E402


@contextmanager
def ssh_server(fixture: Path, log):
    """Use a separate loopback listener; never replace the machine's SSH service."""
    if os.name != "nt":
        server = subprocess.Popen(
            ["/usr/sbin/sshd", "-D", "-e", "-f", str(fixture / "sshd_config")],
            stdout=log,
            stderr=log,
        )
        try:
            yield lambda: server.poll() is None
        finally:
            server.terminate()
            server.wait(timeout=15)
        return

    # Windows sshd needs LocalSystem to create authenticated sessions. A private
    # own-process service leaves an existing user's sshd and configuration alone.
    sshd = Path(os.environ["SystemRoot"]) / "System32/OpenSSH/sshd.exe"
    service = "AshRemoteRelease-" + fixture.parent.name
    key = str(fixture / "host")
    for arguments in (
        # ssh-keygen can add an explicit user ACE. Reset it before dropping all
        # inherited permissions, so the service key has only SYSTEM/Admin access.
        ["icacls.exe", key, "/reset"],
        [
            "icacls.exe",
            key,
            "/inheritance:r",
            "/grant:r",
            "*S-1-5-18:F",
            "*S-1-5-32-544:F",
        ],
        ["icacls.exe", key, "/setowner", "*S-1-5-32-544"],
        [
            "sc.exe",
            "create",
            service,
            "binPath=",
            subprocess.list2cmdline(
                [
                    str(sshd),
                    "-f",
                    str(fixture / "sshd_config"),
                    "-E",
                    str(fixture / "sshd.log"),
                ]
            ),
            "start=",
            "demand",
            "type=",
            "own",
        ],
    ):
        subprocess.run(arguments, check=True, stdout=log, stderr=log)
    try:
        subprocess.run(["sc.exe", "start", service], check=True, stdout=log, stderr=log)
        yield (
            lambda: (
                subprocess.run(
                    ["sc.exe", "query", service], capture_output=True, check=False
                ).returncode
                == 0
            )
        )
    finally:
        subprocess.run(["sc.exe", "stop", service], stdout=log, stderr=log, check=False)
        # SCM stops the listener asynchronously. Wait before deleting its config.
        for _ in range(100):
            state = subprocess.run(["sc.exe", "query", service], capture_output=True)
            if b"STOPPED" in state.stdout:
                break
            time.sleep(0.1)
        subprocess.run(
            ["sc.exe", "delete", service], stdout=log, stderr=log, check=True
        )


def ssh_client(fixture: Path) -> Path:
    config = fixture / "ssh_config"
    if os.name != "nt":
        ssh = fixture / "ssh"
        ssh.write_text(
            "#!/bin/sh\nexec /usr/bin/ssh -F " + shlex.quote(str(config)) + ' "$@"\n'
        )
        ssh.chmod(0o700)
        return ssh

    # Spawn requires a real executable on Windows. Compile a test-only stdio
    # proxy rather than changing the runner user's ~/.ssh/config or using cmd.exe.
    executable = str(Path(os.environ["SystemRoot"]) / "System32/OpenSSH/ssh.exe")
    source = fixture / "ssh.rs"
    source.write_text(
        "fn main() {\n"
        f" let status = std::process::Command::new({json.dumps(executable, ensure_ascii=False)})\n"
        f'  .args(["-F", {json.dumps(str(config), ensure_ascii=False)}])\n'
        '  .args(std::env::args_os().skip(1)).status().expect("start OpenSSH");\n'
        " std::process::exit(status.code().unwrap_or(1));\n}\n",
        encoding="utf-8",
    )
    ssh = fixture / "ssh.exe"
    subprocess.run(["rustc", str(source), "-o", str(ssh)], check=True)
    return ssh


@contextmanager
def ssh_fixture(root: Path, reports: Path):
    """Own a private SSH listener and retain its diagnostics for either verifier."""
    reports.mkdir(parents=True, exist_ok=True)
    fixture = root / "ssh"
    fixture.mkdir(mode=0o700)

    keygen = (
        str(Path(os.environ["SystemRoot"]) / "System32/OpenSSH/ssh-keygen.exe")
        if os.name == "nt"
        else "ssh-keygen"
    )
    for name in ("host", "user"):
        subprocess.run(
            [keygen, "-q", "-t", "ed25519", "-f", str(fixture / name), "-N", ""],
            check=True,
        )
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    (fixture / "authorized_keys").write_bytes((fixture / "user.pub").read_bytes())
    (fixture / "sshd_config").write_text(
        f'Port {port}\nListenAddress 127.0.0.1\nHostKey "{fixture.as_posix()}/host"\n'
        f'PidFile "{fixture.as_posix()}/sshd.pid"\nAuthorizedKeysFile "{fixture.as_posix()}/authorized_keys"\n'
        "StrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\n"
        + ("" if os.name == "nt" else "UsePAM no\n")
        + f"AllowUsers {getpass.getuser().lower()}\nLogLevel ERROR\n"
        + f'SetEnv "ASH_HOME={root.as_posix()}/remote-profile"\n'
    )
    (fixture / "known_hosts").write_text(
        f"[127.0.0.1]:{port} " + (fixture / "host.pub").read_text()
    )
    (fixture / "ssh_config").write_text(
        f"Host ash-release-fixture\n HostName 127.0.0.1\n Port {port}\n"
        f' User {getpass.getuser()}\n IdentityFile "{fixture.as_posix()}/user"\n'
        f' IdentitiesOnly yes\n BatchMode yes\n StrictHostKeyChecking yes\n UserKnownHostsFile "{fixture.as_posix()}/known_hosts"\n'
        " LogLevel ERROR\n"
    )
    ssh = ssh_client(fixture)
    try:
        with (
            (reports / "release-sshd.log").open("w") as log,
            ssh_server(fixture, log) as running,
        ):
            for _ in range(40):
                probe = subprocess.run(
                    [str(ssh), "ash-release-fixture", "echo SSH_READY"],
                    capture_output=True,
                    text=True,
                    timeout=15,
                )
                if probe.returncode == 0 or not running():
                    break
                time.sleep(0.1)
            if probe.returncode != 0:
                raise RuntimeError(
                    f"OpenSSH fixture failed: {probe.stderr}; see {log.name}"
                )
            yield ssh
    finally:
        ssh_log = fixture / "sshd.log"
        if ssh_log.exists():
            try:
                events = ssh_log.read_bytes()
            except PermissionError as error:
                # Windows can deny access to the LocalSystem service's log.
                # Retain that diagnostic without replacing the acceptance result.
                (reports / "release-sshd-events-unavailable.txt").write_text(
                    str(error) + "\n"
                )
            else:
                (reports / "release-sshd-events.log").write_bytes(events)


def accept(
    package: Path, report: Path, binding: Path | None, catalog: Path | None
) -> None:
    package, report = package.resolve(), report.resolve()
    source = (
        ["--binding", str(binding.resolve())]
        if binding is not None
        else ["--catalog-dir", str(catalog.resolve())]
    )
    assert not (package / "ash-resources/capabilities").exists()
    report.parent.mkdir(parents=True, exist_ok=True)
    with remote_fixture_directory(
        prefix="arr-" if os.name == "nt" else "ash-release-ssh-"
    ) as temporary:
        root = Path(temporary).resolve()
        suffix = ".exe" if os.name == "nt" else ""

        def run(*arguments: str) -> None:
            try:
                subprocess.run(arguments, cwd=ROOT, check=True, capture_output=True)
            except subprocess.CalledProcessError as error:
                sys.stderr.write(
                    (error.stdout + error.stderr).decode("utf-8", errors="replace")
                )
                raise

        with ssh_fixture(root, report.parent) as ssh:
            try:
                script = root / "remoteReleaseAcceptance.js"
                run(
                    sys.executable,
                    "-B",
                    "build/protocol/generate.py",
                    "--package-root",
                    str(package),
                )
                run(
                    str(
                        ROOT
                        / "node_modules/bun"
                        / ("bun.exe" if os.name == "nt" else "bun")
                    ),
                    "check",
                    "-p",
                    "test/sanity/tsconfig.json",
                    "--all",
                )
                run(
                    str(
                        ROOT
                        / "node_modules/bun"
                        / ("bun.exe" if os.name == "nt" else "bun")
                    ),
                    "build",
                    "test/sanity/remoteReleaseAcceptance.ts",
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
                            *source,
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
                            "binding": json.loads(binding.read_text())
                            if binding is not None
                            else None,
                            "source": "published" if binding is not None else "local",
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
                # Keep file-list diagnostics before temporary installs are removed.
                # Runtime activation revalidates immutability after initialize.
                manifests = []
                for manifest in root.rglob("ash-package.json"):
                    metadata = json.loads(manifest.read_text(encoding="utf-8"))
                    expected = set(metadata["files"])
                    observed = {
                        path.relative_to(manifest.parent).as_posix()
                        for path in manifest.parent.rglob("*")
                        if path.is_file()
                        and path != manifest
                        and path.relative_to(manifest.parent).as_posix() != ".lease"
                    }
                    manifests.append(
                        {
                            "package": str(manifest.parent),
                            "unexpectedFiles": sorted(observed - expected),
                            "missingFiles": sorted(expected - observed),
                        }
                    )
                (report.parent / "package-integrity.json").write_text(
                    json.dumps(manifests, indent=2) + "\n"
                )
                for profile in (
                    root / "bootstrap/local-profile",
                    root / "remote-profile",
                ):
                    subprocess.run(
                        [
                            str(package / f"bin/ash-app-server-daemon{suffix}"),
                            "stop",
                        ],
                        env={**os.environ, "ASH_HOME": str(profile)},
                        capture_output=True,
                        timeout=30,
                        check=False,
                    )
    print(report)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-dir", type=Path, required=True)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--binding-file", type=Path)
    source.add_argument("--catalog-dir", type=Path)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    accept(args.package_dir, args.report, args.binding_file, args.catalog_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
