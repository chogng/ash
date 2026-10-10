"""Build missing release executables in one Cargo invocation."""

import os
import stat
import subprocess
import sys
from pathlib import Path
from typing import Dict, Mapping, Optional

from build.lib.cargo import cargo_artifact_executable
from build.lib.cargo import cargo_rendered_diagnostic
from build.lib.cargo import parse_cargo_message
from build.lib.cargo import resolve_cargo_target_directory
from build.lib.cargo_cache import leased_cache
from build.lib.sherpa import resolve_sherpa_cargo_env
from build.lib.targets import TargetSpec
from build.lib.v8 import resolve_v8_cargo_env
from build.lib.cargo_selection import cargo_command_packages
from build.protocol.generate import generate_protocol


_BINARIES = {
    "ash-package-store": ("ash-package-store", "--package-store-bin"),
    "bwrap": ("ash-bwrap", "--bwrap-bin"),
    "ash-voice-host": ("ash-voice-host", "--voice-host-bin"),
    "ash-collaboration-server": (
        "ash-collaboration-server",
        "--collaboration-server-bin",
    ),
    "ash-app-server": ("ash-app-server", "--server-bin"),
    "ash-app-server-daemon": ("ash-app-server-daemon", "--app-server-daemon-bin"),
    "ash-code-mode-host": ("ash-code-mode-host", "--code-mode-host-bin"),
    "ash-js-extension-host": ("ash-js-extension-host", "--js-extension-host-bin"),
    "ash-remote-host": ("ash-remote-host", "--remote-host-bin"),
    "ash-remote": ("ash-remote-connections", "--remote-bin"),
    "ash-remote-server": ("ash-remote-server", "--remote-server-bin"),
    "ash-exec-server": ("ash-exec-server", "--exec-server-bin"),
    "ash-windows-sandbox": ("ash-windows-sandbox", "--windows-sandbox-bin"),
    "ash-windows-sandbox-service": (
        "ash-windows-sandbox-service",
        "--windows-sandbox-service-bin",
    ),
}


def cargo_environment(spec: TargetSpec, packages: set[str]) -> dict[str, str]:
    environment = os.environ.copy()
    if "v8" in packages:
        environment.update(resolve_v8_cargo_env(spec, environ=environment))
    if "sherpa-onnx-sys" in packages:
        environment.update(resolve_sherpa_cargo_env(spec, environ=environment))
    return environment


def build_binaries(
    repository_root: Path,
    spec: TargetSpec,
    inputs: Mapping[str, Optional[Path]],
    *,
    cargo: str,
    cargo_profile: str,
    host_build: bool = False,
) -> Dict[str, Path]:
    if (
        any(
            name in inputs
            for name in ("ash-windows-sandbox", "ash-windows-sandbox-service")
        )
        and not spec.is_windows
    ):
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
        "--target-dir",
        str(resolve_cargo_target_directory(repository_root)),
        "--message-format=json-render-diagnostics",
    ]
    # Windows packages use MSVC, including their standalone V8 hosts. An
    # implicit host build can inherit a caller's GNU Cargo target and mismatch
    # the locked V8 archive; keep compilation and the cache lease explicit.
    target = spec.target if not host_build or spec.is_windows else None
    if target is not None:
        command.extend(["--target", spec.target])
    for name in missing:
        command.extend(["--package", _BINARIES[name][0], "--bin", name])
    if "ash-voice-host" in missing:
        command.extend(["--features", "ash-voice-host/host"])
    packages = cargo_command_packages(cargo, command[1:], repository_root)
    if "ash-app-server-protocol" in packages:
        generate_protocol(root=repository_root, cargo=cargo)
    environment = cargo_environment(spec, packages)
    with leased_cache(
        repository_root,
        profile="debug" if cargo_profile == "dev" else cargo_profile,
        target_triple=target,
    ):
        result = subprocess.run(
            command,
            cwd=repository_root,
            env=environment,
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


def is_executable(path: Path) -> bool:
    if os.name == "nt":
        return True
    mode = path.stat().st_mode
    return bool(mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)) and os.access(
        str(path), os.X_OK
    )
