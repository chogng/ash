"""Prepare the Rust-owned wire contract once for all product build consumers."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from build.lib.cargo_cache import leased_cache  # noqa: E402
from build.lib.file_lock import exclusive_lock  # noqa: E402


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


def source_files(directory: Path):
    for parent, directories, files in os.walk(directory):
        directories[:] = sorted(
            name
            for name in directories
            if name
            not in {
                ".git",
                ".build",
                "target",
                "node_modules",
                "__pycache__",
                ".pytest_cache",
            }
        )
        for name in sorted(files):
            yield Path(parent) / name


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
    files = [
        path
        for directory in (root / "crates", root / "cli")
        for path in source_files(directory)
        if path.name == "Cargo.toml"
    ]
    files += [
        Path(directory) / "Cargo.toml"
        for directory in directories
        if (Path(directory) / "Cargo.toml").is_file()
    ]
    files += [root / "Cargo.toml", root / "Cargo.lock", Path(__file__)]
    files += list((root / ".cargo").glob("*.toml"))
    files += list(root.glob("rust-toolchain*"))
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


def artifact_digests(directory: Path) -> dict[str, str]:
    return {
        path.relative_to(directory).as_posix(): hashlib.sha256(
            path.read_bytes()
        ).hexdigest()
        for path in source_files(directory)
    }


def generate_protocol(*, root: Path = ROOT, cargo: str = "cargo") -> None:
    build = root / ".build"
    build.mkdir(exist_ok=True)
    output = build / "protocol"
    cache_path = build / "protocol-inputs.json"
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
        if not directories or cache.get("graph") != graph:
            directories = protocol_source_directories(root=root, cargo=cargo)
            graph = graph_digest(root, cargo, directories)
        inputs = protocol_inputs(directories, root)
        artifacts = artifact_digests(output)
        if (
            cache.get("graph") == graph
            and cache.get("inputs") == inputs
            and artifacts
            and cache.get("artifacts") == artifacts
        ):
            return
        with tempfile.TemporaryDirectory(
            prefix="protocol-export-", dir=build
        ) as temporary:
            staging = Path(temporary)
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
            if (
                graph_digest(root, cargo, directories) != graph
                or protocol_inputs(directories, root) != inputs
            ):
                raise RuntimeError(
                    "Protocol sources changed during export; retry preparation"
                )
            generated = artifact_digests(staging)
            required = {
                "metadata.json",
                "json/schema.json",
                "typescript/index.ts",
                "typescript/protocol.ts",
            }
            if not required.issubset(generated):
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


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-directories", action="store_true")
    arguments = parser.parse_args()
    if arguments.source_directories:
        print(json.dumps(protocol_source_directories()))
    else:
        generate_protocol()
