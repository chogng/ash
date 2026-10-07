#!/usr/bin/env python3
"""Publish incremental Desktop backend builds against prepared shared resources."""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from build.lib.package_binaries import build_binaries
from build.lib.development_store import publish_generation
from build.prepare import (
    PROFILE,
    current_package,
    development_binary_inputs,
    development_root,
)
from build.lib.targets import TARGETS, default_target

ROOT = Path(__file__).resolve().parents[2]


def build_development_server(
    *, root: Path = ROOT, select_prepared: bool = False
) -> tuple[bool, str]:
    spec = TARGETS[default_target()]
    package = current_package(development_root(root, spec.target, "host-provided-node"))
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
        )
    )
    result = publish_generation(
        package, binaries, root / ".build/desktop/dev/app-server"
    )
    print(f"[app-server] {'Published' if result[0] else 'Unchanged'} {result[1]}")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--select-prepared",
        action="store_true",
        help="Select prepared binaries without invoking Cargo",
    )
    arguments = parser.parse_args()
    build_development_server(select_prepared=arguments.select_prepared)
