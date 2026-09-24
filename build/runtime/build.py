#!/usr/bin/env python3
"""Build a canonical Ash package directory."""

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Optional, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from build.lib.targets import TARGETS, default_target

from build.runtime.bubblewrap import resolve_bubblewrap
from build.runtime.cargo import build_binaries
from build.runtime.layout import build_package_directory, load_protocol_metadata
from build.runtime.node import resolve_node
from build.runtime.ripgrep import resolve_ripgrep
from build.runtime.tgrep import resolve_tgrep
from build.runtime.version import read_workspace_version

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


DEFAULT_LOCK = REPOSITORY_ROOT / "third_party" / "ripgrep" / "runtime-lock.json"
DEFAULT_CACHE = REPOSITORY_ROOT / "third_party" / ".cache" / "ripgrep"
DEFAULT_NODE_LOCK = REPOSITORY_ROOT / "third_party" / "node" / "runtime-lock.json"
DEFAULT_NODE_CACHE = REPOSITORY_ROOT / "third_party" / ".cache" / "node"


def parse_arguments(arguments: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Build the canonical Ash package directory with pinned, "
            "checksum-verified runtime executables."
        ),
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--remote-bin", type=Path, help="Prebuilt local Remote management executable."
    )
    parser.add_argument(
        "--remote-server-bin", type=Path, help="Prebuilt remote runtime executable."
    )
    parser.add_argument(
        "--exec-server-bin", type=Path, help="Prebuilt execution service executable."
    )
    parser.add_argument(
        "--windows-sandbox-bin",
        type=Path,
        help="Prebuilt Windows sandbox installation and execution helper.",
    )
    parser.add_argument(
        "--target",
        choices=sorted(TARGETS),
        default=None,
        help="Rust target triple. Defaults to the current host target.",
    )
    parser.add_argument(
        "--package-dir",
        type=Path,
        required=True,
        help="New directory to create as the package root.",
    )
    parser.add_argument(
        "--server-bin",
        type=Path,
        help="Prebuilt product-neutral Ash server executable. If omitted, Cargo builds it.",
    )
    parser.add_argument(
        "--app-server-daemon-bin",
        type=Path,
        help="Prebuilt profile-scoped App Server daemon executable. If omitted, Cargo builds it.",
    )
    parser.add_argument(
        "--code-mode-host-bin",
        type=Path,
        help="Prebuilt isolated Code Mode Host executable. If omitted, Cargo builds it.",
    )
    parser.add_argument(
        "--rg-bin",
        type=Path,
        help="Local ripgrep executable override instead of the locked download.",
    )
    parser.add_argument(
        "--node-bin",
        type=Path,
        help=(
            "Managed Node.js executable override instead of the locked download. "
            "Required for musl targets."
        ),
    )
    parser.add_argument(
        "--javascript-runtime",
        choices=("packaged-node", "host-provided-node"),
        default="packaged-node",
        help=(
            "Package the locked standalone Node runtime, or require a product host "
            "such as Electron to inject an exact Node-compatible executable."
        ),
    )
    parser.add_argument(
        "--bwrap-bin",
        type=Path,
        help=(
            "Prebuilt Linux Bubblewrap executable. If omitted for Linux, "
            "the vendored upstream source is built with Cargo."
        ),
    )
    parser.add_argument(
        "--cargo",
        default="cargo",
        help="Cargo executable used to build first-party package binaries.",
    )
    parser.add_argument(
        "--cargo-profile",
        default="release",
        help="Cargo profile used to build first-party package binaries.",
    )
    parser.add_argument(
        "--ripgrep-lock",
        type=Path,
        default=DEFAULT_LOCK,
        help="Pinned ripgrep runtime lock.",
    )
    parser.add_argument(
        "--cache-root",
        type=Path,
        default=DEFAULT_CACHE,
        help="Verified ripgrep download and extraction cache.",
    )
    parser.add_argument(
        "--node-lock",
        type=Path,
        default=DEFAULT_NODE_LOCK,
        help="Pinned Node.js runtime lock.",
    )
    parser.add_argument(
        "--node-cache-root",
        type=Path,
        default=DEFAULT_NODE_CACHE,
        help="Verified Node.js download and extraction cache.",
    )
    parser.add_argument("--tgrep-bin", type=Path)
    parser.add_argument(
        "--tgrep-lock",
        type=Path,
        default=REPOSITORY_ROOT / "third_party/tgrep/runtime-lock.json",
    )
    parser.add_argument(
        "--tgrep-cache-root",
        type=Path,
        default=REPOSITORY_ROOT / "third_party/.cache/tgrep",
    )
    return parser.parse_args(arguments)


def main(arguments: Optional[Sequence[str]] = None) -> int:
    args = parse_arguments(arguments)
    target = args.target or default_target()
    spec = TARGETS[target]
    protocol_metadata = load_protocol_metadata(REPOSITORY_ROOT)
    inputs = {
        "ash-voice-host": None,
        "ash-collaboration-server": None,
        "ash-app-server": args.server_bin,
        "ash-app-server-daemon": args.app_server_daemon_bin,
        "ash-code-mode-host": args.code_mode_host_bin,
        "ash-remote": args.remote_bin,
        "ash-remote-server": args.remote_server_bin,
        "ash-exec-server": args.exec_server_bin,
    }
    if spec.is_windows:
        inputs["ash-windows-sandbox"] = args.windows_sandbox_bin
    elif args.windows_sandbox_bin is not None:
        raise RuntimeError("Windows sandbox executable requires a Windows target")
    binaries = build_binaries(
        REPOSITORY_ROOT,
        spec,
        inputs,
        cargo=args.cargo,
        cargo_profile=args.cargo_profile,
    )
    ripgrep = resolve_ripgrep(
        spec,
        args.ripgrep_lock.expanduser().resolve(),
        args.cache_root.expanduser().resolve(),
        explicit_binary=args.rg_bin,
    )
    if args.javascript_runtime == "host-provided-node" and args.node_bin is not None:
        raise RuntimeError(
            "--node-bin cannot be used with --javascript-runtime host-provided-node"
        )
    tgrep = resolve_tgrep(spec, args.tgrep_lock, args.tgrep_cache_root, args.tgrep_bin)
    node = (
        resolve_node(
            spec,
            args.node_lock.expanduser().resolve(),
            args.node_cache_root.expanduser().resolve(),
            explicit_binary=args.node_bin,
        )
        if args.javascript_runtime == "packaged-node"
        else None
    )
    bubblewrap = resolve_bubblewrap(
        REPOSITORY_ROOT,
        spec,
        explicit_binary=args.bwrap_bin,
        cargo=args.cargo,
        cargo_profile=args.cargo_profile,
    )
    livekit = json.loads(
        subprocess.check_output(
            ["node", str(REPOSITORY_ROOT / "build/runtime/livekit.ts"), spec.target],
            text=True,
        ).splitlines()[-1]
    )
    version = read_workspace_version(REPOSITORY_ROOT / "Cargo.toml")
    output = args.package_dir.expanduser().resolve()
    build_package_directory(
        output,
        REPOSITORY_ROOT,
        version,
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
        livekit=livekit,
        voice_host_binary=binaries["ash-voice-host"],
        collaboration_server_binary=binaries["ash-collaboration-server"],
        protocol_metadata=protocol_metadata,
        build_profile=args.cargo_profile,
        windows_sandbox_binary=binaries["ash-windows-sandbox"]
        if spec.is_windows
        else None,
    )
    print("Built Ash {} package at {}".format(target, output))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
