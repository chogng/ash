#!/usr/bin/env python3
"""Build incremental Rust outputs against separately prepared development resources."""

import argparse
import hashlib
import json
import os
import shutil
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from build.ash_rs.cargo import build_binaries
from build.ash_rs.prepare import (
    PROFILE,
    current_package,
    development_binary_inputs,
    development_root,
)
from build.download.artifacts import sha256
from build.lib.targets import TARGETS, default_target

ROOT = Path(__file__).resolve().parents[2]


def publish_generation(
    package: Path, binaries: dict[str, Path], directory: Path
) -> tuple[bool, str]:
    # Windows link and directory APIs need extended paths for packaged resource names.
    if os.name == "nt":
        package = Path("\\\\?\\" + str(package.resolve()).removeprefix("\\\\?\\"))
        directory = Path("\\\\?\\" + str(directory.resolve()).removeprefix("\\\\?\\"))
    # Cargo may rewrite its outputs on the next build. Freeze only changed binary contents;
    # generations share executable objects through hard links. Declarative resource readers
    # require single-link files, so each generation must own copies of ash-resources.
    files = {
        f"bin/{path.name}": path
        for path in (package / "bin").iterdir()
        if path.is_file()
    }
    bubblewrap = package / "ash-resources/bwrap"
    if bubblewrap.is_file():
        files["ash-resources/bwrap"] = bubblewrap
    files.update(
        {
            "ash-resources/bwrap" if name == "bwrap" else f"bin/{path.name}": path
            for name, path in binaries.items()
        }
    )
    digests = {name: sha256(path) for name, path in sorted(files.items())}
    identity = json.dumps(
        {"version": 1, "resources": str(package.resolve()), "binaries": digests},
        sort_keys=True,
    )
    generation = hashlib.sha256(identity.encode()).hexdigest()
    contents = json.dumps({"version": 3, "runtime": f"generations/{generation}"}) + "\n"
    pointer = directory / "current.json"
    if pointer.is_file() and pointer.read_text(encoding="utf-8") == contents:
        return False, generation
    directory.mkdir(parents=True, exist_ok=True)
    runtime = directory / "generations" / generation
    if not runtime.exists():
        staging = directory / f".staging-{uuid.uuid4()}"
        try:
            (staging / "bin").mkdir(parents=True)
            objects = directory / "objects"
            objects.mkdir(exist_ok=True)
            shutil.copytree(
                package / "ash-path", staging / "ash-path", copy_function=os.link
            )
            shutil.copytree(package / "ash-resources", staging / "ash-resources")
            for name, source in files.items():
                immutable = objects / digests[name]
                if not immutable.exists():
                    temporary = objects / f".{uuid.uuid4()}.tmp"
                    try:
                        shutil.copy2(source, temporary)
                        temporary.replace(immutable)
                    finally:
                        temporary.unlink(missing_ok=True)
                destination = staging / name
                destination.unlink(missing_ok=True)
                os.link(immutable, destination)
            (staging / "ash-development.json").write_text(
                identity + "\n", encoding="utf-8"
            )
            (staging / ".lease").touch()
            runtime.parent.mkdir(exist_ok=True)
            staging.rename(runtime)
        finally:
            if staging.exists():
                shutil.rmtree(staging)
    next_pointer = directory / f".current.{uuid.uuid4()}.tmp"
    try:
        next_pointer.write_text(contents, encoding="utf-8")
        next_pointer.replace(pointer)
    finally:
        next_pointer.unlink(missing_ok=True)
    return True, generation


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
        package, binaries, root / ".build/app-ts/dev/app-server"
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
