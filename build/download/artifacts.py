"""Verified downloads and regular archive members shared by runtime builders."""

import hashlib
import os
import shutil
import stat
import tarfile
import tempfile
import zipfile
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Protocol
from urllib.request import Request, urlopen


class LockedArchive(Protocol):
    size: int | None
    sha256: str
    url: str


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


@contextmanager
def temporary_file(destination: Path) -> Iterator[Path]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(
        prefix=f".{destination.name}.", dir=destination.parent
    )
    os.close(descriptor)
    temporary = Path(name)
    try:
        yield temporary
    finally:
        temporary.unlink(missing_ok=True)


def verify_archive(path: Path, artifact: LockedArchive) -> None:
    if path.stat().st_size != artifact.size or sha256(path) != artifact.sha256:
        raise RuntimeError(f"Archive failed locked size or SHA-256 validation: {path}")


def archive_is_valid(path: Path, artifact: LockedArchive) -> bool:
    try:
        verify_archive(path, artifact)
        return True
    except (FileNotFoundError, RuntimeError):
        return False


def publish(temporary: Path, destination: Path, digest: str) -> None:
    try:
        if destination.is_file() and sha256(destination) == digest:
            return
        temporary.replace(destination)
    except PermissionError:
        # Windows rejects simultaneous replacements. Accept only an identical winner.
        if not destination.is_file() or sha256(destination) != digest:
            raise


def download_and_verify(
    artifact: LockedArchive,
    destination: Path,
    *,
    max_bytes: int | None = None,
    timeout: int = 60,
) -> None:
    limit = artifact.size if artifact.size is not None else max_bytes
    if not isinstance(limit, int) or isinstance(limit, bool) or limit <= 0:
        raise ValueError("Downloads require a positive byte limit")
    request = Request(artifact.url, headers={"User-Agent": "ash-package-builder"})
    with temporary_file(destination) as temporary:
        digest = hashlib.sha256()
        size = 0
        with (
            urlopen(request, timeout=timeout) as response,
            temporary.open("wb") as output,
        ):
            while block := response.read(1024 * 1024):
                size += len(block)
                if size > limit:
                    raise RuntimeError(
                        f"Archive exceeds locked size: {destination.name}"
                    )
                digest.update(block)
                output.write(block)
        actual_digest = digest.hexdigest()
        if (
            artifact.size is not None and size != artifact.size
        ) or actual_digest != artifact.sha256:
            raise RuntimeError(
                f"Archive failed locked size or SHA-256 validation: {destination.name}"
            )
        publish(temporary, destination, actual_digest)


def extract_member(
    archive_path: Path, archive_format: str, member_name: str, destination: Path
) -> None:
    with temporary_file(destination) as temporary:
        if archive_format in ("tar.gz", "tar.xz"):
            with tarfile.open(
                archive_path, "r:gz" if archive_format == "tar.gz" else "r:xz"
            ) as archive:
                member = archive.getmember(member_name)
                if not member.isfile():
                    raise RuntimeError(
                        f"Archive member is not a regular file: {member_name}"
                    )
                source = archive.extractfile(member)
                if source is None:
                    raise RuntimeError(f"Could not read archive member: {member_name}")
                with source, temporary.open("wb") as output:
                    shutil.copyfileobj(source, output)
        elif archive_format == "zip":
            with zipfile.ZipFile(archive_path) as archive:
                member = archive.getinfo(member_name)
                kind = stat.S_IFMT(member.external_attr >> 16)
                if member.is_dir() or kind not in (0, stat.S_IFREG):
                    raise RuntimeError(
                        f"Archive member is not a regular file: {member_name}"
                    )
                with archive.open(member) as source, temporary.open("wb") as output:
                    shutil.copyfileobj(source, output)
        else:
            raise RuntimeError(f"Unsupported archive format: {archive_format}")
        publish(temporary, destination, sha256(temporary))
