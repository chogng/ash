"""Fetch and verify the pinned Node.js runtime shared by language servers."""

import hashlib
import json
import os
import shutil
import stat
import tarfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.request import Request, urlopen

from .cargo import validate_input_binary
from build.lib.ash_build.targets import TargetSpec


DOWNLOAD_TIMEOUT_SECONDS = 60


@dataclass(frozen=True)
class NodeResolution:
    executable: Path
    license_file: Path
    version: str
    source: str
    binary_sha256: str
    archive: str
    archive_sha256: str


@dataclass(frozen=True)
class LockedNodeArtifact:
    key: str
    archive: str
    size: int
    sha256: str
    archive_format: str
    executable_member: str
    license_member: str
    url: str


def resolve_node(
    spec: TargetSpec,
    lock_path: Path,
    cache_root: Path,
    explicit_binary: Optional[Path] = None,
) -> NodeResolution:
    lock = load_node_lock(lock_path)
    artifact = artifact_for_target(
        lock, spec.target, license_only=explicit_binary is not None
    )
    version = required_string(lock, "version")
    artifact_cache = cache_root / version / artifact.key
    archive_path = artifact_cache / artifact.archive
    if not archive_is_valid(archive_path, artifact):
        archive_path.unlink(missing_ok=True)
        download_and_verify(artifact, archive_path)

    license_file = artifact_cache / "LICENSE"
    extract_member(archive_path, artifact, artifact.license_member, license_file)
    if explicit_binary is None:
        executable = artifact_cache / spec.node_name
        extract_member(archive_path, artifact, artifact.executable_member, executable)
        source = "upstream-release"
    else:
        executable = validate_input_binary(
            explicit_binary, "Node.js executable", "--node-bin", spec.is_windows
        )
        source = "local-override"
    if not spec.is_windows:
        executable.chmod(
            executable.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH
        )
    return NodeResolution(
        executable=executable,
        license_file=license_file,
        version=version,
        source=source,
        binary_sha256=sha256(executable),
        archive=artifact.archive,
        archive_sha256=artifact.sha256,
    )


def load_node_lock(lock_path: Path) -> Dict[str, Any]:
    try:
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(
            "Could not read Node.js runtime lock {}: {}".format(lock_path, error)
        ) from error
    if lock.get("schemaVersion") != 1 or lock.get("runtime") != "node":
        raise RuntimeError(
            "Unsupported Node.js runtime lock schema in {}".format(lock_path)
        )
    return lock


def artifact_for_target(
    lock: Dict[str, Any], target: str, license_only: bool = False
) -> LockedNodeArtifact:
    target_map = lock.get("packageTargets")
    license_targets = lock.get("licenseTargets", {})
    artifacts = lock.get("artifacts")
    if (
        not isinstance(target_map, dict)
        or not isinstance(license_targets, dict)
        or not isinstance(artifacts, dict)
    ):
        raise RuntimeError(
            "Node.js lock is missing packageTargets, licenseTargets, or artifacts"
        )
    artifact_key = target_map.get(target)
    if artifact_key is None and license_only:
        artifact_key = license_targets.get(target)
    if not isinstance(artifact_key, str):
        if target.endswith("-musl"):
            raise RuntimeError(
                "Node.js has no official musl binary for {}; pass --node-bin".format(
                    target
                )
            )
        raise RuntimeError("No Node.js artifact is locked for {}".format(target))
    value = artifacts.get(artifact_key)
    if not isinstance(value, dict):
        raise RuntimeError(
            "Node.js artifact {!r} for {} is missing".format(artifact_key, target)
        )
    archive = required_string(value, "archive")
    digest = required_string(value, "sha256")
    if len(digest) != 64 or any(
        character not in "0123456789abcdef" for character in digest
    ):
        raise RuntimeError(
            "Invalid SHA-256 for Node.js artifact {!r}".format(artifact_key)
        )
    archive_format = required_string(value, "format")
    if archive_format not in ("tar.xz", "zip"):
        raise RuntimeError(
            "Unsupported Node.js archive format {!r}".format(archive_format)
        )
    base_url = required_string(lock.get("source"), "baseUrl")
    return LockedNodeArtifact(
        key=artifact_key,
        archive=archive,
        size=required_integer(value, "size"),
        sha256=digest,
        archive_format=archive_format,
        executable_member=required_string(value, "executable"),
        license_member=required_string(value, "license"),
        url="{}/{}".format(base_url.rstrip("/"), archive),
    )


def archive_is_valid(path: Path, artifact: LockedNodeArtifact) -> bool:
    if not path.is_file():
        return False
    try:
        verify_archive(path, artifact)
    except RuntimeError:
        return False
    return True


def download_and_verify(artifact: LockedNodeArtifact, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + ".partial")
    temporary.unlink(missing_ok=True)
    request = Request(artifact.url, headers={"User-Agent": "ash-package-builder"})
    try:
        with urlopen(request, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
            with open(temporary, "wb") as output:
                shutil.copyfileobj(response, output)
        verify_archive(temporary, artifact)
        os.replace(str(temporary), str(destination))
    except Exception:
        temporary.unlink(missing_ok=True)
        destination.unlink(missing_ok=True)
        raise


def verify_archive(path: Path, artifact: LockedNodeArtifact) -> None:
    if path.stat().st_size != artifact.size or sha256(path) != artifact.sha256:
        raise RuntimeError(
            "Node.js archive failed locked size or SHA-256 validation: {}".format(path)
        )


def extract_member(
    archive_path: Path,
    artifact: LockedNodeArtifact,
    member_name: str,
    destination: Path,
) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + ".partial")
    temporary.unlink(missing_ok=True)
    try:
        if artifact.archive_format == "tar.xz":
            with tarfile.open(str(archive_path), "r:xz") as archive:
                member = archive.getmember(member_name)
                if not member.isfile():
                    raise RuntimeError(
                        "Node.js archive member {!r} is not a regular file".format(
                            member_name
                        )
                    )
                extracted = archive.extractfile(member)
                if extracted is None:
                    raise RuntimeError(
                        "Could not read Node.js archive member {!r}".format(member_name)
                    )
                with extracted, open(temporary, "wb") as output:
                    shutil.copyfileobj(extracted, output)
        else:
            with zipfile.ZipFile(str(archive_path)) as archive:
                member = archive.getinfo(member_name)
                file_type = (member.external_attr >> 16) & 0o170000
                if member.is_dir() or file_type == stat.S_IFLNK:
                    raise RuntimeError(
                        "Node.js archive member {!r} is not a regular file".format(
                            member_name
                        )
                    )
                with archive.open(member) as extracted, open(temporary, "wb") as output:
                    shutil.copyfileobj(extracted, output)
        os.replace(str(temporary), str(destination))
    finally:
        temporary.unlink(missing_ok=True)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as contents:
        for chunk in iter(lambda: contents.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def required_string(value: Any, key: str) -> str:
    if (
        not isinstance(value, dict)
        or not isinstance(value.get(key), str)
        or not value[key]
    ):
        raise RuntimeError("Node.js lock is missing {!r}".format(key))
    return value[key]


def required_integer(value: Any, key: str) -> int:
    if (
        not isinstance(value, dict)
        or not isinstance(value.get(key), int)
        or value[key] <= 0
    ):
        raise RuntimeError("Node.js lock has invalid {!r}".format(key))
    return value[key]
