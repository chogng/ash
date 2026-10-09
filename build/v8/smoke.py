"""Link staged V8 pairs through Cargo and the existing Bazel consumer graph."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from build.download.artifacts import download_and_verify, sha256  # noqa: E402
from build.lib.v8 import LockedFile, load_v8_lock  # noqa: E402
from build.v8.release import checksum_name, source_lock  # noqa: E402


BAZEL_PLATFORMS = {
    "aarch64-apple-darwin": "@llvm//platforms:macos_arm64",
    "x86_64-apple-darwin": "@llvm//platforms:macos_amd64",
    "aarch64-unknown-linux-gnu": "@llvm//platforms:linux_arm64",
    "x86_64-unknown-linux-gnu": "@llvm//platforms:linux_amd64",
    "aarch64-unknown-linux-musl": "//third_party/v8:linux_arm64_musl",
    "x86_64-unknown-linux-musl": "//third_party/v8:linux_amd64_musl",
}


def prepare_musl_linker(target: str, output: Path, root: Path = ROOT) -> dict[str, str]:
    if target not in BAZEL_PLATFORMS or not target.endswith("-linux-musl"):
        raise ValueError("Expected a supported musl target")
    pin = source_lock(root)["muslLinker"]
    version = pin["version"]
    expected_url = (
        f"https://ziglang.org/download/{version}/zig-x86_64-linux-{version}.tar.xz"
    )
    if pin["url"] != expected_url or len(pin["sha256"]) != 64:
        raise ValueError("Expected a checksum-pinned Zig Linux x64 toolchain")
    output.mkdir(parents=True, exist_ok=True)
    archive = output / "zig.tar.xz"
    artifact = LockedFile(archive.name, pin["sha256"], pin["url"])
    if not archive.is_file() or sha256(archive) != artifact.sha256:
        download_and_verify(artifact, archive, max_bytes=128 * 1024 * 1024, timeout=120)
    # Extraction filters reject traversal, special files and escaping links.
    with tarfile.open(archive, "r:xz") as contents:
        contents.extractall(output, filter="data")
    zig = (output / f"zig-x86_64-linux-{version}" / "zig").resolve()
    actual_version = subprocess.check_output([str(zig), "version"], text=True).strip()
    if actual_version != version:
        raise ValueError("Extracted Zig toolchain version differs from source lock")
    triple = target.replace("-unknown", "")
    wrapper = output / f"{target}-cc"
    wrapper.write_text(
        f'#!/bin/sh\nexec {shlex.quote(str(zig))} cc -target {triple} "$@"\n',
        encoding="utf-8",
        newline="\n",
    )
    wrapper.chmod(0o755)
    prefix = f"CARGO_TARGET_{target.upper().replace('-', '_')}"
    return {
        f"{prefix}_LINKER": str(wrapper.resolve()),
        # Zig supplies musl and its startup objects. Rust's bundled CRT would
        # define _start twice; Zig also supplies compiler-rt for ARM cache flushes.
        f"{prefix}_RUSTFLAGS": "-C link-self-contained=no",
    }


def pair_environment(target: str, artifacts: Path, root: Path = ROOT) -> dict[str, str]:
    pair = load_v8_lock(root / "third_party/v8/runtime-lock.json")[target]
    paths = [(artifacts / item.name).resolve() for item in (pair.archive, pair.binding)]
    expected = "".join(f"{sha256(path)}  {path.name}\n" for path in paths)
    if (artifacts / checksum_name(target)).read_text() != expected:
        raise ValueError("Staged pair failed checksum validation before consumption")
    return {
        "RUSTY_V8_ARCHIVE": str(paths[0]),
        "RUSTY_V8_SRC_BINDING_PATH": str(paths[1]),
    }


def bazel_arguments(
    target: str, artifacts: Path, output: Path, *, run: bool, root: Path = ROOT
) -> list[str]:
    if target not in BAZEL_PLATFORMS:
        # MSVC archives cannot be linked by the registered Windows GNU C++ toolchain.
        raise ValueError("No matching Bazel C++ toolchain for this V8 artifact ABI")
    paths = [
        Path(value) for value in pair_environment(target, artifacts, root).values()
    ]
    arguments = [
        "test" if run else "build",
        "//crates/v8-poc:v8-poc-unit-tests",
        f"--platforms={BAZEL_PLATFORMS[target]}",
        "--lockfile_mode=error",
    ]
    for kind, path in zip(("archive", "binding"), paths, strict=True):
        repository = f"ash_rusty_v8_{target.replace('-', '_')}_{kind}"
        directory = (output / repository).resolve()
        files = directory / "file"
        files.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, files / path.name)
        (directory / "REPO.bazel").write_text("", encoding="utf-8")
        (files / "BUILD.bazel").write_text(
            f'filegroup(name = "file", srcs = ["{path.name}"], visibility = ["//visibility:public"])\n',
            encoding="utf-8",
            newline="\n",
        )
        # Override the two downloaded files, preserving all real consumer rules.
        arguments.append(f"--override_repository={repository}={directory}")
    if run:
        arguments += ["--test_arg=--test-threads=1", "--test_output=errors"]
        if target == "x86_64-unknown-linux-musl":
            arguments.append(
                "--extra_toolchains=//third_party/v8:musl_x64_tests_on_linux_host"
            )
    else:
        # Bazel 9 resolves the test execution toolchain even during `build`.
        # Cross-linking must not require an execution host for the target CPU.
        arguments.append(
            "--@bazel_tools//tools/test:incompatible_use_default_test_toolchain=false"
        )
    return arguments


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    linker = commands.add_parser("musl-linker")
    linker.add_argument("--target", required=True)
    linker.add_argument("--output", type=Path, required=True)
    linker.add_argument("--github-env", type=Path)
    pair = commands.add_parser("pair")
    pair.add_argument("--target", choices=load_v8_lock(), required=True)
    pair.add_argument("--artifacts", type=Path, required=True)
    pair.add_argument("--github-env", type=Path)
    bazel = commands.add_parser("bazel")
    bazel.add_argument("--target", choices=BAZEL_PLATFORMS, required=True)
    bazel.add_argument("--artifacts", type=Path, required=True)
    bazel.add_argument("--output", type=Path, required=True)
    bazel.add_argument("--link-only", action="store_true")
    bazel.add_argument("--bazel", default="bazel")
    args = parser.parse_args()
    if args.command in ("musl-linker", "pair"):
        values = (
            prepare_musl_linker(args.target, args.output)
            if args.command == "musl-linker"
            else pair_environment(args.target, args.artifacts)
        )
        print(json.dumps(values))
        if args.github_env:
            with args.github_env.open("a", encoding="utf-8", newline="\n") as stream:
                for key, value in values.items():
                    stream.write(f"{key}={value}\n")
    else:
        arguments = bazel_arguments(
            args.target, args.artifacts, args.output, run=not args.link_only
        )
        print(shlex.join([args.bazel, *arguments]), flush=True)
        subprocess.run(
            [args.bazel, *arguments], cwd=ROOT, check=True, env=os.environ.copy()
        )


if __name__ == "__main__":
    main()
