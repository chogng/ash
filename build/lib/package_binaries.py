"""Build selected executables with isolated Cargo feature groups."""

import os
import stat
import subprocess
import sys
from pathlib import Path
from collections.abc import Callable
from typing import Dict, Mapping, Optional

from build.lib.cargo import cargo_artifact_executable
from build.lib.cargo import cargo_rendered_diagnostic
from build.lib.cargo import parse_cargo_message
from build.lib.cargo import resolve_cargo_target_directory
from build.lib.cargo_cache import leased_cache
from build.lib.cargo_inputs import cargo_environment
from build.lib.targets import TargetSpec
from build.lib.cargo_selection import cargo_command_packages
from build.protocol.generate import generate_protocol


_BINARIES = {
    "ash-livekit-client": ("ash-livekit-client", "--livekit-client-bin"),
    "ash-realtime-voice": ("ash-realtime-voice", "--recognizer-bin"),
    "ash-debug-javascript": (
        "ash-debug-javascript",
        "--javascript-debug-extension-bin",
    ),
    "ash-debug-server-ready": (
        "ash-debug-server-ready",
        "--server-ready-extension-bin",
    ),
    "ash-debug-lldb": ("ash-debug-lldb", "--lldb-extension-bin"),
    "ash-dev-container-provider": (
        "ash-dev-container-provider",
        "--dev-container-provider-bin",
    ),
    "ash-update-host": ("ash-product-update", "--update-host-bin"),
    "ash-package-store": ("ash-package-store", "--package-store-bin"),
    "bwrap": ("ash-bwrap", "--bwrap-bin"),
    "ash-voice-host": ("ash-voice-host", "--voice-host-bin"),
    "ash-collab-server": (
        "ash-collab-server",
        "--collab-server-bin",
    ),
    "ash-app-server": ("ash-app-server", "--server-bin"),
    "ash-app-server-daemon": ("ash-app-server-daemon", "--app-server-daemon-bin"),
    "ash-code-mode-host": ("ash-code-mode-host", "--code-mode-host-bin"),
    "ash-remote-ssh-extension": (
        "ash-remote-ssh-extension",
        "--remote-ssh-extension-bin",
    ),
    "ash-external-js-ext": ("ash-external-js-ext", "--external-js-ext-bin"),
    "ash-git-extension": ("ash-git-extension", "--git-extension-bin"),
    "ash-markdown-math": ("ash-markdown-math", "--markdown-math-bin"),
    "ash-markdown-language-features": (
        "ash-markdown-language-features",
        "--markdown-extension-bin",
    ),
    "ash-github-authentication": (
        "ash-github-authentication",
        "--github-authentication-bin",
    ),
    "ash-github-extension": (
        "ash-github-extension",
        "--github-extension-bin",
    ),
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


def build_binaries(
    repository_root: Path,
    spec: TargetSpec,
    inputs: Mapping[str, Optional[Path]],
    *,
    cargo: str,
    cargo_profile: str,
    host_build: bool = False,
    protocol_prepared: bool = False,
    on_rebuilt_binary: Callable[[str, Path], None] | None = None,
) -> Dict[str, Path]:
    """Notify rebuilt executables after each successful group, before the next.

    Callers own any asynchronous work started by on_rebuilt_binary. Fresh Cargo
    artifacts and caller-supplied executables do not trigger that callback.
    """
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

    # Inspect the union only to prepare external inputs once. Compilation still
    # separates local hosts: Cargo must not unify their device/inference features
    # into the App Server or Remote executable graphs.
    command = _build_command(
        repository_root, spec, missing, cargo, cargo_profile, host_build
    )
    packages = cargo_command_packages(cargo, command[1:], repository_root)
    if not protocol_prepared and "ash-app-server-protocol" in packages:
        generate_protocol(root=repository_root, cargo=cargo)
    environment = cargo_environment(spec, packages)
    if cargo_profile == "release" and "apple-darwin" in spec.target:
        environment["CARGO_PROFILE_RELEASE_SPLIT_DEBUGINFO"] = "packed"

    local_hosts = {"ash-livekit-client", "ash-realtime-voice", "ash-voice-host"}
    core = [name for name in missing if name not in local_hosts]
    groups = ([core] if core else []) + [
        [name] for name in missing if name in local_hosts
    ]
    for group in groups:
        outputs.update(
            _build_group(
                repository_root,
                spec,
                group,
                cargo,
                cargo_profile,
                host_build,
                environment,
                on_rebuilt_binary,
            )
        )
    return outputs


def _build_command(
    repository_root: Path,
    spec: TargetSpec,
    missing: list[str],
    cargo: str,
    cargo_profile: str,
    host_build: bool,
) -> list[str]:
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
    # Limit the measured size optimization to Windows x64 release packages.
    # An explicit command override also preserves it in symbol provenance.
    if cargo_profile == "release" and spec.target == "x86_64-pc-windows-msvc":
        command.extend(["--config", "profile.release.codegen-units=1"])
    if cargo_profile == "dev-small" and "ash-app-server" in missing:
        from build.desktop.live import live_directory

        if live_directory() is not None:
            command.extend(["--features", "ash-app-server/rust-live"])
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
    for name in ("ash-livekit-client", "ash-realtime-voice"):
        if name in missing:
            command.extend(["--features", f"{name}/host"])
    return command


def _build_group(
    repository_root: Path,
    spec: TargetSpec,
    missing: list[str],
    cargo: str,
    cargo_profile: str,
    host_build: bool,
    environment: dict[str, str],
    on_rebuilt_binary: Callable[[str, Path], None] | None,
) -> dict[str, Path]:
    command = _build_command(
        repository_root, spec, missing, cargo, cargo_profile, host_build
    )
    target = spec.target if not host_build or spec.is_windows else None
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
    artifacts = []
    for line in result.stdout.splitlines():
        message = parse_cargo_message(line)
        if (
            message
            and message.get("reason") == "compiler-artifact"
            and message.get("executable")
        ):
            artifacts.append(message)
        diagnostic = cargo_rendered_diagnostic(message)
        if diagnostic is not None:
            sys.stderr.write(diagnostic)
        for name in missing:
            executable = cargo_artifact_executable(message, name)
            if executable is not None:
                executables[name] = Path(executable)
    result.check_returncode()
    outputs = {}
    for name in missing:
        if name not in executables:
            raise RuntimeError(f"Cargo did not report an executable for {name}")
        outputs[name] = validate_input_binary(
            executables[name], name, cargo, spec.is_windows
        )
        if on_rebuilt_binary is not None and any(
            artifact.get("fresh") is False
            and cargo_artifact_executable(artifact, name) is not None
            for artifact in artifacts
        ):
            on_rebuilt_binary(name, outputs[name])
    if cargo_profile == "release" and environment.get("ASH_SYMBOLS_DIR"):
        from build.release.symbols import SymbolStore

        SymbolStore(
            Path(environment["ASH_SYMBOLS_DIR"]), repository_root
        ).record_compilation(spec.target, command, environment, artifacts)
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
