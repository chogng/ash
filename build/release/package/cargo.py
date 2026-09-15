"""Build missing release executables in one Cargo invocation."""

import os
import stat
import subprocess
import sys
from pathlib import Path
from typing import Dict, Mapping, Optional

from .cargo_paths import cargo_artifact_executable
from .cargo_paths import cargo_rendered_diagnostic
from .cargo_paths import parse_cargo_message
from .cargo_paths import resolve_cargo_target_directory
from build.lib.ash_build.targets import TargetSpec
from build.lib.ash_build.v8 import resolve_v8_cargo_env


_BINARIES = {
    "ash-app-server": ("ash-app-server", "--server-bin"),
    "ash-app-server-daemon": ("ash-app-server-daemon", "--app-server-daemon-bin"),
    "ash-code-mode-host": ("ash-code-mode-host", "--code-mode-host-bin"),
    "ash-remote": ("ash-remote-connections", "--remote-bin"),
    "ash-remote-server": ("ash-remote-server", "--remote-server-bin"),
    "ash-exec-server": ("ash-exec-server", "--exec-server-bin"),
    "ash-windows-sandbox": ("ash-windows-sandbox", "--windows-sandbox-bin"),
}


def cargo_environment(spec: TargetSpec) -> dict[str, str]:
    environment = os.environ.copy()
    environment.update(resolve_v8_cargo_env(spec, environ=environment))
    return environment


def build_binaries(
    repository_root: Path,
    spec: TargetSpec,
    inputs: Mapping[str, Optional[Path]],
    *,
    cargo: str,
    cargo_profile: str,
) -> Dict[str, Path]:
    if "ash-windows-sandbox" in inputs and not spec.is_windows:
        raise RuntimeError("Windows sandbox executable requires a Windows target")
    outputs = {
        name: validate_input_binary(path, name, _BINARIES[name][1], spec.is_windows)
        for name, path in inputs.items()
        if path is not None
    }
    missing = [name for name in inputs if name not in outputs]
    if not missing:
        return outputs

    command = [
        cargo,
        "build",
        "--manifest-path",
        str(repository_root / "Cargo.toml"),
        "--locked",
        "--profile",
        cargo_profile,
        "--target",
        spec.target,
        "--target-dir",
        str(resolve_cargo_target_directory(repository_root)),
        "--message-format=json-render-diagnostics",
    ]
    for name in missing:
        command.extend(["--package", _BINARIES[name][0], "--bin", name])
    result = subprocess.run(
        command,
        cwd=repository_root,
        env=cargo_environment(spec)
        if any(name != "ash-windows-sandbox" for name in missing)
        else None,
        stdout=subprocess.PIPE,
        text=True,
        check=False,
    )
    executables = {}
    for line in result.stdout.splitlines():
        message = parse_cargo_message(line)
        diagnostic = cargo_rendered_diagnostic(message)
        if diagnostic is not None:
            sys.stderr.write(diagnostic)
        for name in missing:
            executable = cargo_artifact_executable(message, name)
            if executable is not None:
                executables[name] = Path(executable)
    result.check_returncode()
    for name in missing:
        if name not in executables:
            raise RuntimeError(f"Cargo did not report an executable for {name}")
        outputs[name] = validate_input_binary(
            executables[name], name, cargo, spec.is_windows
        )
    return outputs


def validate_input_binary(
    path: Path, description: str, flag_name: str, is_windows_target: bool
) -> Path:
    resolved = path.expanduser().resolve()
    if not resolved.is_file():
        raise RuntimeError(
            "{} does not exist: {} (source: {})".format(
                description, resolved, flag_name
            )
        )
    if not is_windows_target and not is_executable(resolved):
        raise RuntimeError("{} is not executable: {}".format(description, resolved))
    return resolved


def resolve_windows_sandbox_binary(
    repository_root: Path,
    spec: TargetSpec,
    explicit_binary: Optional[Path],
    cargo: str,
    cargo_profile: str,
) -> Optional[Path]:
    if not spec.is_windows and explicit_binary is None:
        return None
    return build_binaries(
        repository_root,
        spec,
        {"ash-windows-sandbox": explicit_binary},
        cargo=cargo,
        cargo_profile=cargo_profile,
    )["ash-windows-sandbox"]


def is_executable(path: Path) -> bool:
    if os.name == "nt":
        return True
    mode = path.stat().st_mode
    return bool(mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)) and os.access(
        str(path), os.X_OK
    )
