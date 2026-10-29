"""Build and stage the Code development executables."""

from __future__ import annotations

import os
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT))

from build.lib.cargo import cargo_artifact_executable  # noqa: E402
from build.lib.cargo import cargo_rendered_diagnostic  # noqa: E402
from build.lib.cargo import parse_cargo_message  # noqa: E402
from build.lib.cargo import resolve_cargo_target_directory  # noqa: E402
from build.lib.cargo_cache import leased_cache  # noqa: E402
from build.lib.cargo_selection import cargo_command_packages  # noqa: E402
from build.lib.cargo_inputs import cargo_environment  # noqa: E402
from build.lib.targets import TARGETS  # noqa: E402
from build.lib.targets import default_target  # noqa: E402
from build.lib.development_store import leased_binary_generation  # noqa: E402
from build.protocol.generate import generate_protocol  # noqa: E402
from build.prepare import current_package, development_root  # noqa: E402


DEVELOPMENT_PROFILE = "dev-small"
DEVELOPMENT_RUNTIME_ROOT = REPOSITORY_ROOT / ".build" / "code" / "dev"
BINARY_PACKAGES = {
    "ash": "ash-cli",
    "ash-app-server": "ash-app-server",
    "ash-app-server-daemon": "ash-app-server-daemon",
    "ash-code-mode-host": "ash-code-mode-host",
    "ash-voice-host": "ash-voice-host",
    "ash-livekit-client": "ash-livekit-client",
    "ash-realtime-voice": "ash-realtime-voice",
    "bwrap": "ash-bwrap",
}


def prepare_runtime_environment(root: Path) -> tuple[int, dict[str, str]]:
    """Prepare shared backend resources, including the standalone Node host."""
    result = subprocess.run(
        [
            sys.executable,
            "-B",
            "build/prepare.py",
            "--javascript-runtime",
            "packaged-node",
        ],
        cwd=root,
        check=False,
    )
    if result.returncode:
        return result.returncode, {}
    package = current_package(development_root(root, default_target(), "packaged-node"))
    return 0, {"ASH_DEV_RUNTIME_ROOT": str(package.resolve())}


def development_binaries(*, platform_name: str | None = None) -> list[str]:
    platform_name = platform_name or sys.platform
    binaries = [
        "ash",
        "ash-app-server",
        "ash-app-server-daemon",
        "ash-code-mode-host",
        "ash-voice-host",
        "ash-livekit-client",
        "ash-realtime-voice",
    ]
    if platform_name.startswith("linux"):
        binaries.append("bwrap")
    return binaries


def build_binaries(
    binaries: list[str], environment: dict[str, str]
) -> tuple[int, dict[str, Path]]:
    local_hosts = {"ash-livekit-client", "ash-realtime-voice", "ash-voice-host"}
    if len(binaries) > 1 and local_hosts.intersection(binaries):
        groups = [[name for name in binaries if name not in local_hosts]]
        groups.extend([name] for name in binaries if name in local_hosts)
        outputs: dict[str, Path] = {}
        for group in groups:
            if not group:
                continue
            status, built = build_binaries(group, environment)
            if status != 0:
                return status, {}
            outputs.update(built)
        return 0, outputs
    target = TARGETS[default_target()]
    build_environment = environment.copy()
    if target.target == "x86_64-pc-windows-msvc":
        build_environment.setdefault(
            "CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER", "rust-lld"
        )
    command = [
        "cargo",
        "build",
        "--locked",
        "--profile",
        DEVELOPMENT_PROFILE,
        "--target-dir",
        str(resolve_cargo_target_directory(REPOSITORY_ROOT, build_environment)),
        "--message-format=json-render-diagnostics",
    ]
    for binary in binaries:
        command.extend(["--package", BINARY_PACKAGES[binary], "--bin", binary])
    if "ash-voice-host" in binaries:
        command.extend(["--features", "ash-voice-host/host"])
    for name in ("ash-livekit-client", "ash-realtime-voice"):
        if name in binaries:
            command.extend(["--features", f"{name}/host"])
    packages = cargo_command_packages("cargo", command[1:], REPOSITORY_ROOT)
    if "ash-app-server-protocol" in packages:
        generate_protocol(root=REPOSITORY_ROOT)
    build_environment = cargo_environment(target, packages, environ=build_environment)
    executables: dict[str, Path] = {}
    # Cargo writes build progress to stderr; keep it on the terminal while
    # reading JSON diagnostics and executable paths from stdout as they arrive.
    with (
        leased_cache(REPOSITORY_ROOT, profile=DEVELOPMENT_PROFILE),
        subprocess.Popen(
            command,
            cwd=REPOSITORY_ROOT,
            env=build_environment,
            stdout=subprocess.PIPE,
            text=True,
        ) as process,
    ):
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


@contextmanager
def stage_runtime(executables: dict[str, Path]):
    """Keep this immutable generation leased for the entire Code launch."""
    with leased_binary_generation(executables, DEVELOPMENT_RUNTIME_ROOT) as staged:
        yield staged


def main() -> int:
    return build_binaries(development_binaries(), os.environ.copy())[0]


if __name__ == "__main__":
    raise SystemExit(main())
