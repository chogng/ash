#!/usr/bin/env python3
"""Publish incremental Desktop backend builds against prepared shared resources."""

import argparse
import json
import os
import sys
import subprocess
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from build.lib.package_binaries import build_binaries
from build.lib.development_store import publish_generation
from build.lib.development_store import frozen_binary
from build.lib.file_lock import exclusive_lock
from build.lib.cargo_cache import leased_cache
from build.prepare import (
    PROFILE,
    current_package,
    development_binary_inputs,
    development_root,
    parse_arguments,
    prepare_development_package,
)
from build.lib.targets import TARGETS, default_target
from build.desktop.live import build_live, live_directory

ROOT = Path(__file__).resolve().parents[2]


def build_development_server(
    *,
    root: Path = ROOT,
    prepare: bool = False,
    protocol_prepared: bool = False,
    context_file: str | None = None,
) -> tuple[bool, str]:
    spec = TARGETS[default_target()]
    publication = _build_context(prepare, context_file)
    shared_directory = root / ".build/desktop/dev/app-server"
    directory = shared_directory
    if os.environ.get("ASH_DEV_SUBSECOND") == "1":
        pointer = Path(os.environ["ASH_DEV_APP_SERVER_GENERATION"])
        if not pointer.is_absolute() or pointer.name != "current.json":
            raise ValueError(
                "Subsecond requires an isolated development runtime pointer"
            )
        directory = pointer.parent
    directory.mkdir(parents=True, exist_ok=True)
    shared_directory.mkdir(parents=True, exist_ok=True)
    with ExitStack() as frozen, ThreadPoolExecutor(max_workers=1) as startup:
        if not prepare:
            frozen.enter_context(
                leased_cache(
                    root,
                    profile=PROFILE,
                    target_triple=spec.target if spec.is_windows else None,
                )
            )
        preloads = []
        replacements = {}

        def preload(name: str, executable: Path) -> None:
            if spec.is_windows and name == "ash-app-server":
                executable = frozen.enter_context(frozen_binary(executable, directory))
                replacements[name] = executable
                # Windows first-image loading can block CreateProcess for seconds.
                # Start its read-only version command while the isolated media
                # groups and publication still run. No backend/profile is opened.
                preloads.append(startup.submit(_load_app_server, executable))

        with exclusive_lock(shared_directory / "build.lock", create=True):
            package = (
                prepare_development_package(parse_arguments([]), root=root)
                if prepare
                else current_package(
                    development_root(root, spec.target, "host-provided-node")
                )
            )
            if live_directory() is not None:
                build_live(root, protocol_prepared=protocol_prepared)
            binaries = (
                {}
                if prepare
                else build_binaries(
                    root,
                    spec,
                    development_binary_inputs(spec),
                    cargo="cargo",
                    cargo_profile=PROFILE,
                    host_build=True,
                    protocol_prepared=protocol_prepared,
                    on_rebuilt_binary=preload if spec.is_windows else None,
                    plan_directory=directory,
                )
            )
            # Cargo outputs are mutable until publication freezes them. Keep the
            # build lock through selection so another watcher cannot overtake us.
            binaries.update(replacements)
            if os.environ.get("ASH_DEV_SUBSECOND") == "1" and not prepare:
                # Even a build identical to the prepared binaries must replace the
                # externally started Subsecond process on the first fallback.
                marker = directory / "ash-subsecond-fallback"
                marker.write_text("normal runtime\n")
                binaries[marker.name] = marker
            result = publish_generation(
                package, binaries, directory, publication=publication
            )
        print(
            f"[app-server] {'Published' if result[0] else 'Unchanged'} {result[1]}",
            flush=True,
        )
        for preload_result in preloads:
            preload_result.result()
    return result


def _build_context(prepare: bool, source: str | None) -> dict:
    if source is None:
        return {
            "buildId": str(uuid.uuid4()),
            "reason": "prepared-runtime-selection" if prepare else "manual-build",
            "files": [],
            "omittedFileCount": 0,
        }
    data = Path(source).read_bytes()
    if len(data) > 262_144:
        raise ValueError("Development build context is oversized")
    context = json.loads(data)
    if not isinstance(context, dict) or set(context) - {
        "buildId",
        "reason",
        "files",
        "buildLog",
        "omittedFileCount",
    }:
        raise ValueError("Invalid development build context")
    if not isinstance(context.get("buildId"), str):
        raise ValueError("Invalid development build ID")
    uuid.UUID(context["buildId"])
    if context.get("reason") not in {"source-change", "initial-build"}:
        raise ValueError("Invalid development build reason")
    files = context.get("files")
    if (
        not isinstance(files, list)
        or len(files) > 128
        or any(
            not isinstance(file, str)
            or not file
            or len(file) > 1024
            or file.startswith("/")
            or "\\" in file
            or ":" in file
            or any(part in {"", ".", ".."} for part in file.split("/"))
            or "\0" in file
            for file in files
        )
    ):
        raise ValueError("Invalid development build source paths")
    omitted = context.get("omittedFileCount")
    if type(omitted) is not int or omitted < 0:
        raise ValueError("Invalid development build omitted file count")
    if "buildLog" in context and (
        not isinstance(context["buildLog"], str)
        or not Path(context["buildLog"]).is_absolute()
        or len(context["buildLog"]) > 4096
    ):
        raise ValueError("Invalid development build log path")
    return context


def _load_app_server(executable: Path) -> None:
    subprocess.run(
        [str(executable), "--version"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        check=True,
        timeout=30,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--protocol-prepared",
        action="store_true",
        help="Reuse the protocol already prepared by the source watcher",
    )
    parser.add_argument(
        "--prepare",
        action="store_true",
        help="Prepare the shared package and publish its Desktop generation",
    )
    arguments = parser.parse_args()
    build_development_server(
        prepare=arguments.prepare,
        protocol_prepared=arguments.protocol_prepared,
        # Every watcher save uses a new diagnostic path. Consume it before
        # computing Cargo input identity or launching compiler subprocesses.
        context_file=os.environ.pop("ASH_DEV_BUILD_CONTEXT_FILE", None),
    )
