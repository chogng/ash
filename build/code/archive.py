#!/usr/bin/env python3
"""Create a deterministic managed Ash Code archive and SHA-256 sidecar."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import sys
import tarfile
import zipfile
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT))

from build.lib.targets import target_spec  # noqa: E402
from build.lib.archive import open_tar_gz  # noqa: E402
from build.package.layout import require_verified_system_signing  # noqa: E402
from build.package.layout import validate_package_directory  # noqa: E402


def create_archive(package: Path, output: Path) -> Path:
    package = package.expanduser().resolve()
    output = output.expanduser().resolve()
    if output.exists() or output.with_suffix(output.suffix + ".sha256").exists():
        raise RuntimeError(
            f"Refusing to replace an existing release artifact: {output}"
        )
    metadata = json.loads((package / "ash-package.json").read_text(encoding="utf-8"))
    target = metadata.get("target")
    components = metadata.get("components")
    if not isinstance(target, str):
        raise RuntimeError("Ash Code release package identity is invalid")
    spec = target_spec(target)
    suffix = ".zip" if spec.operating_system.value == "darwin" else ".tar.gz"
    expected_name = f"ash-code-{target}{suffix}"
    if (
        metadata.get("layoutVersion") != 2
        or not isinstance(components, dict)
        or "cli" not in components
        or output.name != expected_name
    ):
        raise RuntimeError("Ash Code release package identity is invalid")
    validate_package_directory(package, spec)
    require_verified_system_signing(package, spec)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.{os.getpid()}.part")
    try:
        if suffix == ".zip":
            create_zip(package, temporary)
        else:
            create_tar_gz(package, temporary)
        temporary.replace(output)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    digest = sha256(output)
    checksum = output.with_suffix(output.suffix + ".sha256")
    checksum.write_text(f"{digest}  {output.name}\n", encoding="ascii")
    return checksum


def create_tar_gz(package: Path, output: Path) -> None:
    with output.open("xb") as raw:
        with open_tar_gz(raw, format=tarfile.PAX_FORMAT) as archive:
            for path in package_paths(package):
                relative = path.relative_to(package).as_posix()
                archive.add(
                    path,
                    arcname=relative,
                    recursive=False,
                    filter=normalized_tar_info,
                )


def create_zip(package: Path, output: Path) -> None:
    with zipfile.ZipFile(
        output,
        mode="x",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=9,
    ) as archive:
        for path in package_paths(package):
            relative = path.relative_to(package).as_posix()
            directory = path.is_dir()
            info = zipfile.ZipInfo(relative + ("/" if directory else ""))
            info.date_time = (1980, 1, 1, 0, 0, 0)
            info.create_system = 3
            mode = (
                0o40755
                if directory
                else 0o100755
                if path.stat().st_mode & stat.S_IXUSR
                else 0o100644
            )
            info.external_attr = mode << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, b"" if directory else path.read_bytes())


def package_paths(package: Path) -> list[Path]:
    paths: list[Path] = []
    for root, directories, files in os.walk(package):
        root_path = Path(root)
        directories.sort()
        files.sort()
        for name in directories:
            path = root_path / name
            if path.is_symlink():
                raise RuntimeError(f"Package contains a symbolic path: {path}")
            paths.append(path)
        for name in files:
            path = root_path / name
            if path.is_symlink() or not path.is_file():
                raise RuntimeError(f"Package contains an unsupported path: {path}")
            paths.append(path)
    return sorted(paths, key=lambda path: path.relative_to(package).as_posix())


def normalized_tar_info(info: tarfile.TarInfo) -> tarfile.TarInfo:
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mtime = 0
    if info.isdir():
        info.mode = 0o755
    elif info.isfile():
        info.mode = 0o755 if info.mode & stat.S_IXUSR else 0o644
    else:
        raise RuntimeError(f"Unsupported archive entry: {info.name}")
    return info


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(64 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--package-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    checksum = create_archive(arguments.package_dir, arguments.output)
    print(f"Built Ash Code archive at {arguments.output.resolve()}")
    print(f"Built checksum at {checksum}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
