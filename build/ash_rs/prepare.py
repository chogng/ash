#!/usr/bin/env python3
"""Build and publish the shared development package."""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from build.download.artifacts import sha256
from build.lib.targets import TARGETS, default_target
from build.ash_rs.bubblewrap import BubblewrapResolution, load_vendored_source
from build.ash_rs.cargo import build_binaries
from build.ash_rs.layout import LAYOUT, build_package_directory, load_protocol_metadata
from build.ash_rs.livekit import resolve_livekit
from build.ash_rs.node import resolve_node
from build.ash_rs.ripgrep import resolve_ripgrep
from build.ash_rs.tgrep import resolve_tgrep
from build.ash_rs.version import read_workspace_version


ROOT = Path(__file__).resolve().parents[2]
PROFILE = "dev-small"
MANIFEST_NAME = re.compile(r"\d{20}\.json\Z")
PACKAGE_DIRECTORY = re.compile(r"packages/[0-9A-Za-z][0-9A-Za-z.+-]*/[a-f0-9]{64}\Z")
BUILD_ENVIRONMENT_VARIABLES = frozenset(
    {
        "AR",
        "CC",
        "CXX",
        "CMAKE",
        "CUDA_HOME",
        "DOCS_RS",
        "INCLUDE",
        "LIB",
        "LIBCLANG_PATH",
        "LK_JETSON_MMAPI_DIR",
        "VCPKG_ROOT",
    }
)
BUILD_ENVIRONMENT_PREFIXES = (
    "AR_",
    "ASH_BUILD_",
    "CARGO_",
    "CC_",
    "CFLAGS",
    "CMAKE_",
    "CXX_",
    "CXXFLAGS",
    "LDFLAGS",
    "OPENSSL_",
    "PKG_CONFIG_",
    "RUST",
    "V8_",
    "VSCMD_",
    "VSINSTALLDIR",
)
BUILD_TOOLS = ("cargo", "rustc", "cl", "link", "cc", "c++", "cmake")


def parse_arguments(arguments: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Publish the shared Ash development package."
    )
    parser.add_argument(
        "--javascript-runtime",
        choices=("host-provided-node", "packaged-node"),
        default="host-provided-node",
    )
    parser.add_argument("--remote-runtime-bundle", type=Path)
    parser.add_argument("--remote-runtime-catalog-url")
    parser.add_argument("--remote-runtime-catalog-sha256")
    args = parser.parse_args(arguments)
    if (args.remote_runtime_catalog_url is None) != (
        args.remote_runtime_catalog_sha256 is None
    ):
        parser.error("Remote runtime catalog URL and SHA-256 must be supplied together")
    if args.remote_runtime_catalog_sha256 is not None:
        if re.fullmatch(r"[a-f0-9]{64}", args.remote_runtime_catalog_sha256) is None:
            parser.error(
                "Remote runtime catalog SHA-256 must be 64 lowercase hex digits"
            )
        validate_catalog_url(args.remote_runtime_catalog_url)
    if args.remote_runtime_bundle is not None:
        args.remote_runtime_bundle = args.remote_runtime_bundle.expanduser().resolve()
    return args


def validate_catalog_url(value: str) -> None:
    url = urlsplit(value)
    if (
        url.scheme != "https"
        or not url.hostname
        or url.username
        or url.password
        or url.query
        or url.fragment
        or not url.path.endswith("/catalog.json")
    ):
        raise ValueError(
            "Remote runtime catalog URL must be a credential-free HTTPS catalog.json URL without query or fragment"
        )


def development_root(root: Path, target: str, javascript_runtime: str) -> Path:
    return root / ".build/runtime/dev/store-v1" / target / javascript_runtime / PROFILE


def current_package(store: Path) -> Path:
    manifests = store / "manifests"
    names = sorted(
        path.name for path in manifests.iterdir() if MANIFEST_NAME.fullmatch(path.name)
    )
    if not names:
        raise RuntimeError(
            f"Ash development package has no published manifest: {manifests}"
        )
    manifest = json.loads((manifests / names[-1]).read_text(encoding="utf-8"))
    sequence = int(names[-1][:20])
    if (
        not isinstance(manifest, dict)
        or manifest.get("formatVersion") != 1
        or manifest.get("sequence") != sequence
        or not isinstance(manifest.get("directory"), str)
        or PACKAGE_DIRECTORY.fullmatch(manifest["directory"]) is None
    ):
        raise RuntimeError(
            f"Invalid Ash development package manifest: {manifests / names[-1]}"
        )
    return store.joinpath(*manifest["directory"].split("/"))


