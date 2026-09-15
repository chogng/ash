"""Fetch and verify the pinned ripgrep executable used by Ash packages."""

import json
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional

from .cargo import validate_input_binary
from build.download.artifacts import (
    archive_is_valid,
    download_and_verify,
    extract_member,
    sha256,
)
from build.lib.ash_build.targets import TargetSpec


@dataclass(frozen=True)
class RipgrepResolution:
    executable: Path
    version: str
    source: str
    binary_sha256: str
    archive: Optional[str] = None
    archive_sha256: Optional[str] = None


@dataclass(frozen=True)
class LockedArtifact:
    key: str
    archive: str
    size: int
    sha256: str
    archive_format: str
    executable_member: str
    url: str


def resolve_ripgrep(
    spec: TargetSpec,
    lock_path: Path,
    cache_root: Path,
    explicit_binary: Optional[Path] = None,
) -> RipgrepResolution:
    lock = load_lock(lock_path)
    artifact = artifact_for_target(lock, spec.target)
    version = required_string(lock, "version")

    if explicit_binary is not None:
        executable = validate_input_binary(
            explicit_binary, "ripgrep executable", "--rg-bin", spec.is_windows
        )
        return RipgrepResolution(
            executable=executable,
            version=version,
            source="local-override",
            binary_sha256=sha256(executable),
        )

    artifact_cache = cache_root / version / artifact.key
    archive_path = artifact_cache / artifact.archive
    if not archive_is_valid(archive_path, artifact):
        download_and_verify(artifact, archive_path)

    executable = artifact_cache / spec.ripgrep_name
    extract_member(
        archive_path, artifact.archive_format, artifact.executable_member, executable
    )
    if not spec.is_windows:
        mode = executable.stat().st_mode
        executable.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return RipgrepResolution(
        executable=executable,
        version=version,
        source="upstream-release",
        binary_sha256=sha256(executable),
        archive=artifact.archive,
        archive_sha256=artifact.sha256,
    )


def load_lock(lock_path: Path) -> Dict[str, Any]:
    try:
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(
            "Could not read ripgrep lock {}: {}".format(lock_path, error)
        ) from error
    if lock.get("schemaVersion") != 1 or lock.get("runtime") != "ripgrep":
        raise RuntimeError("Unsupported ripgrep lock schema in {}".format(lock_path))
    return lock


def artifact_for_target(lock: Dict[str, Any], target: str) -> LockedArtifact:
    target_map = lock.get("packageTargets")
    artifacts = lock.get("artifacts")
    if not isinstance(target_map, dict) or not isinstance(artifacts, dict):
        raise RuntimeError("ripgrep lock is missing packageTargets or artifacts")
    artifact_key = target_map.get(target)
    if not isinstance(artifact_key, str):
        raise RuntimeError("No ripgrep artifact is locked for {}".format(target))
    value = artifacts.get(artifact_key)
    if not isinstance(value, dict):
        raise RuntimeError(
            "ripgrep artifact {!r} for {} is missing".format(artifact_key, target)
        )

    archive = required_string(value, "archive")
    repository = required_string(lock.get("source"), "repository")
    release = required_string(lock.get("source"), "release")
    url = value.get("url")
    if not isinstance(url, str):
        url = "{}/releases/download/{}/{}".format(
            repository.rstrip("/"), release, archive
        )
    digest = required_string(value, "sha256")
    if len(digest) != 64 or any(
        character not in "0123456789abcdef" for character in digest
    ):
        raise RuntimeError(
            "Invalid SHA-256 for ripgrep artifact {!r}".format(artifact_key)
        )
    archive_format = required_string(value, "format")
    if archive_format not in ("tar.gz", "zip"):
        raise RuntimeError(
            "Unsupported ripgrep archive format {!r}".format(archive_format)
        )
    return LockedArtifact(
        key=artifact_key,
        archive=archive,
        size=required_integer(value, "size"),
        sha256=digest,
        archive_format=archive_format,
        executable_member=required_string(value, "executable"),
        url=url,
    )


def required_string(value: Any, key: str) -> str:
    if not isinstance(value, dict) or not isinstance(value.get(key), str):
        raise RuntimeError("ripgrep lock field {!r} must be a string".format(key))
    return value[key]


def required_integer(value: Any, key: str) -> int:
    if not isinstance(value, dict) or not isinstance(value.get(key), int):
        raise RuntimeError("ripgrep lock field {!r} must be an integer".format(key))
    return value[key]
