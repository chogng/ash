"""Publish immutable executable generations and retain them through process leases."""

import hashlib
import json
import os
import re
import shutil
import time
import uuid
from contextlib import ExitStack, contextmanager
from pathlib import Path

from build.download.artifacts import sha256
from build.lib.file_lock import exclusive_lock as _exclusive_lock
from build.lib.file_lock import shared_lock


@contextmanager
def frozen_binary(binary: Path, directory: Path):
    """Pin one immutable executable across early loading and generation publication.

    The private hard link protects its object from collection without linking Cargo's
    mutable output. Publication reuses the object, so Windows loads the same file.
    """
    if os.name == "nt":
        directory = Path("\\\\?\\" + str(directory.resolve()).removeprefix("\\\\?\\"))
    directory.mkdir(parents=True, exist_ok=True)
    digest = sha256(binary)
    pin = directory / f".loading-{uuid.uuid4()}"
    try:
        with ExitStack() as lifetime:
            with _exclusive_lock(directory / "publish.lock", create=True):
                objects = directory / "objects"
                objects.mkdir(exist_ok=True)
                immutable = objects / digest
                if not immutable.exists():
                    temporary = objects / f".{uuid.uuid4()}.tmp"
                    try:
                        shutil.copy2(binary, temporary)
                        temporary.replace(immutable)
                    finally:
                        temporary.unlink(missing_ok=True)
                pin.mkdir()
                lifetime.enter_context(shared_lock(pin / ".lease", create=True))
                frozen = pin / binary.name
                os.link(immutable, frozen)
            yield frozen
    finally:
        with _exclusive_lock(directory / "publish.lock", create=True):
            if pin.exists():
                shutil.rmtree(pin)


def _cleanup_generations(directory: Path, current: str) -> None:
    # A killed builder cannot run its context cleanup. Its OS lease is released,
    # so the next serialized publisher can reclaim the abandoned pin and object.
    for pin in directory.glob(".loading-*"):
        if re.fullmatch(r"\.loading-[a-f0-9-]{36}", pin.name) is None:
            continue
        try:
            if not (pin / ".lease").exists():
                shutil.rmtree(pin)
            else:
                with _exclusive_lock(pin / ".lease", blocking=False) as acquired:
                    if acquired:
                        shutil.rmtree(pin)
        except (FileNotFoundError, PermissionError):
            # A terminating Windows version probe may still have the image open.
            # Retain that pin until a later publication can remove it.
            continue
    for runtime in (directory / "generations").iterdir():
        if (
            runtime.name == current
            or re.fullmatch(r"[a-f0-9]{64}", runtime.name) is None
        ):
            continue
        with _exclusive_lock(runtime / ".lease", blocking=False) as acquired:
            if acquired:
                shutil.rmtree(runtime)
    # Every retained runtime owns a hard link. Count actual links, including leased
    # generations, instead of relying on the selected generation's digest manifest.
    for immutable in (directory / "objects").iterdir():
        if (
            re.fullmatch(r"[a-f0-9]{64}", immutable.name)
            and immutable.stat().st_nlink == 1
        ):
            immutable.unlink()


def publish_generation(
    package: Path,
    binaries: dict[str, Path],
    directory: Path,
    *,
    symbol_directories: dict[str, Path] | None = None,
) -> tuple[bool, str]:
    # Windows link and directory APIs need extended paths for packaged resource names.
    if os.name == "nt":
        package = Path("\\\\?\\" + str(package.resolve()).removeprefix("\\\\?\\"))
        directory = Path("\\\\?\\" + str(directory.resolve()).removeprefix("\\\\?\\"))
    directory.mkdir(parents=True, exist_ok=True)
    # Publication and collection must serialize: a concurrent publisher may already
    # have linked its objects but not yet committed current.json.
    with _exclusive_lock(directory / "publish.lock", create=True):
        result = _publish_generation(package, binaries, directory, symbol_directories)
        _cleanup_generations(directory, result[1])
        return result


