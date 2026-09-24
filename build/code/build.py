"""Build and stage the Code development executables."""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT))

from build.lib.cargo import cargo_artifact_executable  # noqa: E402
from build.lib.cargo import cargo_rendered_diagnostic  # noqa: E402
from build.lib.cargo import parse_cargo_message  # noqa: E402
from build.lib.cargo import resolve_cargo_target_directory  # noqa: E402
from build.lib.targets import TARGETS  # noqa: E402
from build.lib.targets import default_target  # noqa: E402
from build.lib.v8 import resolve_v8_cargo_env  # noqa: E402


DEVELOPMENT_PROFILE = "dev-small"
DEVELOPMENT_RUNTIME_ROOT = REPOSITORY_ROOT / ".build" / "code" / "dev"
BINARY_PACKAGES = {
    "ash": "ash-cli",
    "ash-app-server": "ash-app-server",
    "ash-code-mode-host": "ash-code-mode-host",
    "bwrap": "ash-bwrap",
}


def development_binaries(*, platform_name: str | None = None) -> list[str]:
    platform_name = platform_name or sys.platform
    binaries = ["ash", "ash-app-server", "ash-code-mode-host"]
    if platform_name.startswith("linux"):
        binaries.append("bwrap")
    return binaries


def build_binaries(
    binaries: list[str], environment: dict[str, str]
) -> tuple[int, dict[str, Path]]:
    target = TARGETS[default_target()]
    cargo_environment = environment.copy()
    cargo_environment.update(resolve_v8_cargo_env(target, environ=cargo_environment))
    if target.target == "x86_64-pc-windows-msvc":
        cargo_environment.setdefault(
            "CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER", "rust-lld"
        )
    command = [
        "cargo",
        "build",
        "--locked",
        "--profile",
        DEVELOPMENT_PROFILE,
        "--target-dir",
        str(resolve_cargo_target_directory(REPOSITORY_ROOT, cargo_environment)),
        "--message-format=json-render-diagnostics",
    ]
    for binary in binaries:
        command.extend(["--package", BINARY_PACKAGES[binary], "--bin", binary])
    executables: dict[str, Path] = {}
    # Cargo writes build progress to stderr; keep it on the terminal while
    # reading JSON diagnostics and executable paths from stdout as they arrive.
    with subprocess.Popen(
        command,
        cwd=REPOSITORY_ROOT,
        env=cargo_environment,
        stdout=subprocess.PIPE,
        text=True,
    ) as process:
        for line in process.stdout:
            message = parse_cargo_message(line)
            if diagnostic := cargo_rendered_diagnostic(message):
                sys.stderr.write(diagnostic)
                sys.stderr.flush()
            for name in binaries:
                if executable := cargo_artifact_executable(message, name):
                    executables[name] = Path(executable)
        returncode = process.wait()
    if returncode != 0:
        return returncode, {}
    for name in binaries:
        if name not in executables:
            raise RuntimeError(f"Cargo did not report {name}")
        if not executables[name].is_file():
            raise RuntimeError(f"Cargo did not produce {name}: {executables[name]}")
    return 0, executables


def stage_runtime(executables: dict[str, Path]) -> dict[str, Path]:
    digest = hashlib.sha256()
    for name, executable in sorted(executables.items()):
        digest.update(name.encode("utf-8"))
        digest.update(b"\0")
        with executable.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
        digest.update(b"\0")
    runtime = DEVELOPMENT_RUNTIME_ROOT / digest.hexdigest()
    if not runtime.is_dir():
        DEVELOPMENT_RUNTIME_ROOT.mkdir(parents=True, exist_ok=True)
        staging = DEVELOPMENT_RUNTIME_ROOT / f".next-{uuid.uuid4()}"
        try:
            staging.mkdir()
            for executable in executables.values():
                shutil.copy2(executable, staging / executable.name)
            try:
                staging.rename(runtime)
            except FileExistsError:
                pass
        finally:
            shutil.rmtree(staging, ignore_errors=True)
    staged = {
        name: runtime / executable.name for name, executable in executables.items()
    }
    for name, executable in staged.items():
        if not executable.is_file():
            raise RuntimeError(
                f"Code development runtime is missing {name}: {executable}"
            )
    return staged


def main() -> int:
    return build_binaries(development_binaries(), os.environ.copy())[0]


if __name__ == "__main__":
    raise SystemExit(main())
