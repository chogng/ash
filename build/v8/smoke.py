"""Link staged V8 pairs through Cargo and the existing Bazel consumer graph."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from build.download.artifacts import (  # noqa: E402
    download_and_verify,
    sha256,
    temporary_file,
)
from build.lib.file_lock import exclusive_lock  # noqa: E402
from build.lib.v8 import LockedFile, load_v8_lock  # noqa: E402
from build.v8.release import BAZEL_PLATFORMS, checksum_name, source_lock  # noqa: E402


def toolchain_digest(directory: Path) -> str:
    """Detect incomplete or changed extracted inputs before reusing the compiler."""
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("Expected a regular Zig toolchain directory")
    digest = hashlib.sha256()
    for path in sorted(directory.rglob("*")):
        mode = path.lstat().st_mode
        if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
            raise ValueError("Zig toolchain contains a link or special file")
        digest.update(
            json.dumps([path.relative_to(directory).as_posix(), mode]).encode() + b"\n"
        )
        if stat.S_ISREG(mode):
            digest.update(bytes.fromhex(sha256(path)))
    return digest.hexdigest()


def prepare_zig_toolchain(output: Path, pin: dict) -> Path:
    version = pin["version"]
    # Exported linker paths may still be in use after preparation returns.
    # A new pin gets its own directory instead of replacing an active compiler.
    legacy_archive = output / "zig.tar.xz"
    output = output / pin["sha256"]
    output.mkdir(parents=True, exist_ok=True)
    directory = output / f"zig-x86_64-linux-{version}"
    archive = output / "zig.tar.xz"
    stamp = output / ".zig-extraction.json"
    artifact = LockedFile(archive.name, pin["sha256"], pin["url"])
    # Parallel consumers share this cache. Publish only a complete extraction;
    # a failed or interrupted preparation leaves no reusable completion stamp.
    with exclusive_lock(output / ".zig-extraction.lock", create=True):
        if (
            not archive.exists()
            and legacy_archive.is_file()
            and sha256(legacy_archive) == artifact.sha256
        ):
            shutil.copyfile(legacy_archive, archive)
        if not archive.is_file() or sha256(archive) != artifact.sha256:
            download_and_verify(
                artifact, archive, max_bytes=128 * 1024 * 1024, timeout=120
            )
        try:
            reusable = json.loads(stamp.read_text()) == {
                "archiveSha256": artifact.sha256,
                "treeSha256": toolchain_digest(directory),
            }
        except (OSError, ValueError):
            reusable = False
        if not reusable:
            with tempfile.TemporaryDirectory(
                prefix=".zig-extract-", dir=output
            ) as work:
                temporary = Path(work)
                # Reject traversal, special files and escaping links during extraction.
                with tarfile.open(archive, "r:xz") as contents:
                    contents.extractall(temporary, filter="data")
                extracted = temporary / directory.name
                zig = extracted / "zig"
                actual_version = subprocess.check_output(
                    [str(zig), "version"], text=True
                ).strip()
                if actual_version != version:
                    raise ValueError(
                        "Extracted Zig toolchain version differs from source lock"
                    )
                record = {
                    "archiveSha256": artifact.sha256,
                    "treeSha256": toolchain_digest(extracted),
                }
                previous = temporary / "previous"
                if directory.exists() or directory.is_symlink():
                    directory.rename(previous)
                try:
                    extracted.rename(directory)
                except OSError:
                    if previous.exists() or previous.is_symlink():
                        previous.rename(directory)
                    raise
                with temporary_file(stamp) as staged:
                    staged.write_text(json.dumps(record) + "\n", encoding="utf-8")
                    staged.replace(stamp)
        else:
            actual_version = subprocess.check_output(
                [str(directory / "zig"), "version"], text=True
            ).strip()
            if actual_version != version:
                raise ValueError(
                    "Cached Zig toolchain version differs from source lock"
                )
    return (directory / "zig").resolve()


def prepare_musl_linker(target: str, output: Path, root: Path = ROOT) -> dict[str, str]:
    if target not in BAZEL_PLATFORMS or not target.endswith("-linux-musl"):
        raise ValueError("Expected a supported musl target")
    pin = source_lock(root)["muslLinker"]
    version = pin["version"]
    expected_url = (
        f"https://ziglang.org/download/{version}/zig-x86_64-linux-{version}.tar.xz"
    )
    if (
        pin["url"] != expected_url
        or re.fullmatch(r"[0-9a-f]{64}", pin["sha256"]) is None
    ):
        raise ValueError("Expected a checksum-pinned Zig Linux x64 toolchain")
    output.mkdir(parents=True, exist_ok=True)
    zig = prepare_zig_toolchain(output, pin)
    output = zig.parent.parent
    triple = target.replace("-unknown", "")
    if target == "aarch64-unknown-linux-musl":
        # Zig's cc frontend rejects Rust's Cortex-A53 workaround. Its bundled
        # GNU LLD accepts it; raw linker flavor needs the workaround explicitly.
        # Rust owns the musl CRT. Build only the missing instruction-cache helper
        # from the same checksum-pinned toolchain, leaving other builtins to Rust.
        builtins = (output / f"{target}-clear-cache.a").resolve()
        subprocess.run(
            [
                str(zig),
                "build-lib",
                str(zig.parent / "lib/compiler_rt/clear_cache.zig"),
                "-target",
                triple,
                "-O",
                "ReleaseFast",
                "-fno-compiler-rt",
                f"-femit-bin={builtins}",
            ],
            check=True,
        )
        wrapper = output / f"{target}-ld"
        command = (
            f'{shlex.quote(str(zig))} ld.lld --fix-cortex-a53-843419 "$@" '
            f"{shlex.quote(str(builtins))}"
        )
        rustflags = "-C linker-flavor=ld -C link-self-contained=yes"
    else:
        wrapper = output / f"{target}-cc"
        command = f'{shlex.quote(str(zig))} cc -target {triple} "$@"'
        # Zig owns musl's startup objects; Rust's bundled CRT would define _start twice.
        rustflags = "-C link-self-contained=no"
    wrapper.write_text(
        f"#!/bin/sh\nexec {command}\n",
        encoding="utf-8",
        newline="\n",
    )
    wrapper.chmod(0o755)
    prefix = f"CARGO_TARGET_{target.upper().replace('-', '_')}"
    return {
        f"{prefix}_LINKER": str(wrapper.resolve()),
        f"{prefix}_RUSTFLAGS": rustflags,
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
        # A local user.bazelrc may prefer source builds. This check must consume
        # the staged release files through the actual prebuilt consumer path.
        "--//:rusty_v8_from_source=False",
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
