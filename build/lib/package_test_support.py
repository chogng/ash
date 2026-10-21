"""Complete shared-runtime fixtures for product package tests."""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

from build.lib.targets import target_spec
from build.lib.bubblewrap import BubblewrapResolution
from build.lib.executable import ExecutableResolution
from build.lib.package import EXTENSION_HOST_RESOURCES, LAYOUT, build_package_directory
from build.lib.node import NodeResolution
from build.lib.version import read_workspace_version
from build.protocol.artifacts import (
    REQUIRED_ARTIFACTS,
    SOURCE_MANIFEST,
    artifact_digests,
    portable_sources,
)


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


def prepare_builtin_fixture(root: Path) -> dict[str, Path]:
    """Stage deterministic resources without compiling scripts or using workspace caches."""
    prepared = root / ".build/builtin"
    publication = {"schemaVersion": 1, "builtIn": [], "user": [], "packageNames": {}}
    packages = {}
    for package in sorted((root / "extensions").iterdir()):
        manifest_path = package / "package.json"
        if not manifest_path.is_file():
            continue
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("ashRuntime", {}).get("client"):
            continue
        snapshot = hashlib.sha256(package.name.encode()).hexdigest()
        destination = prepared / "packages" / snapshot
        excluded = ["node_modules"]
        if manifest.get("ashRuntime", {}).get("kind") == "rust":
            excluded.extend(
                [
                    "Cargo.toml",
                    "Cargo.lock",
                    "build.rs",
                    "BUILD.bazel",
                    "tests",
                    "src",
                    "browser",
                ]
            )
        browser = manifest.get("browser")
        if browser and browser.removeprefix("./").startswith("browser/"):
            excluded.append("browser")
        shutil.copytree(package, destination, ignore=shutil.ignore_patterns(*excluded))
        if browser:
            entry = destination / browser.removeprefix("./")
            entry.parent.mkdir(parents=True, exist_ok=True)
            entry.write_text("export function activate() {}", encoding="utf-8")
        if manifest.get("contributes", {}).get("localizations"):
            catalog = (
                root
                / ".build/desktop/localization/extensions"
                / f"{manifest['publisher']}.{manifest['name']}"
                / "localization"
            )
            shutil.copytree(catalog, destination / "localization")
        publication["builtIn"].append(snapshot)
        publication["packageNames"][snapshot] = package.name
        packages[manifest["name"]] = destination
    (prepared / "current.json").write_text(json.dumps(publication), encoding="utf-8")
    return packages


def create_package_sources(root: Path) -> Path:
    """Own package resources and a prepared protocol without workspace cache state."""
    root.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(REPOSITORY_ROOT / "Cargo.toml", root / "Cargo.toml")
    for source in (
        "livekit-server/runtime.json",
        "crates/livekit-client/src/protocol.rs",
        "crates/realtime-voice/src/recognizer.rs",
    ):
        protocol = root / source
        protocol.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(REPOSITORY_ROOT / source, protocol)
    livekit_lock = root / "third_party/livekit/runtime-lock.json"
    livekit_lock.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(
        REPOSITORY_ROOT / "third_party/livekit/runtime-lock.json", livekit_lock
    )
    for name in (
        "extensions",
        "crates/skills/assets",
        "resources/product-services",
        "build/resources",
    ):
        shutil.copytree(
            REPOSITORY_ROOT / name,
            root / name,
            ignore=shutil.ignore_patterns("node_modules", "__pycache__"),
        )
    for name, _ in EXTENSION_HOST_RESOURCES:
        destination = root / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(REPOSITORY_ROOT / name, destination)
    for package in (root / "extensions").iterdir():
        manifest_path = package / "package.json"
        if not manifest_path.is_file():
            continue
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for language in manifest.get("contributes", {}).get("localizations", []):
            identity = f"{manifest['publisher']}.{manifest['name']}"
            prepared = (
                root
                / ".build/desktop/localization/extensions"
                / identity
                / "localization"
            )
            prepared.mkdir(parents=True, exist_ok=True)
            (prepared / "package.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "locale": language["languageId"],
                        "bundles": {},
                    }
                ),
                encoding="utf-8",
            )
    prepare_builtin_fixture(root)
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
    # Keep the fixture complete as the exported TypeScript contract grows.
    for name in REQUIRED_ARTIFACTS:
        path = directory / name
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("export {};\n", encoding="utf-8")
    # Use the real source/artifact fingerprint contract, not a mock of its
    # validation. Tests must still reject stale or tampered prepared inputs.
    manifest = portable_sources(root, [str(protocol)])
    manifest["artifacts"] = artifact_digests(directory)
    (root / ".build" / SOURCE_MANIFEST).write_text(
        json.dumps(manifest), encoding="utf-8"
    )
    return root


def create_runtime_package(
    root: Path,
    target: str,
    *,
    first_party_binary: Path | None = None,
    symbols_dir: Path | None = None,
    include_js_host: bool = False,
    media_distribution: str = "legacy",
) -> Path:
    spec = target_spec(target)
    inputs = root / "runtime-inputs"
    inputs.mkdir()

    def executable(name: str) -> Path:
        if first_party_binary is not None and name.startswith("ash-"):
            return first_party_binary
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
    copying_lib = inputs / "COPYING.LIB"
    copying_lib.write_text("Bubblewrap library test license", encoding="utf-8")
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
        executable("ash-external-js-ext") if include_js_host else None,
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
            [copying, copying_lib],
            "vendored-source-build",
        )
        if bwrap is not None
        else None,
        remote_ssh_extension_binary=executable("ash-remote-ssh-extension"),
        git_extension_binary=executable("ash-git-extension"),
        markdown_math_binary=executable("ash-markdown-math"),
        markdown_extension_binary=executable("ash-markdown-language-features"),
        github_authentication_binary=executable("ash-github-authentication"),
        github_extension_binary=executable("ash-github-extension"),
        windows_sandbox_binary=executable("ash-windows-sandbox")
        if spec.is_windows
        else None,
        windows_sandbox_service_binary=executable("ash-windows-sandbox-service")
        if spec.is_windows
        else None,
        remote_host_binary=executable("ash-remote-host"),
        voice_host_binary=executable("ash-voice-host")
        if media_distribution in ("legacy", "bundled")
        else None,
        recognizer_binary=executable("ash-realtime-voice")
        if media_distribution == "bundled"
        else None,
        livekit_client_binary=executable("ash-livekit-client")
        if media_distribution == "bundled"
        else None,
        collaboration_server_binary=executable("ash-collab-server"),
        livekit={"executable": str(executable("livekit-server"))}
        if media_distribution == "legacy"
        else None,
        symbols_dir=symbols_dir,
    )
    return runtime


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()
