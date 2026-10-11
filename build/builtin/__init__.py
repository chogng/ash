"""Repository-owned builtin extension selection, staging and validation."""

import json
import stat
from pathlib import Path

from build.lib.tree import copy_regular_tree


def copy_builtin_extensions(source_root: Path, destination: Path) -> None:
    source = source_root / "extensions"
    if not stat.S_ISDIR(source.lstat().st_mode):
        raise RuntimeError(
            f"Built-in extension source is not a real directory: {source}"
        )
    entries = [
        entry
        for entry in source.iterdir()
        if entry.name not in ("README.md", "BUILD.bazel")
    ]
    if not entries:
        raise RuntimeError("Built-in extension source is empty")
    destination.mkdir(parents=True)
    for entry in entries:
        if not stat.S_ISDIR(entry.lstat().st_mode):
            raise RuntimeError(f"Invalid built-in extension package: {entry.name}")
        manifest = entry / "package.json"
        if not stat.S_ISREG(manifest.lstat().st_mode):
            raise RuntimeError(
                f"Built-in extension package.json is not a regular file: {entry.name}"
            )
        # Browser libraries are compiled into renderer assets, not backend package dependencies.
        copy_regular_tree(
            entry,
            destination / entry.name,
            "extension package",
            excluded_names=(
                "node_modules",
                "Cargo.toml",
                "Cargo.lock",
                "BUILD.bazel",
                "tests",
                "src",
            )
            if json.loads(manifest.read_text(encoding="utf-8"))
            .get("ashRuntime", {})
            .get("kind")
            == "rust"
            else ("node_modules",),
        )


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
