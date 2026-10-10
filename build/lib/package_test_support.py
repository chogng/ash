"""Complete shared-runtime fixtures for product package tests."""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

from build.lib.targets import target_spec
from build.lib.bubblewrap import BubblewrapResolution
from build.lib.executable import ExecutableResolution
from build.lib.package import LAYOUT, build_package_directory
from build.lib.node import NodeResolution
from build.lib.version import read_workspace_version
from build.protocol.artifacts import SOURCE_MANIFEST, artifact_digests, portable_sources


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


def create_package_sources(root: Path) -> Path:
    """Own package resources and a prepared protocol without workspace cache state."""
    root.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(REPOSITORY_ROOT / "Cargo.toml", root / "Cargo.toml")
    for name in ("extensions", "crates/skills/assets", "resources/product-services"):
        shutil.copytree(
            REPOSITORY_ROOT / name,
            root / name,
            ignore=shutil.ignore_patterns("node_modules", "__pycache__"),
        )
    for name in (
        "crates/js-extension-host/src/node.mjs",
        "crates/js-extension-host/src/vscode.js",
        "extension-sdk/index.js",
    ):
        destination = root / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(REPOSITORY_ROOT / name, destination)
    notices = [item["source"] for item in LAYOUT["licenses"]] + [
        "crates/windows-sandbox/LICENSE-APACHE",
        "crates/windows-sandbox/NOTICE",
    ]
    for name in notices:
        destination = root / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(REPOSITORY_ROOT / name, destination)
    protocol = root / "crates/app-server-protocol"
    protocol.mkdir(parents=True)
    (protocol / "Cargo.toml").write_text("[package]\nname = 'fixture-protocol'\n")
    (protocol / "lib.rs").write_text("// Package fixture contract\n")
    directory = root / ".build/protocol"
    metadata = {"major": 1, "schemaHash": "sha256:" + "a" * 64}
    for name, contents in {
        "metadata.json": json.dumps(metadata),
        "json/schema.json": "{}",
        "typescript/index.ts": "export type Fixture = string;\n",
        "typescript/protocol.ts": "export const APP_SERVER_PROTOCOL_MAJOR = 1;\n",
        "typescript/AppServerProtocolDecoder.ts": "export const decoder = {};\n",
    }.items():
        path = directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(contents, encoding="utf-8")
    # Use the real source/artifact fingerprint contract, not a mock of its
    # validation. Tests must still reject stale or tampered prepared inputs.
    manifest = portable_sources(root, [str(protocol)])
    manifest["artifacts"] = artifact_digests(directory)
    (root / ".build" / SOURCE_MANIFEST).write_text(
        json.dumps(manifest), encoding="utf-8"
    )
    return root


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
    sources = create_package_sources(root / "package-sources")
    build_package_directory(
        runtime,
        sources,
        read_workspace_version(REPOSITORY_ROOT / "Cargo.toml"),
        spec,
        executable("ash-app-server"),
        executable("ash-remote"),
        executable("ash-remote-server"),
        executable("ash-exec-server"),
        executable("ash-app-server-daemon"),
        executable("ash-code-mode-host"),
        executable("ash-js-extension-host"),
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
        windows_sandbox_service_binary=executable("ash-windows-sandbox-service")
        if spec.is_windows
        else None,
        remote_host_binary=executable("ash-remote-host"),
        voice_host_binary=executable("ash-voice-host"),
        collaboration_server_binary=executable("ash-collaboration-server"),
        livekit={"executable": str(executable("livekit-server"))},
    )
    return runtime


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()
