#!/usr/bin/env python3
"""Build and validate bundled Remote runtime catalogs for product hosts."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Dict, List, Sequence, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from build.lib.targets import TARGETS
from build.lib.archive import open_tar_gz

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]

CATALOG_FILE = "catalog.json"
CATALOG_FORMAT_VERSION = 1
MAX_CATALOG_BYTES = 1024 * 1024
MAX_PACKAGE_METADATA_BYTES = 64 * 1024
MAX_RUNTIME_ARCHIVE_BYTES = 1024 * 1024 * 1024
MAX_RUNTIME_UNPACKED_BYTES = 4 * MAX_RUNTIME_ARCHIVE_BYTES
VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$")
REMOTE_RUNTIME_TARGETS = frozenset(
    target for target, spec in TARGETS.items() if not spec.is_windows
)
REQUIRED_RUNTIME_FILES = {
    "ash-package.json",
    "bin/ash-app-server-daemon",
    "bin/ash-app-server",
    "bin/ash-remote-server",
    "bin/ash-exec-server",
    "ash-path/rg",
    "ash-resources/node/bin/node",
}
EXECUTABLE_RUNTIME_FILES = {
    "bin/ash-app-server-daemon",
    "bin/ash-app-server",
    "bin/ash-remote-server",
    "bin/ash-exec-server",
    "ash-path/rg",
    "ash-resources/node/bin/node",
}


@dataclass(frozen=True)
class RemoteRuntimeBundle:
    root: Path
    catalog_sha256: str


@dataclass(frozen=True)
class RuntimeArchive:
    path: Path
    version: str
    target: str
    archive_size: int
    unpacked_size: int
    sha256: str


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def build_remote_runtime_bundle(
    output: Path, package_directories: Sequence[Path]
) -> RemoteRuntimeBundle:
    output = output.expanduser().resolve()
    if output.exists():
        raise RuntimeError(
            f"refusing to replace existing Remote runtime bundle: {output}"
        )
    if not package_directories:
        raise RuntimeError("at least one canonical Ash package directory is required")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent))
    try:
        artifact_directory = staging / "artifacts"
        artifact_directory.mkdir()
        records: List[Dict[str, object]] = []
        targets = set()
        for package_directory in package_directories:
            package_directory = package_directory.expanduser()
            version, target = validate_package_directory(package_directory)
            package_directory = package_directory.resolve()
            if target in targets:
                raise RuntimeError(f"Remote runtime bundle repeats target {target}")
            targets.add(target)
            relative_archive = f"artifacts/ash-{target}.tar.gz"
            archive_path = staging / relative_archive
            unpacked_size = archive_package_directory(package_directory, archive_path)
            if archive_path.stat().st_size > MAX_RUNTIME_ARCHIVE_BYTES:
                raise RuntimeError(
                    f"Remote runtime archive exceeds {MAX_RUNTIME_ARCHIVE_BYTES} bytes"
                )
            records.append(
                {
                    "version": version,
                    "target": target,
                    "archive": relative_archive,
                    "archiveSize": archive_path.stat().st_size,
                    "unpackedSize": unpacked_size,
                    "sha256": sha256(archive_path),
                }
            )
        records.sort(key=lambda record: str(record["target"]))
        write_json(
            staging / CATALOG_FILE,
            {"formatVersion": CATALOG_FORMAT_VERSION, "artifacts": records},
        )
        validate_remote_runtime_bundle(staging)
        staging.rename(output)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return validate_remote_runtime_bundle(output)


def validate_remote_runtime_bundle(root: Path) -> RemoteRuntimeBundle:
    requested_root = root.expanduser()
    if requested_root.is_symlink() or not requested_root.is_dir():
        raise RuntimeError(
            f"Remote runtime bundle is not a real directory: {requested_root}"
        )
    root = requested_root.resolve()
    catalog = root / CATALOG_FILE
    if catalog.is_symlink() or not catalog.is_file():
        raise RuntimeError(f"Remote runtime bundle has no regular {CATALOG_FILE}")
    size = catalog.stat().st_size
    if size <= 0 or size > MAX_CATALOG_BYTES:
        raise RuntimeError("Remote runtime catalog has an invalid size")
    document = load_json(catalog)
    require_exact_keys(
        document, {"formatVersion", "artifacts"}, "Remote runtime catalog"
    )
    if document["formatVersion"] != CATALOG_FORMAT_VERSION:
        raise RuntimeError("unsupported Remote runtime catalog format version")
    records = document["artifacts"]
    if not isinstance(records, list) or not records:
        raise RuntimeError("Remote runtime catalog must contain artifacts")
    targets = set()
    referenced = {CATALOG_FILE}
    for value in records:
        if not isinstance(value, dict):
            raise RuntimeError("Remote runtime catalog artifact must be an object")
        require_exact_keys(
            value,
            {"version", "target", "archive", "archiveSize", "unpackedSize", "sha256"},
            "Remote runtime catalog artifact",
        )
        version = required_string(value, "version")
        if VERSION.fullmatch(version) is None:
            raise RuntimeError(f"invalid Remote runtime version: {version}")
        target = required_string(value, "target")
        if target not in REMOTE_RUNTIME_TARGETS:
            raise RuntimeError(f"unsupported Remote runtime target: {target}")
        if target in targets:
            raise RuntimeError(f"Remote runtime catalog repeats target {target}")
        targets.add(target)
        relative_archive = canonical_relative_path(required_string(value, "archive"))
        referenced.add(relative_archive)
        archive = root / Path(*PurePosixPath(relative_archive).parts)
        if archive.is_symlink() or not archive.is_file():
            raise RuntimeError(
                f"Remote runtime archive is not a regular file: {archive}"
            )
        expected_archive_size = positive_integer(value, "archiveSize")
        expected_unpacked_size = positive_integer(value, "unpackedSize")
        if expected_archive_size > MAX_RUNTIME_ARCHIVE_BYTES:
            raise RuntimeError(
                f"Remote runtime archive size exceeds {MAX_RUNTIME_ARCHIVE_BYTES} bytes for {target}"
            )
        if expected_unpacked_size > MAX_RUNTIME_UNPACKED_BYTES:
            raise RuntimeError(
                f"Remote runtime unpacked size exceeds {MAX_RUNTIME_UNPACKED_BYTES} bytes for {target}"
            )
        expected_sha256 = required_string(value, "sha256")
        if not is_sha256(expected_sha256):
            raise RuntimeError(f"invalid Remote runtime archive SHA-256 for {target}")
        if archive.stat().st_size != expected_archive_size:
            raise RuntimeError(f"Remote runtime archive size mismatch for {target}")
        if sha256(archive) != expected_sha256:
            raise RuntimeError(f"Remote runtime archive SHA-256 mismatch for {target}")
        inspected = inspect_runtime_archive(archive)
        if inspected.version != version or inspected.target != target:
            raise RuntimeError(f"Remote runtime archive metadata mismatch for {target}")
        if inspected.unpacked_size != expected_unpacked_size:
            raise RuntimeError(
                f"Remote runtime archive unpacked size mismatch for {target}"
            )
    for path in regular_tree_paths(root):
        if path.is_file() and path.relative_to(root).as_posix() not in referenced:
            raise RuntimeError(f"unreferenced file in Remote runtime bundle: {path}")
    return RemoteRuntimeBundle(root=root, catalog_sha256=sha256(catalog))


def validate_package_directory(package: Path) -> Tuple[str, str]:
    requested_package = package.expanduser()
    if requested_package.is_symlink() or not requested_package.is_dir():
        raise RuntimeError(
            f"Remote runtime package is not a real directory: {requested_package}"
        )
    package = requested_package.resolve()
    paths = regular_tree_paths(package)
    files = {
        path.relative_to(package).as_posix(): path for path in paths if path.is_file()
    }
    missing = REQUIRED_RUNTIME_FILES.difference(files)
    if missing:
        raise RuntimeError(f"Remote runtime package is missing {sorted(missing)}")
    metadata = load_json(files["ash-package.json"])
    version, target = validate_package_metadata(metadata)
    for relative in EXECUTABLE_RUNTIME_FILES:
        if os.name != "nt" and files[relative].stat().st_mode & 0o111 == 0:
            raise RuntimeError(
                f"Remote runtime executable has no execute bit: {relative}"
            )
    return version, target


def archive_package_directory(package: Path, output: Path) -> int:
    paths = regular_tree_paths(package)
    unpacked_size = sum(path.stat().st_size for path in paths if path.is_file())
    if unpacked_size > MAX_RUNTIME_UNPACKED_BYTES:
        raise RuntimeError(
            f"Remote runtime package exceeds {MAX_RUNTIME_UNPACKED_BYTES} unpacked bytes"
        )
    with output.open("wb") as raw:
        with open_tar_gz(raw, format=tarfile.GNU_FORMAT) as archive:
            for path in paths:
                relative = path.relative_to(package).as_posix()
                info = tarfile.TarInfo(relative)
                info.uid = 0
                info.gid = 0
                info.uname = ""
                info.gname = ""
                info.mtime = 0
                if path.is_dir():
                    info.type = tarfile.DIRTYPE
                    info.mode = 0o755
                    archive.addfile(info)
                else:
                    info.type = tarfile.REGTYPE
                    info.mode = 0o755 if relative in EXECUTABLE_RUNTIME_FILES else 0o644
                    info.size = path.stat().st_size
                    with path.open("rb") as source:
                        archive.addfile(info, source)
    return unpacked_size


def inspect_runtime_archive(path: Path) -> RuntimeArchive:
    names = set()
    unpacked_size = 0
    metadata = None
    try:
        with tarfile.open(path, "r:gz") as archive:
            for member in archive:
                name = canonical_relative_path(member.name)
                if name in names:
                    raise RuntimeError(f"Remote runtime archive repeats path {name}")
                names.add(name)
                if not (member.isfile() or member.isdir()):
                    raise RuntimeError(
                        f"Remote runtime archive contains linked or special entry {name}"
                    )
                if member.isfile():
                    unpacked_size += member.size
                    if unpacked_size > MAX_RUNTIME_UNPACKED_BYTES:
                        raise RuntimeError(
                            f"Remote runtime archive exceeds {MAX_RUNTIME_UNPACKED_BYTES} unpacked bytes"
                        )
                if name in EXECUTABLE_RUNTIME_FILES and member.mode & 0o111 == 0:
                    raise RuntimeError(
                        f"Remote runtime archive executable has no execute bit: {name}"
                    )
                if name == "ash-package.json":
                    if not member.isfile() or member.size > MAX_PACKAGE_METADATA_BYTES:
                        raise RuntimeError(
                            "Remote runtime package metadata is not bounded"
                        )
                    source = archive.extractfile(member)
                    if source is None:
                        raise RuntimeError(
                            "Remote runtime package metadata is unreadable"
                        )
                    metadata = json.loads(source.read())
    except (tarfile.TarError, json.JSONDecodeError, OSError) as error:
        raise RuntimeError(
            f"could not inspect Remote runtime archive {path}: {error}"
        ) from error
    missing = REQUIRED_RUNTIME_FILES.difference(names)
    if missing:
        raise RuntimeError(f"Remote runtime archive is missing {sorted(missing)}")
    if not isinstance(metadata, dict):
        raise RuntimeError("Remote runtime archive has invalid package metadata")
    version, target = validate_package_metadata(metadata)
    return RuntimeArchive(
        path=path,
        version=version,
        target=target,
        archive_size=path.stat().st_size,
        unpacked_size=unpacked_size,
        sha256=sha256(path),
    )


def validate_package_metadata(metadata: Dict[str, object]) -> Tuple[str, str]:
    version = required_string(metadata, "version")
    target = required_string(metadata, "target")
    expected = {
        "layoutVersion": 2,
        "entrypoint": "bin/ash-app-server",
        "pathDir": "ash-path",
        "resourcesDir": "ash-resources",
        "javascriptRuntime": {"kind": "packagedNode"},
    }
    for key, value in expected.items():
        if metadata.get(key) != value:
            raise RuntimeError(f"Remote runtime package metadata {key} is invalid")
    if VERSION.fullmatch(version) is None:
        raise RuntimeError(f"invalid Remote runtime package version: {version}")
    if target not in REMOTE_RUNTIME_TARGETS:
        raise RuntimeError(f"unsupported Remote runtime package target: {target}")
    return version, target


def regular_tree_paths(root: Path) -> List[Path]:
    paths = []
    for current, directories, files in os.walk(root, followlinks=False):
        current_path = Path(current)
        directories.sort()
        files.sort()
        for name in directories + files:
            path = current_path / name
            if path.is_symlink():
                raise RuntimeError(
                    f"linked path is not allowed in Remote runtime content: {path}"
                )
            mode = path.stat().st_mode
            if not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
                raise RuntimeError(
                    f"special path is not allowed in Remote runtime content: {path}"
                )
            paths.append(path)
    return sorted(paths, key=lambda path: path.relative_to(root).as_posix())


def canonical_relative_path(value: str) -> str:
    path = PurePosixPath(value)
    if (
        not value
        or value.startswith("/")
        or value.endswith("/")
        or "\\" in value
        or ":" in value
        or "\x00" in value
        or "\n" in value
        or "\r" in value
        or path.as_posix() != value
        or any(part in ("", ".", "..") for part in path.parts)
    ):
        raise RuntimeError(f"path is not canonical and relative: {value!r}")
    return value


def load_json(path: Path) -> Dict[str, object]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"could not read JSON file {path}: {error}") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"expected a JSON object in {path}")
    return value


def write_json(path: Path, value: Dict[str, object]) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def required_string(value: Dict[str, object], key: str) -> str:
    item = value.get(key)
    if not isinstance(item, str) or not item:
        raise RuntimeError(f"{key} must be a non-empty string")
    return item


def positive_integer(value: Dict[str, object], key: str) -> int:
    item = value.get(key)
    if isinstance(item, bool) or not isinstance(item, int) or item <= 0:
        raise RuntimeError(f"{key} must be a positive integer")
    return item


def require_exact_keys(value: Dict[str, object], keys: set[str], label: str) -> None:
    if set(value) != keys:
        raise RuntimeError(f"{label} fields must be exactly {sorted(keys)}")


def is_sha256(value: str) -> bool:
    return len(value) == 64 and all(
        character in "0123456789abcdef" for character in value
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle-dir", type=Path, required=True)
    parser.add_argument("--package-dir", type=Path, action="append", required=True)
    args = parser.parse_args()
    bundle = build_remote_runtime_bundle(args.bundle_dir, args.package_dir)
    print(f"Built Remote runtime bundle at {bundle.root}")
    print(f"Catalog SHA-256: {bundle.catalog_sha256}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
