"""Resolve the checksum-locked tgrep executable."""

from .executable import ExecutableResolution
from .executable import resolve_executable


def resolve_tgrep(
    spec, lock_path, cache_root, explicit_binary=None
) -> ExecutableResolution:
    return resolve_executable(
        spec,
        lock_path,
        cache_root,
        explicit_binary,
        runtime="tgrep",
        executable_name="tgrep" + spec.executable_suffix,
    )
