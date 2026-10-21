"""Pinned standalone DAP runtime; no VSIX or extension-host compatibility layer."""

from dataclasses import dataclass
from pathlib import Path
import json
import tarfile
import shutil

from build.download.artifacts import (
    archive_is_valid,
    download_and_verify,
    extract_member,
)

_LOCK = json.loads(
    (
        Path(__file__).resolve().parents[2] / "extensions/debug-javascript/runtime.json"
    ).read_text(encoding="utf-8")
)
VERSION = _LOCK["version"]
SHA256 = _LOCK["sha256"]


@dataclass(frozen=True)
class Artifact:
    size: int = _LOCK["size"]
    sha256: str = SHA256
    url: str = _LOCK["url"]


def copy_runtime(repository: Path, destination: Path) -> None:
    artifact = Artifact()
    archive = repository / ".build/downloads/js-debug" / VERSION / "js-debug.tar.gz"
    if not archive_is_valid(archive, artifact):
        download_and_verify(artifact, archive)
    # Each file passes the shared regular-member decoder, including path/link checks.
    with tarfile.open(archive, "r:gz") as source:
        members = source.getmembers()
        if (
            len(members) > 4096
            or sum(member.size for member in members) > 64 * 1024 * 1024
        ):
            raise RuntimeError("JavaScript debugger archive exceeds its package budget")
        seen = set()
        for member in members:
            path = Path(member.name)
            if (
                path.is_absolute()
                or ".." in path.parts
                or not path.parts
                or path.parts[0] != "js-debug"
                or member.issym()
                or member.islnk()
            ):
                raise RuntimeError("Invalid JavaScript debugger archive member")
            if member.isdir():
                continue
            relative = path.relative_to("js-debug")
            if not member.isfile() or relative in seen:
                raise RuntimeError("Invalid or duplicate JavaScript debugger member")
            seen.add(relative)
            extract_member(archive, "tar.gz", member.name, destination / relative)
            (destination / relative).chmod(0o644)
    if (
        not (destination / "src/dapDebugServer.js").is_file()
        or not (destination / "LICENSE").is_file()
    ):
        raise RuntimeError("Missing standalone JavaScript debug server")

    bootstrap = destination.parent / "src"
    bootstrap.mkdir(parents=True, exist_ok=True)
    for name in ("auto-attach.cjs", "adapter-runtime.cjs"):
        shutil.copyfile(
            repository / "extensions/debug-javascript/src" / name, bootstrap / name
        )
