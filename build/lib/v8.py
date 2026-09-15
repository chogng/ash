"""Checksum-verified rusty_v8 inputs for Cargo builds."""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from .targets import TARGETS, TargetSpec
from build.download.artifacts import download_and_verify, sha256


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_LOCK = REPOSITORY_ROOT / "third_party" / "v8" / "runtime-lock.json"
DEFAULT_CACHE = REPOSITORY_ROOT / "third_party" / ".cache" / "v8"
DOWNLOAD_TIMEOUT_SECONDS = 120
MAX_ARTIFACT_BYTES = 256 * 1024 * 1024


@dataclass(frozen=True)
class LockedFile:
    name: str
    sha256: str
    url: str
    size: int | None = None


@dataclass(frozen=True)
class V8ArtifactPair:
    archive: LockedFile
    binding: LockedFile
    version: str


@dataclass(frozen=True)
class ResolvedV8ArtifactPair:
    archive: Path
    binding: Path


def load_v8_lock(path: Path = DEFAULT_LOCK) -> dict[str, V8ArtifactPair]:
    document = json.loads(path.read_text(encoding="utf-8"))
    if document.get("schemaVersion") != 1 or document.get("runtime") != "rusty-v8":
        raise RuntimeError(f"Unsupported rusty_v8 lock: {path}")

    version = required_string(document, "version", path)
    profile = required_string(document, "profile", path)
    source = document.get("source")
    if not isinstance(source, dict):
        raise RuntimeError(f"rusty_v8 lock is missing source metadata: {path}")
    repository = required_string(source, "repository", path).rstrip("/")
    release = required_string(source, "release", path)
    parsed_repository = urlsplit(repository)
    if (
        parsed_repository.scheme != "https"
        or not parsed_repository.hostname
        or parsed_repository.username
        or parsed_repository.password
        or parsed_repository.query
        or parsed_repository.fragment
    ):
        raise RuntimeError("rusty_v8 repository must be a credential-free HTTPS URL")
    if release != f"rusty-v8-v{version}":
        raise RuntimeError("rusty_v8 release tag does not match the locked version")

    artifacts = document.get("artifacts")
    if not isinstance(artifacts, dict) or artifacts.keys() != TARGETS.keys():
        missing = (
            sorted(TARGETS.keys() - artifacts.keys())
            if isinstance(artifacts, dict)
            else sorted(TARGETS)
        )
        extra = (
            sorted(artifacts.keys() - TARGETS.keys())
            if isinstance(artifacts, dict)
            else []
        )
        raise RuntimeError(
            f"rusty_v8 lock target set is incomplete (missing={missing}, extra={extra})"
        )

    base_url = f"{repository}/releases/download/{release}"
    result: dict[str, V8ArtifactPair] = {}
    for target, entry in artifacts.items():
        if not isinstance(entry, dict):
            raise RuntimeError(f"Invalid rusty_v8 artifact entry for {target}")
        archive_name = (
            f"rusty_v8_{profile}_{target}.lib.gz"
            if TARGETS[target].is_windows
            else f"librusty_v8_{profile}_{target}.a.gz"
        )
        binding_name = f"src_binding_{profile}_{target}.rs"
        result[target] = V8ArtifactPair(
            archive=locked_file(entry, "archive", archive_name, base_url, target),
            binding=locked_file(entry, "binding", binding_name, base_url, target),
            version=version,
        )
    return result


def resolve_v8_cargo_env(
    spec: TargetSpec,
    *,
    environ: Mapping[str, str] | None = None,
    lock_path: Path = DEFAULT_LOCK,
    cache_root: Path = DEFAULT_CACHE,
) -> dict[str, str]:
    environment = os.environ if environ is None else environ
    if environment.get("V8_FROM_SOURCE", "").lower() in {"1", "true", "yes"}:
        return {}

    archive_override = environment.get("RUSTY_V8_ARCHIVE")
    binding_override = environment.get("RUSTY_V8_SRC_BINDING_PATH")
    if archive_override and binding_override:
        return {}
    if archive_override or binding_override:
        raise RuntimeError(
            "RUSTY_V8_ARCHIVE and RUSTY_V8_SRC_BINDING_PATH must be set together"
        )
    if environment.get("RUSTY_V8_MIRROR"):
        return {}

    resolve_v8_artifacts(spec, lock_path=lock_path, cache_root=cache_root)
    return {"RUSTY_V8_MIRROR": str(cache_root)}


def resolve_v8_artifacts(
    spec: TargetSpec,
    *,
    lock_path: Path = DEFAULT_LOCK,
    cache_root: Path = DEFAULT_CACHE,
) -> ResolvedV8ArtifactPair:
    pair = load_v8_lock(lock_path)[spec.target]
    cache_directory = cache_root / f"v{pair.version}"
    return ResolvedV8ArtifactPair(
        archive=materialize(pair.archive, cache_directory),
        binding=materialize(pair.binding, cache_directory),
    )


def materialize(artifact: LockedFile, cache_directory: Path) -> Path:
    destination = cache_directory / artifact.name
    if has_checksum(destination, artifact.sha256):
        return destination

    download_and_verify(
        artifact,
        destination,
        max_bytes=MAX_ARTIFACT_BYTES,
        timeout=DOWNLOAD_TIMEOUT_SECONDS,
    )
    return destination


def has_checksum(path: Path, expected: str) -> bool:
    if not path.is_file():
        return False
    return sha256(path) == expected


def required_string(document: dict[object, object], key: str, path: Path) -> str:
    value = document.get(key)
    if not isinstance(value, str) or not value:
        raise RuntimeError(f"rusty_v8 lock field {key} is invalid: {path}")
    return value


def locked_file(
    entry: dict[object, object],
    kind: str,
    expected_name: str,
    base_url: str,
    target: str,
) -> LockedFile:
    value = entry.get(kind)
    if not isinstance(value, dict):
        raise RuntimeError(f"rusty_v8 {kind} is missing for {target}")
    name = value.get("name")
    digest = value.get("sha256")
    if name != expected_name:
        raise RuntimeError(f"rusty_v8 {kind} name is invalid for {target}: {name}")
    if (
        not isinstance(digest, str)
        or len(digest) != 64
        or any(character not in "0123456789abcdef" for character in digest)
    ):
        raise RuntimeError(f"rusty_v8 {kind} SHA-256 is invalid for {target}")
    return LockedFile(name=name, sha256=digest, url=f"{base_url}/{name}")
