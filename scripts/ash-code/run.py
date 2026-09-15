"""Build one source-tree runtime generation and launch the Code TUI."""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
DEVELOPMENT_PROFILE = "dev-small"
DEVELOPMENT_RUNTIME_ROOT = REPOSITORY_ROOT / ".build" / "ash-development"


def development_binaries(
    *, platform_name: str | None = None, code_mode: str | None = None
) -> list[str]:
    platform_name = platform_name or sys.platform
    binaries = ["ash", "ash-app-server"]
    if platform_name.startswith("linux"):
        binaries.append("bwrap")
    if (code_mode or "embedded").strip().lower() == "host":
        binaries.append("ash-code-mode-host")
    return binaries


def cargo_target_directory(environment: dict[str, str]) -> Path:
    configured = environment.get("CARGO_TARGET_DIR", "").strip()
    target = Path(configured) if configured else REPOSITORY_ROOT / ".build" / "cargo"
    if not target.is_absolute():
        target = REPOSITORY_ROOT / target
    return target.resolve()


def built_executable(name: str, environment: dict[str, str]) -> Path:
    suffix = ".exe" if os.name == "nt" else ""
    return cargo_target_directory(environment) / DEVELOPMENT_PROFILE / f"{name}{suffix}"


def build_binaries(
    binaries: list[str], environment: dict[str, str]
) -> tuple[int, dict[str, Path]]:
    arguments = ["build", "--workspace", "--profile", DEVELOPMENT_PROFILE]
    for binary in binaries:
        arguments.extend(["--bin", binary])
    result = subprocess.run(
        [sys.executable, "-B", "scripts/cargo.py", *arguments],
        cwd=REPOSITORY_ROOT,
        env=environment,
        check=False,
    )
    if result.returncode != 0:
        return result.returncode, {}
    executables = {name: built_executable(name, environment) for name in binaries}
    for name, executable in executables.items():
        if not executable.is_file():
            raise RuntimeError(f"Cargo did not produce {name}: {executable}")
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
                f"Ash development runtime is missing {name}: {executable}"
            )
    return staged


def runtime_environment(
    environment: dict[str, str], executables: dict[str, Path]
) -> dict[str, str]:
    runtime = environment.copy()
    runtime["ASH_APP_SERVER_PATH"] = str(executables["ash-app-server"].resolve())
    runtime["ASH_PRODUCT_SERVICES_PATH"] = str(
        (REPOSITORY_ROOT / "resources/product-services/product-services.json").resolve()
    )
    if bubblewrap := executables.get("bwrap"):
        runtime["ASH_BWRAP_PATH"] = str(bubblewrap.resolve())
    if code_mode_host := executables.get("ash-code-mode-host"):
        runtime["ASH_CODE_MODE_HOST_BIN"] = str(code_mode_host.resolve())
    return runtime


def main(arguments: list[str] | None = None) -> int:
    environment = os.environ.copy()
    binaries = development_binaries(code_mode=environment.get("ASH_CODE_MODE_RUNTIME"))
    returncode, built = build_binaries(binaries, environment)
    if returncode != 0:
        return returncode
    executables = stage_runtime(built)
    environment = runtime_environment(environment, executables)
    return subprocess.run(
        [str(executables["ash"]), *(arguments or [])],
        cwd=REPOSITORY_ROOT,
        env=environment,
        check=False,
    ).returncode


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
