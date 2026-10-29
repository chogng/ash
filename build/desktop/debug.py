"""Prepare a symbol-bearing App Server generation for Desktop self debugging."""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from build.lib.cargo import cargo_artifact_executable, parse_cargo_message
from build.lib.development_store import publish_generation
from build.lib.targets import TARGETS, OperatingSystem, default_target
from build.prepare import PROFILE, current_package, development_root


def prepare_debug_backend() -> None:
    spec = TARGETS[default_target()]
    package = current_package(development_root(ROOT, spec.target, "host-provided-node"))
    command = [
        sys.executable,
        "-B",
        str(ROOT / "scripts/cargo.py"),
        "build",
        "--locked",
        "--package",
        "ash-app-server",
        "--bin",
        "ash-app-server",
        "--profile",
        PROFILE,
        "--message-format=json-render-diagnostics",
    ]
    # Keep dependency settings and the normal development profile. Only the
    # executable and its domain implementation need full variable information.
    # Pack macOS symbols with their lookup index and keep them beside the binary.
    split_debuginfo = (
        "packed" if spec.operating_system == OperatingSystem.MACOS else "off"
    )
    for name in ["ash-app-server", "ash-app-server-runtime"]:
        for key, value in [
            ("debug", '"full"'),
            ("strip", '"none"'),
            ("split-debuginfo", json.dumps(split_debuginfo)),
        ]:
            command.extend(
                ["--config", f"profile.{PROFILE}.package.{name}.{key}={value}"]
            )
    if spec.is_windows:
        command.extend(["--target", spec.target])
    result = subprocess.run(
        command, cwd=ROOT, stdout=subprocess.PIPE, text=True, check=False
    )
    executable = None
    symbols = []
    for line in result.stdout.splitlines():
        message = parse_cargo_message(line)
        candidate = cargo_artifact_executable(message, "ash-app-server")
        if candidate is not None:
            executable = Path(candidate)
            symbols = [
                Path(name)
                for name in message.get("filenames", [])
                if Path(name).suffix.lower() == ".pdb"
            ]
        if message and message.get("reason") == "compiler-message":
            rendered = message.get("message", {}).get("rendered")
            if rendered:
                sys.stderr.write(rendered)
    result.check_returncode()
    if executable is None:
        raise RuntimeError("Cargo did not report the debug App Server executable")
    binaries = {"ash-app-server": executable}
    for symbol in symbols:
        binaries[symbol.name] = symbol
    symbol_directories = {}
    if spec.operating_system == OperatingSystem.MACOS:
        source = Path(str(executable) + ".dSYM")
        if source.is_symlink():
            # Cargo's dSYM alias points into deps, just as in release packaging.
            resolved = source.resolve(strict=True)
            if not resolved.is_relative_to(executable.parent.resolve()):
                raise ValueError("dSYM alias leaves the compiler output directory")
            source = resolved
        if not source.is_dir() or any(path.is_symlink() for path in source.rglob("*")):
            raise ValueError("Debug App Server requires a packed dSYM without symlinks")
        symbol_directories[executable.name + ".dSYM"] = source
    _, generation = publish_generation(
        package,
        binaries,
        ROOT / ".build/desktop/debug/app-server",
        symbol_directories=symbol_directories,
    )
    print(f"Prepared debug App Server generation {generation}")


def debug_backend_status() -> None:
    spec = TARGETS[default_target()]
    package = current_package(development_root(ROOT, spec.target, "host-provided-node"))
    executable = (
        package
        / "bin"
        / ("ash-app-server-daemon.exe" if spec.is_windows else "ash-app-server-daemon")
    )
    # Status is read-only: never start a backend just to find an attach target.
    environment = {**os.environ, "ASH_HOME": str(ROOT / ".build/desktop/debug/profile")}
    result = subprocess.run(
        [str(executable), "version"],
        env=environment,
        text=True,
        stdout=subprocess.PIPE,
        check=True,
    )
    status = json.loads(result.stdout)
    print(json.dumps(status, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--status",
        action="store_true",
        help="Read the isolated debug backend's PID without starting it",
    )
    arguments = parser.parse_args()
    if arguments.status:
        debug_backend_status()
    else:
        prepare_debug_backend()
