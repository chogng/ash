"""Prepare checksum-locked grammar libraries and WASM without source compilation."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from build.download.artifacts import archive_is_valid, download_and_verify, sha256
from build.lib.file_lock import exclusive_lock
from build.lib.targets import TARGETS


ROOT = Path(__file__).resolve().parents[2]
LOCK = ROOT / "third_party/ash-grammars/runtime-lock.json"
CACHE = ROOT / "third_party/.cache/ash-grammars"
REPOSITORY = "https://github.com/chogng/ash-grammars"


@dataclass(frozen=True)
class _GrammarArchive:
    name: str
    size: int
    sha256: str
    url: str


def _grammar_lock() -> dict:
    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    if (
        lock.get("schemaVersion") != 1
        or not re.fullmatch(r"\d+\.\d+\.\d+", lock.get("version", ""))
        or not re.fullmatch(r"[a-f0-9]{64}", lock.get("sourceLockSha256", ""))
        or lock.get("targets", {}).keys() != TARGETS.keys()
    ):
        raise RuntimeError(f"Invalid grammar release lock: {LOCK}")
    return lock


def _archive(lock: dict, target: str) -> _GrammarArchive:
    entry = lock["wasm"] if target == "wasm" else lock["targets"][target]
    name = f"ash-grammars-v{lock['version']}-{target}.tar.gz"
    if (
        entry.get("name") != name
        or type(entry.get("size")) is not int
        or not 0 < entry["size"] <= 64 * 1024 * 1024
        or not re.fullmatch(r"[a-f0-9]{64}", entry.get("sha256", ""))
    ):
        raise RuntimeError(f"Invalid grammar archive for {target}")
    return _GrammarArchive(
        name,
        entry["size"],
        entry["sha256"],
        f"{REPOSITORY}/releases/download/v{lock['version']}/{name}",
    )


def _unpack(archive: Path, destination: Path) -> None:
    seen: set[str] = set()
    total = 0
    with tarfile.open(archive, "r:gz") as contents:
        for member in contents:
            path = PurePosixPath(member.name)
            total += member.size
            if (
                not member.isfile()
                or path.is_absolute()
                or ".." in path.parts
                or "\\" in member.name
                or ":" in member.name
                or member.name in seen
                or total > 512 * 1024 * 1024
            ):
                raise RuntimeError(f"Unsafe grammar archive member: {member.name}")
            seen.add(member.name)
            output = destination.joinpath(*path.parts)
            output.parent.mkdir(parents=True, exist_ok=True)
            with contents.extractfile(member) as source, output.open("wb") as sink:
                shutil.copyfileobj(source, sink)


def _validate(directory: Path, lock: dict, target: str, archive: Path) -> None:
    metadata = "grammars.json" if target == "wasm" else "lib/bundle.json"
    # The extracted manifest is not a trust root. Bind it back to the locked
    # archive before using its individual file digests on subsequent builds.
    with tarfile.open(archive, "r:gz") as contents:
        with contents.extractfile(metadata) as source:
            expected_metadata = source.read()
    if (directory / metadata).read_bytes() != expected_metadata:
        raise RuntimeError(f"Grammar metadata checksum mismatch: {directory}")
    expected = {
        grammar["name"]
        for manifest in (ROOT / "extensions").glob("*/tree-sitter/grammars.json")
        for grammar in json.loads(manifest.read_text(encoding="utf-8"))
    }
    if target == "wasm":
        modules = json.loads(expected_metadata)
        if modules.keys() != expected:
            raise RuntimeError(
                "Grammar release does not match Ash's language inventory"
            )
        for name, entry in modules.items():
            if (
                not re.fullmatch(r"[a-z][a-z0-9-]*", name)
                or entry.get("path") != f"wasm/{name}.wasm"
            ):
                raise RuntimeError("Invalid grammar module path")
            module = directory / entry["path"]
            if (
                module.is_symlink()
                or module.stat().st_size != entry["size"]
                or sha256(module) != entry["sha256"]
            ):
                raise RuntimeError(f"Grammar module checksum mismatch: {name}")
    else:
        manifest = json.loads(expected_metadata)
        library = (
            directory
            / "lib"
            / ("ash_grammars.lib" if "windows-msvc" in target else "libash_grammars.a")
        )
        if (
            manifest.get("target") != target
            or manifest.get("version") != lock["version"]
            or manifest.get("sourceLockSha256") != lock["sourceLockSha256"]
            or set(manifest.get("grammars", [])) != expected
            or library.is_symlink()
            or sha256(library) != manifest.get("sha256")
        ):
            raise RuntimeError(
                f"Grammar library identity or checksum mismatch: {target}"
            )
    if not any((directory / "licenses").glob("*.txt")):
        raise RuntimeError("Grammar archive is missing its license notices")


def _prepare_grammars(target: str, *, verify_only: bool = False) -> Path:
    lock = _grammar_lock()
    artifact = _archive(lock, target)
    parent = CACHE / lock["version"]
    parent.mkdir(parents=True, exist_ok=True)
    directory = parent / f"{target}-{artifact.sha256}"
    with exclusive_lock(parent / f".{target}.lock", create=True):
        archive = CACHE / "downloads" / artifact.name
        if not archive_is_valid(archive, artifact):
            if verify_only:
                raise RuntimeError(
                    f"Missing or invalid locked grammar archive: {archive}"
                )
            download_and_verify(artifact, archive)
        if directory.exists():
            _validate(directory, lock, target, archive)
            return directory
        if verify_only:
            raise RuntimeError(
                f"Missing prepared grammars: {directory}; run pnpm tree-sitter:prepare"
            )
        # Publish only complete validated outputs; concurrent Cargo and renderer
        # preparation share the lock, and consumers never see a partial tree.
        with tempfile.TemporaryDirectory(prefix=f".{target}-", dir=parent) as temporary:
            staging = Path(temporary) / "bundle"
            staging.mkdir()
            _unpack(archive, staging)
            _validate(staging, lock, target, archive)
            staging.rename(directory)
    return directory


def resolve_grammars_cargo_env(target: str) -> dict[str, str]:
    return {"ASH_GRAMMARS_LIB_DIR": str(_prepare_grammars(target) / "lib")}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=sorted(TARGETS))
    parser.add_argument("--wasm", action="store_true")
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    if not args.target and not args.wasm:
        parser.error("select --target or --wasm")
    for target in ([args.target] if args.target else []) + (
        ["wasm"] if args.wasm else []
    ):
        print(
            f"Prepared Ash grammars: {_prepare_grammars(target, verify_only=args.verify)}"
        )


if __name__ == "__main__":
    main()
