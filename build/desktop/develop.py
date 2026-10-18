#!/usr/bin/env python3
"""Publish incremental Desktop backend builds against prepared shared resources."""

import argparse
import sys
import subprocess
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from build.lib.package_binaries import build_binaries
from build.lib.development_store import publish_generation
from build.lib.development_store import frozen_binary
from build.prepare import (
    PROFILE,
    current_package,
    development_binary_inputs,
    development_root,
)
from build.lib.targets import TARGETS, default_target

ROOT = Path(__file__).resolve().parents[2]


def build_development_server(
    *, root: Path = ROOT, select_prepared: bool = False, protocol_prepared: bool = False
) -> tuple[bool, str]:
    spec = TARGETS[default_target()]
    package = current_package(development_root(root, spec.target, "host-provided-node"))
    directory = root / ".build/desktop/dev/app-server"
    with ExitStack() as frozen, ThreadPoolExecutor(max_workers=1) as startup:
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

        binaries = (
            {}
            if select_prepared
            else build_binaries(
                root,
                spec,
                development_binary_inputs(spec),
                cargo="cargo",
                cargo_profile=PROFILE,
                host_build=True,
                protocol_prepared=protocol_prepared,
                on_rebuilt_binary=preload if spec.is_windows else None,
            )
        )
        binaries.update(replacements)
        result = publish_generation(package, binaries, directory)
        print(
            f"[app-server] {'Published' if result[0] else 'Unchanged'} {result[1]}",
            flush=True,
        )
        for preload_result in preloads:
            preload_result.result()
    return result


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
        "--select-prepared",
        action="store_true",
        help="Select prepared binaries without invoking Cargo",
    )
    arguments = parser.parse_args()
    build_development_server(
        select_prepared=arguments.select_prepared,
        protocol_prepared=arguments.protocol_prepared,
    )
