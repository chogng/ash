"""Resolve the checksum-locked ripgrep executable."""

from .executable import ExecutableResolution as RipgrepResolution
from .executable import load_lock as _load_lock
from .executable import resolve_executable

__all__ = ["RipgrepResolution", "load_lock", "resolve_ripgrep"]


def load_lock(path):
    return _load_lock(path, "ripgrep")


def resolve_ripgrep(spec, lock_path, cache_root, explicit_binary=None):
    return resolve_executable(
        spec,
        lock_path,
        cache_root,
        explicit_binary,
        runtime="ripgrep",
        executable_name=spec.ripgrep_name,
    )
