"""Bounded, offline tool execution shared by release and crash analysis."""

from __future__ import annotations

import os
import platform
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from functools import cache
from pathlib import Path

MAX_OUTPUT = 8 * 1024 * 1024


@cache
def windows_llvm_directories() -> tuple[Path, ...]:
    """Find host tools, including VS installations outside the default drive."""
    directories = []
    if program_files := os.environ.get("ProgramFiles"):
        directories.append(Path(program_files) / "LLVM/bin")
    installer = Path(os.environ.get("ProgramFiles(x86)", "C:/Program Files (x86)"))
    vswhere = installer / "Microsoft Visual Studio/Installer/vswhere.exe"
    if vswhere.is_file():
        try:
            result = subprocess.run(
                [
                    str(vswhere),
                    "-products",
                    "*",
                    "-property",
                    "installationPath",
                    "-utf8",
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                check=True,
                timeout=10,
            )
        except (OSError, subprocess.SubprocessError):
            # PATH and standalone LLVM remain usable if the VS inventory fails.
            return tuple(directories)
        host = "ARM64" if platform.machine().lower() in {"arm64", "aarch64"} else "x64"
        for installation in result.stdout.splitlines():
            if installation.strip():
                root = Path(installation.strip()) / "VC/Tools/Llvm"
                directories.extend((root / host / "bin", root / "bin"))
    return tuple(directories)


def tool(name: str) -> str:
    directory = os.environ.get("ASH_LLVM_BIN")
    candidates = [Path(directory) / name] if directory else []
    if sys.platform == "darwin":
        candidates.append(Path("/opt/homebrew/opt/llvm/bin") / name)
    for candidate in candidates:
        paths = (candidate,)
        if sys.platform == "win32":
            paths += (candidate.with_suffix(".exe"),)
        for path in paths:
            if path.is_file():
                return str(path)
    if found := shutil.which(name):
        return found
    if sys.platform == "win32":
        for directory in windows_llvm_directories():
            candidate = directory / (name + ".exe")
            if candidate.is_file():
                return str(candidate)
    if sys.platform == "darwin" and name == "llvm-dwarfdump":
        if found := shutil.which("dwarfdump"):
            return found
    raise RuntimeError(
        f"Required tool {name} missing; install LLVM or set ASH_LLVM_BIN"
    )


def check_build_tools() -> dict[str, str]:
    """Check the real symbol-test prerequisites before starting any test suite."""
    names = ["rustc"]
    if sys.platform == "win32":
        names += ["llvm-pdbutil", "llvm-symbolizer"]
    elif sys.platform == "darwin":
        names += ["nm", "dsymutil", "strip", "codesign", "llvm-dwarfdump", "lldb"]
        # Match resolve_frame's supported Xcode fallback.
        names += ["llvm-symbolizer" if _has_symbolizer() else "atos"]
    else:
        names += [
            "llvm-nm",
            "llvm-objcopy",
            "llvm-strip",
            "llvm-dwarfdump",
            "llvm-symbolizer",
        ]
    resolved = {}
    errors = []
    for name in names:
        try:
            executable = tool(name)
            if name == "rustc" or name.startswith("llvm-"):
                # The rustup proxy may first provision rust-toolchain.toml's pin.
                run([executable, "--version"], timeout=120 if name == "rustc" else 15)
            if name == "lldb":
                output = run(
                    [
                        executable,
                        "--no-lldbinit",
                        "--batch",
                        "-o",
                        "script print('ASH_LLDB_PYTHON_OK')",
                    ],
                    timeout=15,
                )
                if "\nASH_LLDB_PYTHON_OK" not in output:
                    raise RuntimeError("LLDB requires Python scripting support")
            resolved[name] = executable
        except (OSError, RuntimeError) as error:
            errors.append(f"{name}: {error}")
    if errors:
        raise RuntimeError(
            "Build test prerequisites failed:\n  "
            + "\n  ".join(errors)
            + "\nInstall Rust and the host LLVM symbol tools (Windows: Visual Studio "
            "Installer's C++ Clang tools or a complete LLVM distribution; macOS: "
            "Xcode command line tools; Debian/Ubuntu: apt-get install llvm). "
            "For a custom LLVM location set ASH_LLVM_BIN to its bin directory. "
            "See docs/build.md, then rerun just check-build-tools."
        )
    return resolved


def _has_symbolizer() -> bool:
    try:
        tool("llvm-symbolizer")
        return True
    except RuntimeError:
        return False


def run(command: list[str], *, timeout: float = 120) -> str:
    # Temporary files bound memory; polling bounds disk growth and cancellation
    # reaps the whole process group, including debugger helpers on POSIX.
    with tempfile.TemporaryFile() as output:
        environment = os.environ.copy()
        environment.pop("LLVM_SYMBOLIZER_OPTS", None)
        environment["DEBUGINFOD_URLS"] = ""
        environment["LC_ALL"] = "C"
        process = subprocess.Popen(
            command,
            stdout=output,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            env=environment,
            start_new_session=os.name != "nt",
        )
        deadline = time.monotonic() + timeout
        try:
            while process.poll() is None:
                if (
                    time.monotonic() > deadline
                    or os.fstat(output.fileno()).st_size > MAX_OUTPUT
                ):
                    raise RuntimeError(f"Tool exceeded time/output limit: {command[0]}")
                time.sleep(0.02)
            if os.fstat(output.fileno()).st_size > MAX_OUTPUT:
                raise RuntimeError(f"Tool exceeded output limit: {command[0]}")
            output.seek(0)
            result = output.read().decode("utf-8", errors="replace")
            if process.returncode:
                raise RuntimeError(
                    f"{command[0]} exited {process.returncode}: {result[-4000:]}"
                )
            return result
        finally:
            if process.poll() is None:
                if os.name == "nt":
                    subprocess.run(
                        ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        check=False,
                    )
                else:
                    os.killpg(process.pid, signal.SIGKILL)
                process.kill()
            process.wait()
