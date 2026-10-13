"""Repository-owned builtin extension selection, staging and validation."""

import json
import re
import stat
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
