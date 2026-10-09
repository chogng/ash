"""Explicitly trim compiler caches while protecting active builds and runs."""

from __future__ import annotations

import argparse
import os
import shutil
import time
from contextlib import ExitStack, contextmanager
from pathlib import Path

from build.lib.file_lock import exclusive_lock, shared_lock

MAX_INCREMENTAL_BYTES = 32 * 1024**3
MAX_ARTIFACT_BYTES = 64 * 1024**3
PROFILE_IDLE_SECONDS = 60
CARGO_LOCKS = {".cargo-lock", ".cargo-build-lock", ".cargo-artifact-lock"}


def _file_stats(directory: Path, excluded=()):
    pending = [directory]
    while pending:
        with os.scandir(pending.pop()) as entries:
            for entry in entries:
                if entry.is_dir(follow_symlinks=False):
                    pending.append(entry.path)
                elif entry.name not in excluded and entry.is_file(
                    follow_symlinks=False
                ):
                    # Windows DirEntry.stat omits file IDs needed to deduplicate hard links.
                    yield (
                        os.stat(entry.path, follow_symlinks=False)
                        if os.name == "nt"
                        else entry.stat(follow_symlinks=False)
                    )


def _profiles(target: Path):
    for lock in [*target.glob("*/.cargo-lock"), *target.glob("*/*/.cargo-lock")]:
        profile = lock.parent
        if not (
            lock.is_symlink() or profile.is_symlink() or profile.parent.is_symlink()
        ):
            yield profile


def profile_from_arguments(arguments: list[str]) -> str:
    if "--" in arguments:
        arguments = arguments[: arguments.index("--")]
    for index, argument in enumerate(arguments):
        if argument == "--profile":
            profile = arguments[index + 1]
            if profile in {"dev", "test"}:
                return "debug"
            return "release" if profile == "bench" else profile
        if argument.startswith("--profile="):
            return profile_from_arguments(["--profile", argument.split("=", 1)[1]])
    return (
        "release"
        if "--release" in arguments or "-r" in arguments or arguments[0] == "bench"
        else "debug"
    )


def trim_artifact_cache(
    target: Path,
    maximum_bytes: int = MAX_ARTIFACT_BYTES,
    *,
    idle_seconds: float = PROFILE_IDLE_SECONDS,
) -> int:
    """Evict complete idle profiles instead of breaking Cargo's unit fingerprints.

    Recent outputs remain available to publishers after Cargo releases its lock.
    Active invocations retain their outputs even if their working set exceeds the
    budget. Lock files remain in place so queued Cargo processes keep one lock inode.
    """
    if not target.is_dir() or target.is_symlink():
        return 0
    with exclusive_lock(target / ".incremental-maintenance.lock", create=True):
        with ExitStack() as locks:
            candidates = []
            total = 0
            for profile in _profiles(target):
                if not locks.enter_context(
                    exclusive_lock(
                        profile / ".cache-lease", create=True, blocking=False
                    )
                ):
                    continue
                if not all(
                    locks.enter_context(exclusive_lock(profile / name, blocking=False))
                    for name in sorted(CARGO_LOCKS)
                    if (profile / name).is_file()
                ):
                    continue
                used = profile / ".cache-used"
                modified = used.stat().st_mtime if used.exists() else 0
                size = 0
                inodes = set()
                for stat in _file_stats(profile, CARGO_LOCKS | {".cache-lease"}):
                    modified = max(modified, stat.st_mtime)
                    identity = (stat.st_dev, stat.st_ino)
                    if identity not in inodes:
                        size += stat.st_size
                        inodes.add(identity)
                total += size
                if time.time() - modified >= idle_seconds:
                    candidates.append((modified, profile, size))
            removed = 0
            for _, profile, size in sorted(candidates):
                if total <= maximum_bytes:
                    break
                for path in profile.iterdir():
                    if path.name in CARGO_LOCKS | {".cache-used", ".cache-lease"}:
                        continue
                    if path.is_dir() and not path.is_symlink():
                        shutil.rmtree(path)
                    else:
                        path.unlink()
                total -= size
                removed += size
            return removed


def trim_incremental_cache(
    target: Path, maximum_bytes: int = MAX_INCREMENTAL_BYTES
) -> int:
    """Evict the oldest incremental sessions under Cargo's profile locks.

    Cargo's profile lock covers rustc's accesses to these compiler-owned directories.
    Active profiles remain intact, even when their retained bytes exceed the budget.
    Dependencies, executables, fingerprints and build-script outputs are never removed.
    """
    if not target.is_dir() or target.is_symlink():
        return 0
    with exclusive_lock(target / ".incremental-maintenance.lock", create=True):
        with ExitStack() as locks:
            candidates = []
            total = 0
            profiles = [*target.glob("*/incremental"), *target.glob("*/*/incremental")]
            for incremental in profiles:
                if (
                    incremental.is_symlink()
                    or incremental.parent.is_symlink()
                    or incremental.parent.parent.is_symlink()
                ):
                    continue
                lock = incremental.parent / ".cargo-lock"
                if not lock.is_file():
                    continue
                if not locks.enter_context(
                    exclusive_lock(
                        incremental.parent / ".cache-lease", create=True, blocking=False
                    )
                ):
                    continue
                acquired = locks.enter_context(exclusive_lock(lock, blocking=False))
                if not acquired:
                    continue
                for session in incremental.iterdir():
                    if not session.is_dir() or session.is_symlink():
                        continue
                    size = 0
                    last_modified = session.stat().st_mtime_ns
                    for stat in _file_stats(session):
                        size += stat.st_size
                        last_modified = max(last_modified, stat.st_mtime_ns)
                    total += size
                    candidates.append((last_modified, session, size))
            removed = 0
            for _, session, size in sorted(candidates):
                if total <= maximum_bytes:
                    break
                shutil.rmtree(session)
                total -= size
                removed += size
            return removed


@contextmanager
def leased_cache(
    repository: Path, *, profile: str = "debug", target_triple: str | None = None
):
    """Protect compilation and execution from explicit cache reclamation.

    Compilation only records use and holds a lease. Scanning here adds latency to
    warm builds; reclaiming compiler state also makes subsequent builds repeat work.
    Disk budgets are applied by the independent prune-build-cache command instead.
    """
    target = repository / ".build/cargo"
    directory = target / target_triple / profile if target_triple else target / profile
    directory.mkdir(parents=True, exist_ok=True)
    with shared_lock(directory / ".cache-lease", create=True):
        (directory / ".cache-used").touch()
        try:
            yield
        finally:
            (directory / ".cache-used").touch()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--max-gib", type=int, default=32)
    parser.add_argument("--artifact-max-gib", type=int, default=64)
    parser.add_argument("--target-dir", type=Path, default=Path(".build/cargo"))
    args = parser.parse_args()
    if args.max_gib < 0 or args.artifact_max_gib < 0:
        parser.error("cache budgets must be non-negative")
    root = Path(__file__).resolve().parents[2]
    target = (root / args.target_dir).resolve()
    if not target.is_relative_to(root / ".build") or target == root / ".build":
        parser.error("--target-dir must name a Cargo output directory inside .build")
    removed = trim_incremental_cache(target, args.max_gib * 1024**3)
    removed += trim_artifact_cache(target, args.artifact_max_gib * 1024**3)
    print(f"Reclaimed {removed / 1024**3:.2f} GiB of build cache.")
