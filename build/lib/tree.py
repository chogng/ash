"""Copy unlinked resource trees for the shared package assembler."""

import shutil
import stat
from pathlib import Path


def copy_regular_tree(
    source: Path, destination: Path, kind: str, *, excluded_names: tuple[str, ...] = ()
) -> None:
    metadata = source.lstat()
    if not stat.S_ISDIR(metadata.st_mode):
        raise RuntimeError(f"Built-in {kind} source is not a real directory: {source}")
    destination.mkdir()
    for entry in source.iterdir():
        if entry.name in excluded_names:
            continue
        target = destination / entry.name
        metadata = entry.lstat()
        if stat.S_ISDIR(metadata.st_mode):
            copy_regular_tree(entry, target, kind, excluded_names=excluded_names)
        elif stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1:
            shutil.copyfile(entry, target)
        else:
            raise RuntimeError(
                f"Built-in {kind} asset is not a regular unlinked file: {entry}"
            )
