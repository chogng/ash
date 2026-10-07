"""Prepare the Rust-owned wire contract once for all product build consumers."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from build.lib.cargo_cache import leased_cache  # noqa: E402
from build.lib.file_lock import exclusive_lock  # noqa: E402
from build.protocol.artifacts import (  # noqa: E402
    REQUIRED_ARTIFACTS,
    SOURCE_MANIFEST,
    artifact_digests,
    graph_source_files,
    matching_package_contract,
    owned_path,
    portable_sources,
    protocol_packages,
    source_files,
)


def protocol_source_directories(
    *, root: Path = ROOT, cargo: str = "cargo"
) -> list[str]:
    tree = subprocess.check_output(
        [
            cargo,
            "tree",
            "--locked",
            "-p",
            "ash-app-server-protocol",
            "--features",
            "export",
            "--edges",
            "normal,build",
            "--prefix",
            "none",
            "--format",
            "{p}",
        ],
        cwd=root,
        text=True,
    )
    directories = set()
    for line in tree.splitlines():
        # Cargo annotates shared dependencies and procedural macros after the path.
        line = line.removesuffix(" (*)").removesuffix(" (proc-macro)")
        if " (" not in line or not line.endswith(")"):
            continue
        directory = line.split(" (", 1)[1][:-1]
        if Path(directory).is_absolute():
            directories.add(directory)
    if not directories:
        raise RuntimeError("Cargo did not report the protocol's source directories")
    return sorted(directories)


def digest_files(files: list[Path], *, root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(set(files)):
        digest.update(os.path.relpath(path, root).encode())
        digest.update(b"\0")
        content = path.read_bytes()
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return digest.hexdigest()


def graph_digest(root: Path, cargo: str, directories: list[str]) -> str:
    files = graph_source_files(root, directories)
    environment = {
        key: value
        for key, value in os.environ.items()
        if key.startswith(("CARGO_", "RUSTUP_", "RUSTC", "RUSTFLAGS"))
    }
    return hashlib.sha256(
        json.dumps(
            [digest_files(files, root=root), cargo, environment], sort_keys=True
        ).encode()
    ).hexdigest()


def protocol_inputs(directories: list[str], root: Path) -> str:
    return digest_files(
        [path for directory in directories for path in source_files(Path(directory))],
        root=root,
    )


def generate_protocol(
    *, root: Path = ROOT, cargo: str = "cargo", package_root: Path | None = None
) -> None:
    build = root / ".build"
    build.mkdir(exist_ok=True)
    output = build / "protocol"
    cache_path = build / "protocol-inputs.json"
    sources_path = build / SOURCE_MANIFEST
    if package_root is None and os.environ.get("ASH_PROTOCOL_PACKAGE"):
        package_root = Path(os.environ["ASH_PROTOCOL_PACKAGE"])
    # Frontend preparation and backend preparation can run concurrently. OS locks
    # release on cancellation/crash, unlike a persistent lock-directory marker.
    with exclusive_lock(build / "protocol.lock", create=True):
        try:
            cache = json.loads(cache_path.read_text())
        except (OSError, ValueError):
            cache = {}
        if not isinstance(cache, dict):
            cache = {}
        directories = cache.get("directories")
        if not isinstance(directories, list) or not all(
            isinstance(path, str) for path in directories
        ):
            directories = []
        graph = graph_digest(root, cargo, directories)
        inputs = protocol_inputs(directories, root)
        artifacts = artifact_digests(output)
        if (
            directories
            and cache.get("graph") == graph
            and cache.get("inputs") == inputs
            and artifacts
            and cache.get("artifacts") == artifacts
        ):
            sources = portable_sources(root, directories)
            if (
                graph_digest(root, cargo, directories) != graph
                or protocol_inputs(directories, root) != inputs
            ):
                raise RuntimeError(
                    "Protocol sources changed during preparation; retry preparation"
                )
            write_source_manifest(sources_path, sources, artifacts)
            return
        package_contract = None
        for package in protocol_packages(root, package_root):
            package_contract = matching_package_contract(root, package)
            if package_contract is not None:
                break
        if package_contract is not None:
            directories = [
                str(owned_path(root, name))
                for name in package_contract[1]["directories"]
            ]
        elif not directories or cache.get("graph") != graph:
            directories = protocol_source_directories(root=root, cargo=cargo)
        graph = graph_digest(root, cargo, directories)
        inputs = protocol_inputs(directories, root)
        with tempfile.TemporaryDirectory(
            prefix="protocol-export-", dir=build
        ) as temporary:
            staging = Path(temporary)
            if package_contract is not None:
                shutil.copytree(package_contract[0], staging, dirs_exist_ok=True)
                if artifact_digests(staging) != package_contract[1]["artifacts"]:
                    raise RuntimeError("Packaged protocol changed during preparation")
            else:
                with leased_cache(root, profile="dev-small"):
                    subprocess.run(
                        [
                            cargo,
                            "run",
                            "--quiet",
                            "--locked",
                            "--profile",
                            "dev-small",
                            "-p",
                            "ash-app-server-protocol",
                            "--features",
                            "export",
                            "--bin",
                            "generate_protocol",
                            "--",
                            "all",
                            "--out",
                            str(staging),
                        ],
                        cwd=root,
                        check=True,
                    )
            sources = portable_sources(root, directories)
            if package_contract is not None and sources != {
                key: value
                for key, value in package_contract[1].items()
                if key != "artifacts"
            }:
                raise RuntimeError(
                    "Protocol sources changed during package preparation; retry preparation"
                )
            if (
                graph_digest(root, cargo, directories) != graph
                or protocol_inputs(directories, root) != inputs
            ):
                raise RuntimeError(
                    "Protocol sources changed during export; retry preparation"
                )
            generated = artifact_digests(staging)
            if not REQUIRED_ARTIFACTS.issubset(generated):
                raise RuntimeError(
                    "Protocol export did not produce the complete contract"
                )
            # Stage the complete export before publishing. Preserve unchanged file
            # timestamps so repeated preparation does not invalidate Cargo or Vite.
            for name in sorted(
                generated, key=lambda name: (name == "metadata.json", name)
            ):
                digest = generated[name]
                if artifacts.get(name) == digest:
                    continue
                destination = output / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                os.replace(staging / name, destination)
            for name in artifacts.keys() - generated.keys():
                (output / name).unlink()
            write_source_manifest(sources_path, sources, generated)
            cache_path.write_text(
                json.dumps(
                    {
                        "graph": graph,
                        "directories": directories,
                        "inputs": inputs,
                        "artifacts": generated,
                    },
                    sort_keys=True,
                )
            )


def write_source_manifest(path: Path, sources: dict, artifacts: dict[str, str]) -> None:
    contents = json.dumps({**sources, "artifacts": artifacts}, sort_keys=True)
    if path.is_file() and path.read_text() == contents:
        return
    temporary = path.with_suffix(".partial")
    temporary.write_text(contents)
    temporary.replace(path)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-directories", action="store_true")
    parser.add_argument(
        "--package-root",
        type=Path,
        help="Backend package with matching protocol artifacts",
    )
    arguments = parser.parse_args()
    generate_protocol(package_root=arguments.package_root)
    if arguments.source_directories:
        cache = json.loads((ROOT / ".build/protocol-inputs.json").read_text())
        print(json.dumps(cache["directories"]))
