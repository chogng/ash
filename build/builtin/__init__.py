"""Repository-owned builtin extension selection, staging and validation."""

import gzip
import json
import os
import re
import stat
import struct
from pathlib import Path

from build.lib.tree import copy_regular_tree


def copy_builtin_extensions(source_root: Path, destination: Path) -> None:
    prepared = source_root / ".build/builtin"
    pointer = prepared / "current.json"
    metadata = pointer.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 1024 * 1024:
        raise RuntimeError("Invalid prepared built-in extension publication")
    publication = json.loads(pointer.read_text(encoding="utf-8"))
    if (
        not isinstance(publication, dict)
        or set(publication) != {"schemaVersion", "builtIn", "user", "packageNames"}
        or type(publication["schemaVersion"]) is not int
        or publication["schemaVersion"] != 1
        or not isinstance(publication["builtIn"], list)
        or not publication["builtIn"]
        or len(publication["builtIn"]) > 4096
        or not isinstance(publication["packageNames"], dict)
    ):
        raise RuntimeError("Incompatible prepared built-in extension publication")
    destination.mkdir(parents=True)
    names = set()
    for snapshot in publication["builtIn"]:
        if (
            not isinstance(snapshot, str)
            or re.fullmatch(r"[a-f0-9]{64}(?:-[a-f0-9]{32})?", snapshot) is None
        ):
            raise RuntimeError("Invalid prepared extension package reference")
        package = prepared / "packages" / snapshot
        manifest = package / "package.json"
        if not stat.S_ISREG(manifest.lstat().st_mode):
            raise RuntimeError("Prepared extension manifest is not a regular file")
        name = publication["packageNames"].get(snapshot)
        if (
            not isinstance(name, str)
            or re.fullmatch(r"[A-Za-z0-9_-]+", name) is None
            or name in names
        ):
            raise RuntimeError("Invalid or duplicate built-in package directory name")
        names.add(name)
        copy_regular_tree(package, destination / name, "prepared extension package")


def validate_builtin_extensions(extensions_directory: Path) -> None:
    if extensions_directory.is_symlink() or not extensions_directory.is_dir():
        raise RuntimeError("Package is missing built-in extensions")
    extension_directories = sorted(
        extensions_directory.iterdir(), key=lambda path: path.name
    )
    if not extension_directories:
        raise RuntimeError("Package contains no built-in extensions")
    for extension_directory in extension_directories:
        if (
            extension_directory.is_symlink()
            or not extension_directory.is_dir()
            or not (extension_directory / "package.json").is_file()
        ):
            raise RuntimeError(
                "Package contains an invalid built-in extension: {}".format(
                    extension_directory
                )
            )


def write_builtin_extension_index(extensions: Path, output: Path) -> None:
    """Freeze resources for built-ins that the catalog serves as declarations."""
    validate_builtin_extensions(extensions)
    packages = sorted(
        (path for path in extensions.iterdir() if _is_declarative(path)),
        key=lambda path: path.name,
    )
    if not packages:
        return
    if len(packages) > 4096:
        raise RuntimeError("Too many built-in extensions for the package index")
    with (
        output.open("wb") as raw,
        gzip.GzipFile(
            filename="", mode="wb", compresslevel=3, fileobj=raw, mtime=0
        ) as index,
    ):

        def number(value: int) -> None:
            index.write(struct.pack(">I", value))

        def name(value: str) -> None:
            encoded = value.encode("utf-8")
            if not 0 < len(encoded) <= 1024 or any(
                segment in ("", ".", "..") or any(char in segment for char in "\\:\0")
                for segment in value.split("/")
            ):
                raise RuntimeError("Invalid path in the built-in extension index")
            number(len(encoded))
            index.write(encoded)

        index.write(b"ASH-EXTENSIONS\0\x01")
        number(len(packages))
        total_bytes = 0
        for package in packages:
            if re.fullmatch(r"[A-Za-z0-9_-]+", package.name) is None:
                raise RuntimeError("Invalid built-in package directory name")
            files = []
            entry_count = 0
            for directory, subdirs, entries in os.walk(
                package, onerror=_raise_walk_error
            ):
                base = Path(directory)
                entry_count += len(subdirs) + len(entries)
                if entry_count > 8192:
                    raise RuntimeError("Too many entries in a built-in extension")
                for subdir in subdirs:
                    if not stat.S_ISDIR((base / subdir).lstat().st_mode):
                        raise RuntimeError("Invalid directory in a built-in extension")
                files.extend(base / entry for entry in entries)
            files.sort(key=lambda path: path.relative_to(package).as_posix())
            if not 0 < len(files) <= 4096:
                raise RuntimeError("Invalid built-in extension file count")
            name(package.name)
            number(len(files))
            package_bytes = 0
            for path in files:
                info = path.lstat()
                if (
                    not stat.S_ISREG(info.st_mode)
                    or info.st_nlink != 1
                    or info.st_size > 16 * 1024 * 1024
                ):
                    raise RuntimeError("Invalid file in a built-in extension")
                package_bytes += info.st_size
                total_bytes += info.st_size
                if package_bytes > 64 * 1024 * 1024 or total_bytes > 256 * 1024 * 1024:
                    raise RuntimeError(
                        "Built-in extensions exceed the catalog byte limit"
                    )
                name(path.relative_to(package).as_posix())
                number(info.st_size)
                content = path.read_bytes()
                if len(content) != info.st_size:
                    raise RuntimeError(
                        "Built-in extension changed during package assembly"
                    )
                index.write(content)
        if index.tell() > 272 * 1024 * 1024:
            raise RuntimeError("Built-in extension index exceeds its size limit")


def _raise_walk_error(error: OSError) -> None:
    raise error


def _is_declarative(package: Path) -> bool:
    try:
        manifest = json.loads((package / "package.json").read_bytes())
    except (ValueError, OSError):
        return False
    if not isinstance(manifest, dict) or any(
        key in manifest
        for key in ("main", "browser", "ashRuntime", "ashLanguageServers")
    ):
        return False
    contributions = manifest.get("contributes")
    return not isinstance(contributions, dict) or "debuggers" not in contributions
