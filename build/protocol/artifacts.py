"""Portable protocol artifacts shared by preparation and package assembly."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
from pathlib import Path, PurePosixPath

PACKAGE_PROTOCOL = "ash-resources/protocol"
SOURCE_MANIFEST = "protocol-sources.json"
REQUIRED_ARTIFACTS = {
    "metadata.json",
    "json/schema.json",
    "typescript/index.ts",
    "typescript/protocol.ts",
}


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


def artifact_digests(directory: Path) -> dict[str, str]:
    return {
        path.relative_to(directory).as_posix(): hashlib.sha256(
            path.read_bytes()
        ).hexdigest()
        for path in source_files(directory)
    }


def graph_source_files(root: Path, directories: list[str]) -> list[Path]:
    files = [
        path
        for directory in (root / "crates", root / "cli")
        for path in source_files(directory)
        if path.name == "Cargo.toml"
    ]
    files += [Path(directory) / "Cargo.toml" for directory in directories]
    files += [root / "Cargo.toml", root / "Cargo.lock"]
    files += list((root / ".cargo").glob("*.toml"))
    files += list(root.glob("rust-toolchain*"))
    files += [
        root / "build/protocol" / name for name in ("generate.py", "artifacts.py")
    ]
    return [path for path in files if path.is_file()]


def portable_sources(root: Path, directories: list[str]) -> dict:
    root = root.resolve()
    paths = [Path(directory).resolve() for directory in directories]
    # Paths, timestamps and tool installations differ between devices. Only owned
    # source content and export-affecting compiler flags identify a portable contract.
    relative_directories = [path.relative_to(root).as_posix() for path in paths]
    files = graph_source_files(root, [str(path) for path in paths])
    files += [path for directory in paths for path in source_files(directory)]
    return {
        "formatVersion": 1,
        "directories": sorted(relative_directories),
        "files": {
            path.relative_to(root).as_posix(): hashlib.sha256(
                path.read_bytes()
            ).hexdigest()
            for path in sorted(set(files))
        },
        "compilerEnvironment": {
            name: os.environ[name]
            for name in ("RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "RUSTC_BOOTSTRAP")
            if name in os.environ
        },
    }


def owned_path(root: Path, name: str) -> Path:
    relative = PurePosixPath(name)
    if (
        not name
        or "\\" in name
        or relative.is_absolute()
        or any(part in {".", ".."} for part in name.split("/"))
    ):
        raise ValueError("Invalid protocol artifact path")
    path = root.joinpath(*relative.parts)
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError("Protocol artifact escapes its owner")
    return path


def read_contract(directory: Path, manifest_path: Path) -> tuple[dict, dict]:
    manifest = json.loads(manifest_path.read_text())
    if not isinstance(manifest, dict) or manifest.get("formatVersion") != 1:
        raise ValueError("Invalid protocol source manifest")
    directories = manifest.get("directories")
    if (
        not isinstance(directories, list)
        or not directories
        or not all(isinstance(name, str) for name in directories)
    ):
        raise ValueError("Invalid protocol source directories")
    for name in directories:
        owned_path(directory, name)
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, dict) or not REQUIRED_ARTIFACTS.issubset(artifacts):
        raise ValueError("Protocol export did not produce the complete contract")
    for name in artifacts:
        owned_path(directory, name)
    if artifact_digests(directory) != artifacts:
        raise ValueError("Protocol artifact digests do not match")
    metadata = json.loads((directory / "metadata.json").read_text())
    if (
        not isinstance(metadata, dict)
        or type(metadata.get("major")) is not int
        or metadata["major"] < 0
        or not isinstance(metadata.get("schemaHash"), str)
        or re.fullmatch(r"sha256:[a-f0-9]{64}", metadata["schemaHash"]) is None
    ):
        raise ValueError("Invalid protocol metadata")
    return manifest, metadata


def copy_prepared_contract(root: Path, destination: Path, metadata: dict) -> None:
    source = root / ".build/protocol"
    manifest, observed = read_contract(source, root / ".build" / SOURCE_MANIFEST)
    directories = [str(owned_path(root, name)) for name in manifest["directories"]]
    if {
        key: value for key, value in manifest.items() if key != "artifacts"
    } != portable_sources(root, directories) or observed != metadata:
        raise ValueError("Prepared protocol does not match package sources or metadata")
    shutil.copytree(source, destination)
    shutil.copyfile(
        root / ".build" / SOURCE_MANIFEST, destination.parent / SOURCE_MANIFEST
    )


def matching_package_contract(root: Path, package: Path) -> tuple[Path, dict] | None:
    directory = package / PACKAGE_PROTOCOL
    try:
        manifest, metadata = read_contract(
            directory, directory.parent / SOURCE_MANIFEST
        )
        directories = [str(owned_path(root, name)) for name in manifest["directories"]]
        if {
            key: value for key, value in manifest.items() if key != "artifacts"
        } != portable_sources(root, directories):
            return None
        package_metadata = json.loads((package / "ash-package.json").read_text())
        if package_metadata.get("protocol") != metadata:
            return None
        files = package_metadata.get("files", {})
        expected = {
            f"{PACKAGE_PROTOCOL}/{name}": digest
            for name, digest in manifest["artifacts"].items()
        }
        expected[f"ash-resources/{SOURCE_MANIFEST}"] = hashlib.sha256(
            (directory.parent / SOURCE_MANIFEST).read_bytes()
        ).hexdigest()
        if not isinstance(files, dict) or any(
            files.get(name) != digest for name, digest in expected.items()
        ):
            return None
        return directory, manifest
    except (OSError, ValueError, TypeError, AttributeError):
        return None


def protocol_packages(root: Path, explicit: Path | None):
    if explicit is not None:
        yield explicit.expanduser().resolve()
    # Use only the currently selected publication in each existing development
    # store. An older compatible package must not replace a newer selected backend.
    store_root = root / ".build/runtime/dev/store-v1"
    for manifests in sorted(store_root.glob("*/*/*/manifests")):
        names = sorted(
            path
            for path in manifests.glob("*.json")
            if re.fullmatch(r"\d{20}\.json", path.name)
        )
        if not names:
            continue
        try:
            manifest = json.loads(names[-1].read_text())
            name = manifest["directory"]
            if (
                manifest.get("formatVersion") == 1
                and manifest.get("sequence") == int(names[-1].stem)
                and isinstance(name, str)
                and re.fullmatch(
                    r"packages/[0-9A-Za-z][0-9A-Za-z.+-]*/[a-f0-9]{64}", name
                )
            ):
                yield owned_path(manifests.parent, name)
        except (OSError, ValueError, TypeError, KeyError):
            continue
