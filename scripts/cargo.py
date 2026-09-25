"""Run Cargo with Ash's checksum-verified Code Mode V8 inputs."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY_ROOT))

from build.lib.cargo_selection import cargo_command_uses_package, cargo_command_uses_v8  # noqa: E402
from build.lib.targets import TARGETS, default_target  # noqa: E402
from build.lib.v8 import (  # noqa: E402
    DEFAULT_CACHE,
    DEFAULT_LOCK,
    resolve_v8_cargo_env,
)


def cargo_target(arguments: list[str]) -> str | None:
    for index, argument in enumerate(arguments):
        if argument == "--target" and index + 1 < len(arguments):
            return arguments[index + 1]
        if argument.startswith("--target="):
            return argument.split("=", 1)[1]
    return None


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run Cargo with the locked sandbox-enabled rusty_v8 archive and binding."
    )
    parser.add_argument("--cargo", default="cargo")
    parser.add_argument("--v8-target", choices=sorted(TARGETS))
    parser.add_argument("--v8-lock", type=Path, default=DEFAULT_LOCK)
    parser.add_argument("--v8-cache-root", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--deny-warnings", action="store_true")
    parser.add_argument("cargo_arguments", nargs=argparse.REMAINDER)
    args = parser.parse_args(arguments)
    cargo_arguments = list(args.cargo_arguments)
    if cargo_arguments[:1] == ["--"]:
        cargo_arguments = cargo_arguments[1:]
    if not cargo_arguments:
        parser.error("a Cargo command is required")

    target = args.v8_target or cargo_target(cargo_arguments) or default_target()
    if target not in TARGETS:
        parser.error(f"unsupported V8 target: {target}")
    environment = os.environ.copy()
    if args.deny_warnings:
        environment["RUSTFLAGS"] = " ".join(
            filter(None, [environment.get("RUSTFLAGS"), "-D warnings"])
        )
    if cargo_command_uses_v8(args.cargo, cargo_arguments, REPOSITORY_ROOT):
        environment.update(
            resolve_v8_cargo_env(
                TARGETS[target],
                environ=environment,
                lock_path=args.v8_lock.expanduser().resolve(),
                cache_root=args.v8_cache_root.expanduser().resolve(),
            )
        )
    if (
        cargo_arguments[0] in {"test", "run"}
        and "ASH_TGREP_PATH" not in environment
        and (
            cargo_command_uses_package(
                args.cargo, cargo_arguments, REPOSITORY_ROOT, "ash-tgrep"
            )
            # The CLI starts a sibling App Server; its runtime inputs no longer appear in
            # the CLI's Cargo dependency graph.
            or cargo_command_uses_package(
                args.cargo, cargo_arguments, REPOSITORY_ROOT, "ash-cli"
            )
        )
    ):
        from build.ash_rs.tgrep import resolve_tgrep

        executable = resolve_tgrep(
            TARGETS[target],
            REPOSITORY_ROOT / "third_party/tgrep/runtime-lock.json",
            REPOSITORY_ROOT / "third_party/.cache/tgrep",
        )
        environment["ASH_TGREP_PATH"] = str(executable.executable)
    return subprocess.run(
        [args.cargo, *cargo_arguments], cwd=REPOSITORY_ROOT, env=environment
    ).returncode


if __name__ == "__main__":
    raise SystemExit(main())
