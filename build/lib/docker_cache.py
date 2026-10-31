"""Maintain local Docker build caches without removing development containers."""

from __future__ import annotations

import argparse
import json
import os
import plistlib
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from build.lib.file_lock import exclusive_lock

ROOT = Path(__file__).resolve().parents[2]
LABEL = "dev.ash.docker-cache"
IDLE_SECONDS = 24 * 60 * 60
LEGACY_VOLUMES = {
    "ash-todo-mxc-target",
    "ash-todo-mxc-cargo",
    "ash-todo-mxc-python",
    "ash-main-ci-x64-cache",
    "ash-main-ci-x64-output",
}
CACHE_VOLUME = re.compile(r"ash-[a-z0-9]{52}-(build-output|tool-cache)\Z")


def _docker(context: str, *arguments: str, timeout: int = 120) -> str:
    result = subprocess.run(
        ["docker", "--context", context, *arguments],
        check=True,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    return result.stdout.strip()


def _containers(context: str) -> list[dict]:
    ids = _docker(context, "ps", "--all", "--quiet").split()
    return json.loads(_docker(context, "inspect", *ids)) if ids else []


def _idle(container: dict, now: datetime) -> bool:
    if container["State"]["Status"] not in {"exited", "dead"}:
        return False
    # Docker emits nanoseconds, while Python's datetime retains microseconds.
    finished = datetime.fromisoformat(
        container["State"]["FinishedAt"].replace("Z", "+00:00")
    )
    return (now - finished).total_seconds() >= IDLE_SECONDS


def _build_volumes(containers: list[dict], now: datetime) -> dict[str, str]:
    volumes = {}
    for container in containers:
        mounts = container.get("Mounts", [])
        workspace = next(
            (
                mount["Destination"]
                for mount in mounts
                if mount["Type"] == "bind" and Path(mount["Source"]).resolve() == ROOT
            ),
            None,
        )
        if workspace is None or not _idle(container, now):
            continue
        for mount in mounts:
            if (
                mount["Type"] == "volume"
                and CACHE_VOLUME.fullmatch(mount["Name"])
                and mount["Destination"] == workspace + "/.build"
            ):
                # Use the existing container's immutable image; never pull or
                # start the development container just to maintain its cache.
                volumes[mount["Name"]] = container["Image"]
    return volumes


def _protected_volumes(containers: list[dict], now: datetime) -> set[str]:
    return {
        mount["Name"]
        for container in containers
        if not _idle(container, now)
        for mount in container.get("Mounts", [])
        if mount["Type"] == "volume"
    }


def maintain_docker_cache(context: str, *, empty: bool = False) -> None:
    configuration = json.loads(_docker(context, "context", "inspect", context))[0]
    if not configuration["Endpoints"]["docker"]["Host"].startswith("unix://"):
        raise ValueError("Docker cache maintenance requires a local Unix socket")
    # `info` also probes CLI plugins and can stall under launchd's minimal PATH.
    # The server version is enough to establish daemon availability and platform.
    if _docker(context, "version", "--format", "{{.Server.Os}}", timeout=60) != "linux":
        raise ValueError("Docker cache maintenance requires Linux containers")
    pressure = shutil.disk_usage(ROOT).free < 32 * 1024**3
    now = datetime.now(timezone.utc)
    containers = _containers(context)
    referenced = {
        mount["Name"]
        for container in containers
        for mount in container.get("Mounts", [])
        if mount["Type"] == "volume"
    }
    names = _docker(context, "volume", "ls", "--quiet").splitlines()
    for name in names:
        if name not in referenced and (
            name in LEGACY_VOLUMES or CACHE_VOLUME.fullmatch(name)
        ):
            # Docker refuses removal if a container acquired a reference after
            # discovery. Do not use forced removal or a global volume prune.
            print(_docker(context, "volume", "rm", name), flush=True)

    for name, image in _build_volumes(containers, now).items():
        # Another container can share the volume; recent stopped containers and
        # every non-stopped state also protect it. Cargo locks protect profiles
        # if compilation begins after this snapshot.
        if name in _protected_volumes(_containers(context), datetime.now(timezone.utc)):
            continue
        incremental_gib, artifact_gib = (
            (0, 0) if empty else ((0, 8) if pressure else (8, 32))
        )
        script = (
            "import sys; from pathlib import Path; "
            "sys.path.insert(0, '/maintenance'); "
            "from build.lib.cargo_cache import "
            "trim_incremental_cache, trim_artifact_cache; "
            "p = Path('/cache/cargo'); "
            f"n = trim_incremental_cache(p, {incremental_gib} * 1024**3); "
            f"n += trim_artifact_cache(p, {artifact_gib} * 1024**3); "
            "print(f'Reclaimed {n / 1024**3:.2f} GiB of Docker Cargo cache')"
        )
        print(
            _docker(
                context,
                "run",
                "--rm",
                "--pull=never",
                "--network=none",
                "--read-only",
                "--user=0",
                "--entrypoint=python3",
                "--mount",
                f"type=bind,src={ROOT},dst=/maintenance,readonly",
                "--mount",
                f"type=volume,src={name},dst=/cache,volume-nocopy",
                image,
                "-B",
                "-c",
                script,
                timeout=600,
            ),
            flush=True,
        )

    # BuildKit owns in-use records and its eviction order. This applies only to
    # the selected local daemon's default builder, regardless of buildx selection.
    print(
        _docker(
            context,
            "buildx",
            "--builder",
            context,
            "prune",
            "--force",
            "--all",
            "--filter",
            "until=24h",
            "--max-used-space",
            "1GB" if empty or pressure else "8GB",
            "--min-free-space",
            "32GB",
            timeout=600,
        ),
        flush=True,
    )


def install(context: str) -> None:
    if sys.platform != "darwin":
        raise ValueError("--install requires macOS launchd")
    cache = Path.home() / "Library/Caches/ash/docker-maintenance"
    cache.mkdir(parents=True, exist_ok=True)
    agent = Path.home() / "Library/LaunchAgents" / f"{LABEL}.plist"
    agent.parent.mkdir(parents=True, exist_ok=True)
    # launchd does not inherit the interactive shell's PATH or Docker context.
    docker = shutil.which("docker")
    if docker is None:
        raise ValueError("Docker CLI is not installed")
    configuration = {
        "Label": LABEL,
        "ProgramArguments": [
            sys.executable,
            "-B",
            "-m",
            "build.lib.docker_cache",
            "--context",
            context,
        ],
        "WorkingDirectory": str(ROOT),
        "EnvironmentVariables": {
            "PATH": os.pathsep.join([str(Path(docker).parent), "/usr/bin", "/bin"])
        },
        "StartInterval": 3600,
        "RunAtLoad": True,
        "ProcessType": "Background",
        "StandardOutPath": str(cache / "maintenance.log"),
        "StandardErrorPath": str(cache / "maintenance.err.log"),
    }
    agent.write_bytes(plistlib.dumps(configuration))
    domain = f"gui/{os.getuid()}"
    subprocess.run(
        ["launchctl", "bootout", domain, str(agent)], capture_output=True, check=False
    )
    subprocess.run(["launchctl", "bootstrap", domain, str(agent)], check=True)
    print(f"Installed hourly Docker cache maintenance: {agent}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", default="desktop-linux")
    parser.add_argument(
        "--empty", action="store_true", help="Empty idle Cargo profiles"
    )
    parser.add_argument(
        "--install", action="store_true", help="Install hourly macOS job"
    )
    args = parser.parse_args()
    try:
        if args.install:
            install(args.context)
            return 0
        cache = Path.home() / ".cache/ash/docker-maintenance"
        cache.mkdir(parents=True, exist_ok=True)
        with exclusive_lock(
            cache / "maintenance.lock", create=True, blocking=False
        ) as lock:
            if lock:
                maintain_docker_cache(args.context, empty=args.empty)
        return 0
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"Docker cache maintenance failed: {error}", file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            print(error.stderr, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
