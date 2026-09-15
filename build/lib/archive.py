"""Shared compressed tar streams for release archives."""

from __future__ import annotations

import gzip
import tarfile
from contextlib import contextmanager
from typing import BinaryIO, Iterator


@contextmanager
def open_tar_gz(fileobj: BinaryIO, *, format: int) -> Iterator[tarfile.TarFile]:
    """Balance compression time and size while keeping gzip headers reproducible."""
    with gzip.GzipFile(
        fileobj=fileobj, mode="wb", filename="", compresslevel=6, mtime=0
    ) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=format) as archive:
            yield archive
