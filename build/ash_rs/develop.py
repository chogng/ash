#!/usr/bin/env python3
"""Build backend development executables and publish the App Server generation."""

import json
import re
import shutil
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from build.ash_rs.cargo import build_binaries
from build.ash_rs.livekit import resolve_livekit
from build.download.artifacts import sha256
from build.lib.targets import TARGETS, default_target


ROOT = Path(__file__).resolve().parents[2]
PROFILE = "dev-small"
GENERATION_NAME = re.compile(r"ash-app-server\.([a-f0-9]{64})(?:\.exe)?\Z")


def read_current_generation(pointer: Path) -> str | None:
    try:
        value = json.loads(pointer.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None
    if (
        isinstance(value, dict)
        and value.get("version") == 1
        and isinstance(value.get("executable"), str)
        and Path(value["executable"]).name == value["executable"]
    ):
        return value["executable"]
    return None


def generation_digest(path: Path) -> str:
    addressed = GENERATION_NAME.fullmatch(path.name)
    return addressed.group(1) if addressed else sha256(path)


def prune_generations(directory: Path, current: str) -> None:
    current_path = directory / current
    if not current_path.is_file():
        return
    generations = sorted(
        (
            entry
            for entry in directory.iterdir()
            if entry.is_file()
            and entry.name.startswith("ash-app-server.")
            and entry.name != current
        ),
        key=lambda path: (path.stat().st_mtime_ns, path.name),
        reverse=True,
    )
    retained = {generation_digest(current_path)}
    for path in generations:
        digest = generation_digest(path)
        if digest not in retained and len(retained) <= 1:
            retained.add(digest)
            continue
        try:
            path.unlink()
        except PermissionError:
            # Windows can keep an older running executable open during pruning.
            pass


def publish_generation(
    source: Path, directory: Path, *, is_windows: bool
) -> tuple[bool, str]:
    digest = sha256(source)
    generation = f"ash-app-server.{digest}{'.exe' if is_windows else ''}"
    executable = directory / generation
    pointer = directory / "current.json"
    directory.mkdir(parents=True, exist_ok=True)
    if read_current_generation(pointer) == generation and executable.is_file():
        prune_generations(directory, generation)
        return False, generation
    if not executable.is_file():
        staging = directory / f".{generation}.{uuid.uuid4()}.tmp"
        try:
            shutil.copy2(source, staging)
            staging.replace(executable)
        finally:
            staging.unlink(missing_ok=True)
    next_pointer = directory / f".current.{uuid.uuid4()}.tmp"
    try:
        next_pointer.write_text(
            json.dumps({"version": 1, "executable": generation}) + "\n",
            encoding="utf-8",
        )
        next_pointer.replace(pointer)
    finally:
        next_pointer.unlink(missing_ok=True)
    prune_generations(directory, generation)
    return True, generation


def publish_helpers(
    directory: Path, helpers: dict[str, Path], *, is_windows: bool
) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for name, source in helpers.items():
        destination = directory / f"{name}{'.exe' if is_windows else ''}"
        staging = directory / f".{destination.name}.{uuid.uuid4()}.tmp"
        try:
            shutil.copy2(source, staging)
            staging.replace(destination)
        finally:
            staging.unlink(missing_ok=True)


def build_development_server(*, root: Path = ROOT) -> tuple[bool, str]:
    target = default_target()
    spec = TARGETS[target]
    print("[app-server] Building ash-app-server", flush=True)
    binaries = build_binaries(
        root,
        spec,
        {
            "ash-app-server": None,
            "ash-voice-host": None,
            "ash-collaboration-server": None,
        },
        cargo="cargo",
        cargo_profile=PROFILE,
        host_build=True,
    )
    livekit = resolve_livekit(target, root=root)
    directory = root / ".build/app-ts/dev/app-server"
    publish_helpers(
        directory,
        {
            "ash-voice-host": binaries["ash-voice-host"],
            "ash-collaboration-server": binaries["ash-collaboration-server"],
            "livekit-server": livekit,
        },
        is_windows=spec.is_windows,
    )
    result = publish_generation(
        binaries["ash-app-server"], directory, is_windows=spec.is_windows
    )
    print(f"[app-server] {'Published' if result[0] else 'Unchanged'} {result[1]}")
    return result


if __name__ == "__main__":
    build_development_server()