def package_input_digest(paths: list[Path], settings: dict) -> str:
    """Fingerprint file metadata so the launch-time scan does not read source bodies."""
    entries = []

    def collect(path: Path) -> None:
        metadata = path.lstat()
        entries.append(
            (
                str(path),
                str(metadata.st_mode),
                str(metadata.st_size),
                str(metadata.st_mtime_ns),
            )
        )
        if path.is_symlink():
            entries.append(os.readlink(path))
        elif path.is_dir():
            for child in sorted(path.iterdir()):
                collect(child)

    for path in sorted(set(paths)):
        collect(path)
    payload = json.dumps(
        {"settings": settings, "entries": entries}, sort_keys=True, default=str
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def reusable_package(
    cache_path: Path, digest: str, store: Path, *, digest_key: str = "digest"
) -> Path | None:
    """Reuse only the package selected by the latest published manifest."""
    if not cache_path.is_file():
        return None
    try:
        cached = json.loads(cache_path.read_text(encoding="utf-8"))
        package = current_package(store)
    except (FileNotFoundError, json.JSONDecodeError, RuntimeError):
        return None
    if (
        not isinstance(cached, dict)
        or cached.get(digest_key) != digest
        or cached.get("packageRoot") != str(package)
        or not (package / "ash-package.json").is_file()
    ):
        return None
    return package


def record_package_inputs(
    cache_path: Path, digest: str, source_digest: str, package: Path
) -> None:
    """Record both the pre-Cargo source key and the resolved package-input key."""
    temporary = cache_path.with_name(f"{cache_path.name}.partial-{uuid.uuid4()}")
    try:
        temporary.write_text(
            json.dumps(
                {
                    "digest": digest,
                    "sourceDigest": source_digest,
                    "packageRoot": str(package),
                }
            ),
            encoding="utf-8",
        )
        temporary.replace(cache_path)
    finally:
        temporary.unlink(missing_ok=True)


def package_sources(root: Path) -> list[Path]:
    runtime = Path(__file__).parent
    sources = [runtime / "layout.json", root / "Cargo.toml"]
    sources += [
        path
        for path in runtime.glob("*.py")
        if not path.name.startswith("test_") and path.name != "__init__.py"
    ]
    sources += [
        path
        for path in (root / "build/lib").glob("*.py")
        if not path.name.startswith("test_") and path.name != "__init__.py"
    ]
    sources.append(root / "build/download/artifacts.py")
    return sources


def development_source_paths(root: Path) -> list[Path]:
    """Collect Rust workspace and package resources that can invalidate a published package."""
    return package_sources(root) + [
        root / "ash-rs",
        root / "app-rs",
        root / "ash-cli",
        root / "code",
        root / "build/code/update-sign",
        root / "Cargo.lock",
        root / ".cargo",
        root / "rust-toolchain.toml",
        root / "extensions",
        root / "resources",
        # Downloaded archives are pinned by tracked locks and are not source inputs.
        *(path for path in (root / "third_party").iterdir() if path.name != ".cache"),
    ]


def development_build_environment() -> dict:
    """Track output-affecting settings without invalidating on each shell's PATH."""
    environment = {
        name: value
        for name, value in os.environ.items()
        if name in BUILD_ENVIRONMENT_VARIABLES
        or name.startswith(BUILD_ENVIRONMENT_PREFIXES)
    }
    environment["executables"] = {name: shutil.which(name) for name in BUILD_TOOLS}
    return environment


def development_source_digest(
    root: Path, args: argparse.Namespace, target: str, protocol: dict
) -> str:
    """Fast-path key checked before Cargo and runtime archive resolution."""
    paths = development_source_paths(root)
    if args.remote_runtime_bundle:
        paths.append(args.remote_runtime_bundle)
    commit = None
    if (root / ".git").exists():
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=root,
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode == 0:
            commit = result.stdout.strip()
    return package_input_digest(
        paths,
        {
            "javascriptRuntime": args.javascript_runtime,
            "target": target,
            "protocol": protocol,
            "remoteRuntimeCatalogUrl": args.remote_runtime_catalog_url,
            "remoteRuntimeCatalogSha256": args.remote_runtime_catalog_sha256,
            "gitCommit": commit,
            "buildEnvironment": development_build_environment(),
        },
    )


def publish_package(store: Path, package_store: Path, build) -> Path:
    """Stage and publish a complete package through the shared package store."""
    store.mkdir(parents=True, exist_ok=True)
    staging = store / f".next-{uuid.uuid4()}"
    try:
        build(staging)
        result = subprocess.run(
            [
                str(package_store),
                "publish",
                "--root",
                str(store),
                "--staging",
                str(staging),
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=True,
        )
        if result.stderr:
            sys.stderr.write(result.stderr)
        published = json.loads(result.stdout)
        if (
            not isinstance(published.get("packageRoot"), str)
            or type(published.get("sequence")) is not int
            or published["sequence"] <= 0
        ):
            raise RuntimeError(
                "ash-package-store returned an invalid publication result"
            )
        return Path(published["packageRoot"]).resolve()
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def prepare_development_package(args: argparse.Namespace, *, root: Path = ROOT) -> Path:
    """Reuse a current package, then build and publish only when its inputs changed."""
    target = default_target()
    spec = TARGETS[target]
    protocol = load_protocol_metadata(root)
    store = development_root(root, target, args.javascript_runtime)
    cache_path = store / "prepare-inputs.json"
    # This check avoids both Cargo and artifact resolution on an unchanged start.
    source_digest = development_source_digest(root, args, target, protocol)
    existing = reusable_package(
        cache_path, source_digest, store, digest_key="sourceDigest"
    )
    if existing:
        print(
            f"Reused Ash development package ({args.javascript_runtime}) at {existing}"
        )
        return existing
    requested_binaries = {
        "ash-package-store": None,
        "ash-app-server": None,
        "ash-remote": None,
        "ash-remote-server": None,
        "ash-exec-server": None,
        "ash-app-server-daemon": None,
        "ash-code-mode-host": None,
        "ash-voice-host": None,
        "ash-collaboration-server": None,
    }
    if spec.is_windows:
        requested_binaries["ash-windows-sandbox"] = None
    if spec.is_linux:
        requested_binaries["bwrap"] = None
    binaries = build_binaries(
        root,
        spec,
        requested_binaries,
        cargo="cargo",
        cargo_profile=PROFILE,
        host_build=True,
    )
    livekit = {"executable": str(resolve_livekit(target, root=root))}
    ripgrep = resolve_ripgrep(
        spec,
        root / "third_party/ripgrep/runtime-lock.json",
        root / "third_party/.cache/ripgrep",
    )
    tgrep = resolve_tgrep(
        spec,
        root / "third_party/tgrep/runtime-lock.json",
        root / "third_party/.cache/tgrep",
    )
    node = (
        resolve_node(
            spec,
            root / "third_party/node/runtime-lock.json",
            root / "third_party/.cache/node",
        )
        if args.javascript_runtime == "packaged-node"
        else None
    )
    bubblewrap = None
    if spec.is_linux:
        source = load_vendored_source(root / "ash-rs/vendor/bubblewrap")
        executable = binaries["bwrap"]
        bubblewrap = BubblewrapResolution(
            executable,
            source.version,
            sha256(executable),
            source.archive_name,
            source.archive_sha256,
            [source.directory / "COPYING"],
            "vendored-source-build",
        )
    remote_release = (
        {
            "url": args.remote_runtime_catalog_url,
            "sha256": args.remote_runtime_catalog_sha256,
        }
        if args.remote_runtime_catalog_url
        else None
    )
    # The second key checks the resolved binaries and locked runtime assets.
    package_paths = package_sources(root) + [
        root / "ash-rs/app-server-protocol/schema/metadata.json",
        root / "ash-rs/skills/assets",
        root / "extensions",
        root / "resources/product-services",
        *(root / license["source"] for license in LAYOUT["licenses"]),
        *binaries.values(),
        Path(livekit["executable"]),
        ripgrep.executable,
        tgrep.executable,
    ]
    if node:
        package_paths += [node.executable, node.license_file]
    if spec.is_windows:
        package_paths += [
            root / "ash-rs/windows-sandbox/LICENSE-APACHE",
            root / "ash-rs/windows-sandbox/NOTICE",
        ]
    if spec.is_linux:
        package_paths += [root / "ash-rs/vendor/bubblewrap"]
    if args.remote_runtime_bundle:
        package_paths += [args.remote_runtime_bundle]
    package_digest = package_input_digest(
        package_paths,
        {
            "javascriptRuntime": args.javascript_runtime,
            "target": target,
            "protocol": protocol,
            "ripgrep": ripgrep.__dict__,
            "tgrep": tgrep.__dict__,
            "node": node.__dict__ if node else None,
            "remoteRuntimeRelease": remote_release,
        },
    )
    existing = reusable_package(cache_path, package_digest, store)
    if existing:
        record_package_inputs(cache_path, package_digest, source_digest, existing)
        print(
            f"Reused Ash development package ({args.javascript_runtime}) at {existing}"
        )
        return existing

    def build(staging: Path) -> None:
        build_package_directory(
            staging,
            root,
            read_workspace_version(root / "Cargo.toml"),
            spec,
            binaries["ash-app-server"],
            binaries["ash-remote"],
            binaries["ash-remote-server"],
            binaries["ash-exec-server"],
            binaries["ash-app-server-daemon"],
            binaries["ash-code-mode-host"],
            ripgrep,
            tgrep,
            node,
            bubblewrap,
            protocol_metadata=protocol,
            build_profile=PROFILE,
            windows_sandbox_binary=binaries.get("ash-windows-sandbox"),
            voice_host_binary=binaries["ash-voice-host"],
            collaboration_server_binary=binaries["ash-collaboration-server"],
            livekit=livekit,
            remote_runtime_bundle=args.remote_runtime_bundle,
            remote_runtime_release=remote_release,
        )

    package = publish_package(store, binaries["ash-package-store"], build)
    record_package_inputs(cache_path, package_digest, source_digest, package)
    print(f"Prepared Ash development package ({args.javascript_runtime}) at {package}")
    return package


if __name__ == "__main__":
    prepare_development_package(parse_arguments())
