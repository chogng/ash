"""Build or validate the vendored Bubblewrap helper for Linux packages."""

import hashlib
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from pathlib import PurePosixPath
from typing import Any, Dict, List, Optional

from .cargo import validate_input_binary
from build.lib.cargo import cargo_profile_directory
from build.lib.cargo import resolve_cargo_target_directory
from build.lib.targets import TargetSpec


REQUIRED_SOURCE_FILES = (
    "COPYING",
    "bind-mount.c",
    "bind-mount.h",
    "bubblewrap.c",
    "network.c",
    "network.h",
    "utils.c",
    "utils.h",
)


@dataclass(frozen=True)
class BubblewrapResolution:
    executable: Path
    version: str
    binary_sha256: str
    source_archive: str
    source_archive_sha256: str
    license_files: List[Path]
    source: str


@dataclass(frozen=True)
class VendoredSource:
    directory: Path
    version: str
    archive_name: str
    archive_sha256: str


def resolve_bubblewrap(
    repository_root: Path,
    spec: TargetSpec,
    explicit_binary: Optional[Path],
    cargo: str,
    cargo_profile: str,
) -> Optional[BubblewrapResolution]:
    if not spec.is_linux:
        if explicit_binary is not None:
            raise RuntimeError("--bwrap-bin is only supported for Linux packages")
        return None

    source = load_vendored_source(repository_root / "ash-rs" / "vendor" / "bubblewrap")
    if explicit_binary is not None:
        executable = validate_input_binary(
            explicit_binary, "Bubblewrap executable", "--bwrap-bin", False
        )
        executable_source = "local-override"
    else:
        executable = build_bubblewrap(
            repository_root,
            spec,
            cargo,
            cargo_profile,
        )
        executable_source = "vendored-source-build"
    return BubblewrapResolution(
        executable=executable,
        version=source.version,
        binary_sha256=sha256(executable),
        source_archive=source.archive_name,
        source_archive_sha256=source.archive_sha256,
        license_files=[source.directory / "COPYING"],
        source=executable_source,
    )


def load_vendored_source(source_directory: Path) -> VendoredSource:
    metadata_path = source_directory / "ash-source.json"
    try:
        value = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(
            "Could not read vendored Bubblewrap metadata {}: {}".format(
                metadata_path, error
            )
        ) from error
    if value.get("schemaVersion") != 1 or value.get("name") != "bubblewrap":
        raise RuntimeError(
            "Unsupported vendored Bubblewrap metadata in {}".format(metadata_path)
        )

    archive = required_mapping(value, "archive")
    version = required_path_component(value, "version")
    archive_name = required_path_component(archive, "name")
    digest = required_string(archive, "sha256")
    if len(digest) != 64 or any(
        character not in "0123456789abcdef" for character in digest
    ):
        raise RuntimeError("Invalid vendored Bubblewrap archive SHA-256")
    required_string(value, "repository")
    required_string(value, "release")

    missing = [
        name
        for name in REQUIRED_SOURCE_FILES
        if not (source_directory / name).is_file()
    ]
    if missing:
        raise RuntimeError(
            "Vendored Bubblewrap source is missing required files: {}".format(
                ", ".join(missing)
            )
        )
    return VendoredSource(
        directory=source_directory,
        version=version,
        archive_name=archive_name,
        archive_sha256=digest,
    )


def build_bubblewrap(
    repository_root: Path,
    spec: TargetSpec,
    cargo: str,
    cargo_profile: str,
) -> Path:
    target_directory = resolve_cargo_target_directory(repository_root)
    command = [
        cargo,
        "build",
        "--manifest-path",
        str(repository_root / "Cargo.toml"),
        "--package",
        "ash-bwrap",
        "--bin",
        "bwrap",
        "--profile",
        cargo_profile,
        "--target",
        spec.target,
        "--target-dir",
        str(target_directory),
    ]
    subprocess.run(command, check=True)
    profile_directory = cargo_profile_directory(cargo_profile)
    executable = target_directory / spec.target / profile_directory / "bwrap"
    return validate_input_binary(
        executable, "built Bubblewrap executable", cargo, False
    )


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as contents:
        for chunk in iter(lambda: contents.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def required_mapping(value: Dict[str, Any], key: str) -> Dict[str, Any]:
    result = value.get(key)
    if not isinstance(result, dict):
        raise RuntimeError(
            "Vendored Bubblewrap metadata field {!r} must be an object".format(key)
        )
    return result


def required_string(value: Dict[str, Any], key: str) -> str:
    result = value.get(key)
    if not isinstance(result, str) or not result:
        raise RuntimeError(
            "Vendored Bubblewrap metadata field {!r} must be a non-empty string".format(
                key
            )
        )
    return result


def required_path_component(value: Dict[str, Any], key: str) -> str:
    result = required_string(value, key)
    if result in (".", "..") or PurePosixPath(result).name != result:
        raise RuntimeError(
            "Vendored Bubblewrap metadata field {!r} must be one path component".format(
                key
            )
        )
    return result