def _publish_generation(
    package: Path,
    binaries: dict[str, Path],
    directory: Path,
    symbol_directories: dict[str, Path] | None,
) -> tuple[bool, str]:
    # Cargo may rewrite its outputs on the next build. Freeze only changed binary contents;
    # generations share executable objects through hard links. Declarative resource readers
    # require single-link files, so each generation must own copies of ash-resources.
    files = {
        f"bin/{path.name}": path
        for path in (package / "bin").iterdir()
        if path.is_file()
    }
    bubblewrap = package / "ash-resources/bwrap"
    if bubblewrap.is_file():
        files["ash-resources/bwrap"] = bubblewrap
    files.update(
        {
            "ash-resources/bwrap" if name == "bwrap" else f"bin/{path.name}": path
            for name, path in binaries.items()
        }
    )
    digests = {name: sha256(path) for name, path in sorted(files.items())}
    contents = {"version": 1, "resources": str(package.resolve()), "binaries": digests}
    copied_directories = {"ash-resources": package / "ash-resources"}
    if symbol_directories:
        # Symbols must travel with the exact executable. Hash their contents too,
        # so a later compiler output cannot mutate or reuse an older generation.
        contents["symbols"] = {
            f"bin/{name}/{path.relative_to(source).as_posix()}": sha256(path)
            for name, source in sorted(symbol_directories.items())
            for path in sorted(source.rglob("*"))
            if path.is_file()
        }
        copied_directories.update(
            {f"bin/{name}": source for name, source in symbol_directories.items()}
        )
    identity = json.dumps(contents, sort_keys=True)
    return _publish_files(
        files,
        digests,
        identity,
        copied_directories,
        {"ash-path": package / "ash-path"},
        directory,
    )


@contextmanager
def leased_binary_generation(binaries: dict[str, Path], directory: Path):
    """Publish Code's executables and acquire its launch lease before collection can run."""
    directory.mkdir(parents=True, exist_ok=True)
    files = {f"bin/{path.name}": path for path in binaries.values()}
    digests = {name: sha256(path) for name, path in sorted(files.items())}
    identity = json.dumps({"version": 1, "binaries": digests}, sort_keys=True)
    with ExitStack() as lifetime:
        with _exclusive_lock(directory / "publish.lock", create=True):
            _, generation = _publish_files(files, digests, identity, {}, {}, directory)
            runtime = directory / "generations" / generation
            # The publication lock fences concurrent collectors until the shared lease
            # is held. The runner retains it through child startup and process exit.
            lifetime.enter_context(shared_lock(runtime / ".lease"))
            _cleanup_generations(directory, generation)
        yield {name: runtime / "bin" / path.name for name, path in binaries.items()}


def _publish_files(
    files: dict[str, Path],
    digests: dict[str, str],
    identity: str,
    copied_directories: dict[str, Path],
    linked_directories: dict[str, Path],
    directory: Path,
) -> tuple[bool, str]:
    generation = hashlib.sha256(identity.encode()).hexdigest()
    contents = json.dumps({"version": 3, "runtime": f"generations/{generation}"}) + "\n"
    pointer = directory / "current.json"
    if pointer.is_file() and pointer.read_text(encoding="utf-8") == contents:
        return False, generation
    runtime = directory / "generations" / generation
    if not runtime.exists():
        staging = directory / f".staging-{uuid.uuid4()}"
        try:
            (staging / "bin").mkdir(parents=True)
            objects = directory / "objects"
            objects.mkdir(exist_ok=True)
            for name, source in linked_directories.items():
                shutil.copytree(source, staging / name, copy_function=os.link)
            for name, source in copied_directories.items():
                shutil.copytree(source, staging / name)
            for name, source in files.items():
                immutable = objects / digests[name]
                if not immutable.exists():
                    temporary = objects / f".{uuid.uuid4()}.tmp"
                    try:
                        shutil.copy2(source, temporary)
                        temporary.replace(immutable)
                    finally:
                        temporary.unlink(missing_ok=True)
                destination = staging / name
                destination.unlink(missing_ok=True)
                os.link(immutable, destination)
            (staging / "ash-development.json").write_text(
                identity + "\n", encoding="utf-8"
            )
            (staging / ".lease").touch()
            runtime.parent.mkdir(exist_ok=True)
            _rename_generation(staging, runtime)
        finally:
            if staging.exists():
                shutil.rmtree(staging)
    next_pointer = directory / f".current.{uuid.uuid4()}.tmp"
    try:
        next_pointer.write_text(contents, encoding="utf-8")
        next_pointer.replace(pointer)
    finally:
        next_pointer.unlink(missing_ok=True)
    return True, generation


def _rename_generation(staging: Path, runtime: Path) -> None:
    # Windows scanners can briefly hold new resource files without delete sharing.
    # Keep the old pointer selected until the complete directory can be renamed.
    delays = (0.01, 0.02, 0.04, 0.08, 0.16, 0.25)
    for attempt in range(len(delays) + 1):
        try:
            staging.rename(runtime)
            return
        except OSError as error:
            if getattr(error, "winerror", None) not in {5, 32, 33} or attempt == len(
                delays
            ):
                raise
            time.sleep(delays[attempt])
