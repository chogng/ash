"""Prepare aspdf's pinned non-V8 PDFium library for native workers and distribution."""

import json
import shutil
import tarfile
from dataclasses import dataclass
from pathlib import Path

from build.download.artifacts import archive_is_valid, download_and_verify
from build.lib.file_lock import exclusive_lock


@dataclass(frozen=True)
class PdfiumArchive:
    url: str
    size: int
    sha256: str


def prepare_pdfium(root: Path, target: str) -> Path | None:
    document = json.loads((root / "third_party/pdfium/runtime-lock.json").read_text())
    entry = document["artifacts"].get(target)
    # musl Remote/TUI distributions have no PDFium build. They must not load a glibc library.
    if entry is None:
        return None
    cache = root / "third_party/.cache/pdfium" / document["release"] / target
    archive = cache / entry["name"]
    locked = PdfiumArchive(
        f"{document['repository']}/releases/download/{document['release']}/{entry['name']}",
        entry["size"],
        entry["sha256"],
    )
    with exclusive_lock(cache / "prepare.lock", create=True):
        if not archive_is_valid(archive, locked):
            download_and_verify(locked, archive)
        library = cache / Path(entry["library"]).name
        with tarfile.open(archive) as source:
            member = source.getmember(entry["library"])
            if not member.isfile() or not 0 < member.size <= 64 * 1024 * 1024:
                raise RuntimeError("Invalid PDFium library member")
            stream = source.extractfile(member)
            if stream is None:
                raise RuntimeError("Missing PDFium library")
            data = stream.read()
            if not library.is_file() or library.read_bytes() != data:
                library.write_bytes(data)
            for member in source.getmembers():
                if member.isfile() and (
                    member.name == "LICENSE" or member.name.startswith("licenses/")
                ):
                    relative = (
                        Path("licenses/PDFium-LICENSE")
                        if member.name == "LICENSE"
                        else Path(member.name)
                    )
                    if ".." in relative.parts or member.size > 4 * 1024 * 1024:
                        raise RuntimeError("Invalid PDFium notice member")
                    destination = cache / relative
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    stream = source.extractfile(member)
                    if stream is not None:
                        destination.write_bytes(stream.read())
    return library


def copy_pdfium(root: Path, target: str, resources: Path) -> None:
    library = prepare_pdfium(root, target)
    if library is None:
        return
    destination = resources / "pdfium"
    destination.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(library, destination / library.name)
    notices = library.parent / "licenses"
    if notices.is_dir():
        shutil.copytree(notices, resources / "licenses/pdfium", dirs_exist_ok=True)
