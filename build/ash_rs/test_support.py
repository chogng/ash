"""Complete shared-runtime fixtures for product package tests."""

from __future__ import annotations

import hashlib
from pathlib import Path

from build.lib.targets import target_spec
from build.ash_rs.bubblewrap import BubblewrapResolution
from build.ash_rs.executable import ExecutableResolution
from build.ash_rs.layout import build_package_directory
from build.ash_rs.node import NodeResolution
from build.ash_rs.version import read_workspace_version


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


def create_runtime_package(root: Path, target: str) -> Path:
    spec = target_spec(target)
    inputs = root / "runtime-inputs"
    inputs.mkdir()

    def executable(name: str) -> Path:
        path = inputs / name
        path.write_bytes(name.encode())
        path.chmod(0o755)
        return path

    rg = executable("rg")
    tgrep = executable("tgrep")
    node = executable("node")
    bwrap = executable("bwrap") if spec.is_linux else None
    license_file = inputs / "node-license"
    license_file.write_text("Node test license", encoding="utf-8")
    copying = inputs / "COPYING"
    copying.write_text("Bubblewrap test license", encoding="utf-8")
    runtime = root / "runtime"
    build_package_directory(
        runtime,
        REPOSITORY_ROOT,
        read_workspace_version(REPOSITORY_ROOT / "Cargo.toml"),
        spec,
        executable("ash-app-server"),
        executable("ash-remote"),
        executable("ash-remote-server"),
        executable("ash-exec-server"),
        executable("ash-app-server-daemon"),
        executable("ash-code-mode-host"),
        ExecutableResolution(rg, "test", "local-override", _digest(rg)),
        ExecutableResolution(tgrep, "test", "local-override", _digest(tgrep)),
        NodeResolution(
            node,
            license_file,
            "test",
            "local-override",
            _digest(node),
            "node.zip",
            "a" * 64,
        ),
        BubblewrapResolution(
            bwrap,
            "test",
            _digest(bwrap),
            "bwrap.tar",
            "c" * 64,
            [copying],
            "vendored-source-build",
        )
        if bwrap is not None
        else None,
        windows_sandbox_binary=executable("ash-windows-sandbox")
        if spec.is_windows
        else None,
        voice_host_binary=executable("ash-voice-host"),
        collaboration_server_binary=executable("ash-collaboration-server"),
        livekit={"executable": str(executable("livekit-server"))},
    )
    return runtime


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()
