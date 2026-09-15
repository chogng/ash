"""Fetch and verify the pinned ripgrep executable used by Ash packages."""

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
        archive_path.unlink(missing_ok=True)
        download_and_verify(artifact, archive_path)

    executable = artifact_cache / spec.ripgrep_name
    extract_executable(archive_path, artifact, executable)
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


def archive_is_valid(path: Path, artifact: LockedArtifact) -> bool:
    if not path.is_file():
        return False
    try:
        verify_archive(path, artifact)
    except RuntimeError:
        return False
    return True


def download_and_verify(artifact: LockedArtifact, destination: Path) -> None:
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


def verify_archive(path: Path, artifact: LockedArtifact) -> None:
    actual_size = path.stat().st_size
    if actual_size != artifact.size:
        raise RuntimeError(
            "ripgrep archive {} has size {}, expected {}".format(
                path, actual_size, artifact.size
            )
        )
    actual_digest = sha256(path)
    if actual_digest != artifact.sha256:
        raise RuntimeError(
            "ripgrep archive {} has SHA-256 {}, expected {}".format(
                path, actual_digest, artifact.sha256
            )
        )


def extract_executable(
    archive_path: Path, artifact: LockedArtifact, destination: Path
) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + ".partial")
    temporary.unlink(missing_ok=True)
    try:
        if artifact.archive_format == "tar.gz":
            extract_tar_member(archive_path, artifact.executable_member, temporary)
        elif artifact.archive_format == "zip":
            extract_zip_member(archive_path, artifact.executable_member, temporary)
        else:
            raise RuntimeError(
                "Unsupported ripgrep archive format {!r}".format(
                    artifact.archive_format
                )
            )
        os.replace(str(temporary), str(destination))
    finally:
        temporary.unlink(missing_ok=True)


def extract_tar_member(archive_path: Path, member_name: str, destination: Path) -> None:
    with tarfile.open(str(archive_path), "r:gz") as archive:
        try:
            member = archive.getmember(member_name)
        except KeyError as error:
            raise RuntimeError(
                "ripgrep archive {} is missing {!r}".format(archive_path, member_name)
            ) from error
        if not member.isfile():
            raise RuntimeError(
                "ripgrep archive member {!r} is not a regular file".format(member_name)
            )
        extracted = archive.extractfile(member)
        if extracted is None:
            raise RuntimeError(
                "Could not read ripgrep archive member {!r}".format(member_name)
            )
        with extracted, open(destination, "wb") as output:
            shutil.copyfileobj(extracted, output)


def extract_zip_member(archive_path: Path, member_name: str, destination: Path) -> None:
    with zipfile.ZipFile(str(archive_path)) as archive:
        try:
            member = archive.getinfo(member_name)
        except KeyError as error:
            raise RuntimeError(
                "ripgrep archive {} is missing {!r}".format(archive_path, member_name)
            ) from error
        file_type = (member.external_attr >> 16) & 0o170000
        if member.is_dir() or file_type == stat.S_IFLNK:
            raise RuntimeError(
                "ripgrep archive member {!r} is not a regular file".format(member_name)
            )
        with archive.open(member) as extracted, open(destination, "wb") as output:
            shutil.copyfileobj(extracted, output)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as contents:
        for chunk in iter(lambda: contents.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def required_string(value: Any, key: str) -> str:
    if not isinstance(value, dict) or not isinstance(value.get(key), str):
        raise RuntimeError("ripgrep lock field {!r} must be a string".format(key))
    return value[key]


def required_integer(value: Any, key: str) -> int:
    if not isinstance(value, dict) or not isinstance(value.get(key), int):
        raise RuntimeError("ripgrep lock field {!r} must be an integer".format(key))
    return value[key]
