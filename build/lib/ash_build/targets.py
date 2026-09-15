"""Supported Ash build targets and host target detection."""

import platform
from dataclasses import dataclass
from enum import Enum
from typing import Dict, Optional


class OperatingSystem(Enum):
    MACOS = "darwin"
    LINUX = "linux"
    WINDOWS = "windows"


class CpuArchitecture(Enum):
    ARM64 = "aarch64"
    X86_64 = "x86_64"


class LinuxLibc(Enum):
    GNU = "gnu"
    MUSL = "musl"


class WindowsAbi(Enum):
    MSVC = "msvc"


@dataclass(frozen=True)
class TargetSpec:
    operating_system: OperatingSystem
    architecture: CpuArchitecture
    linux_libc: Optional[LinuxLibc] = None
    windows_abi: Optional[WindowsAbi] = None

    def __post_init__(self) -> None:
        if (self.operating_system == OperatingSystem.LINUX) != (
            self.linux_libc is not None
        ):
            raise ValueError("Linux targets require exactly one libc")
        if (self.operating_system == OperatingSystem.WINDOWS) != (
            self.windows_abi is not None
        ):
            raise ValueError("Windows targets require exactly one ABI")

    @property
    def target(self) -> str:
        if self.operating_system == OperatingSystem.MACOS:
            return f"{self.architecture.value}-apple-darwin"
        if self.operating_system == OperatingSystem.LINUX:
            assert self.linux_libc is not None
            return f"{self.architecture.value}-unknown-linux-{self.linux_libc.value}"
        assert self.windows_abi is not None
        return f"{self.architecture.value}-pc-windows-{self.windows_abi.value}"

    @property
    def is_windows(self) -> bool:
        return self.operating_system == OperatingSystem.WINDOWS

    @property
    def is_linux(self) -> bool:
        return self.operating_system == OperatingSystem.LINUX

    @property
    def executable_suffix(self) -> str:
        return ".exe" if self.is_windows else ""

    @property
    def app_name(self) -> str:
        return "app" + self.executable_suffix

    @property
    def cli_name(self) -> str:
        return "ash" + self.executable_suffix

    @property
    def remote_name(self) -> str:
        return "ash-remote" + self.executable_suffix

    @property
    def remote_server_name(self) -> str:
        return "ash-remote-server" + self.executable_suffix

    @property
    def exec_server_name(self) -> str:
        return "ash-exec-server" + self.executable_suffix

    @property
    def server_name(self) -> str:
        return "ash-app-server" + self.executable_suffix

    @property
    def app_server_daemon_name(self) -> str:
        return "ash-app-server-daemon" + self.executable_suffix

    @property
    def code_mode_host_name(self) -> str:
        return "ash-code-mode-host" + self.executable_suffix

    @property
    def ripgrep_name(self) -> str:
        return "rg" + self.executable_suffix

    @property
    def node_name(self) -> str:
        return "node" + self.executable_suffix


def _target_specs() -> tuple[TargetSpec, ...]:
    return (
        TargetSpec(OperatingSystem.MACOS, CpuArchitecture.ARM64),
        TargetSpec(OperatingSystem.MACOS, CpuArchitecture.X86_64),
        TargetSpec(
            OperatingSystem.LINUX,
            CpuArchitecture.ARM64,
            linux_libc=LinuxLibc.GNU,
        ),
        TargetSpec(
            OperatingSystem.LINUX,
            CpuArchitecture.ARM64,
            linux_libc=LinuxLibc.MUSL,
        ),
        TargetSpec(
            OperatingSystem.LINUX,
            CpuArchitecture.X86_64,
            linux_libc=LinuxLibc.GNU,
        ),
        TargetSpec(
            OperatingSystem.LINUX,
            CpuArchitecture.X86_64,
            linux_libc=LinuxLibc.MUSL,
        ),
        TargetSpec(
            OperatingSystem.WINDOWS,
            CpuArchitecture.ARM64,
            windows_abi=WindowsAbi.MSVC,
        ),
        TargetSpec(
            OperatingSystem.WINDOWS,
            CpuArchitecture.X86_64,
            windows_abi=WindowsAbi.MSVC,
        ),
    )


TARGETS: Dict[str, TargetSpec] = {spec.target: spec for spec in _target_specs()}

HOST_TARGETS = {
    (spec.operating_system.value, spec.architecture.value): spec.target
    for spec in TARGETS.values()
    if spec.linux_libc != LinuxLibc.MUSL
}


def target_spec(target: str) -> TargetSpec:
    spec = TARGETS.get(target)
    if spec is None:
        supported = ", ".join(sorted(TARGETS))
        raise RuntimeError(
            f"Unsupported Ash target {target}. Supported targets: {supported}"
        )
    return spec


def default_target() -> str:
    system = platform.system().lower()
    machine = normalize_machine(platform.machine())
    target = HOST_TARGETS.get((system, machine))
    if target is None:
        supported = ", ".join(sorted(TARGETS))
        raise RuntimeError(
            "Unsupported host platform {}/{}. Pass --target explicitly. "
            "Supported targets: {}".format(
                platform.system(), platform.machine(), supported
            )
        )
    return target


def normalize_machine(machine: str) -> str:
    normalized = machine.lower()
    if normalized in ("arm64", "aarch64"):
        return "aarch64"
    if normalized in ("amd64", "x86_64"):
        return "x86_64"
    return normalized
