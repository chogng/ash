"""Stage sandbox-enabled rusty_v8 source builds for an independent release."""

from __future__ import annotations

import argparse
import gzip
import json
import os
import platform
import re
import runpy
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import tomllib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from build.download.artifacts import download_and_verify, sha256  # noqa: E402
from build.lib.v8 import LockedFile, load_v8_lock  # noqa: E402


PROFILE = "ptrcomp_sandbox_release"
# Linux ARM64 is cross-built on x64 and executed in a separate workflow job.
# Windows ARM64 and musl ARM64 are link-only here.
BUILD_TARGETS = {
    "aarch64-apple-darwin": ("macos-26", "run"),
    "x86_64-apple-darwin": ("macos-26-intel", "run"),
    "aarch64-unknown-linux-gnu": ("ubuntu-24.04", "link"),
    "x86_64-unknown-linux-gnu": ("ubuntu-24.04", "run"),
    "aarch64-unknown-linux-musl": ("ubuntu-24.04", "link"),
    "x86_64-unknown-linux-musl": ("ubuntu-24.04", "run"),
    "aarch64-pc-windows-msvc": ("windows-2022", "link"),
    "x86_64-pc-windows-msvc": ("windows-2022", "run"),
}

# One target mapping owns both the source producer and the staged-pair smoke
# check. The GNU SDK matches Ash's hermetic Rust/C++ consumer ABI.
BAZEL_PLATFORMS = {
    "aarch64-apple-darwin": "@llvm//platforms:macos_arm64",
    "x86_64-apple-darwin": "@llvm//platforms:macos_amd64",
    "aarch64-unknown-linux-gnu": "@llvm//platforms:linux_arm64_gnu.2.28",
    "x86_64-unknown-linux-gnu": "@llvm//platforms:linux_amd64_gnu.2.28",
    "aarch64-unknown-linux-musl": "//third_party/v8:linux_arm64_musl",
    "x86_64-unknown-linux-musl": "//third_party/v8:linux_amd64_musl",
}
SOURCE_RELEASE_PAIR = "//third_party/v8:rusty_v8_source_release_pair"


def bazel_source_inputs(root: Path) -> dict[str, str]:
    # MODULE pins downloaded V8, ICU, runtime and binding sources. Include the
    # local rules, toolchain patches and config headers that transform them;
    # release verification must use the same graph as every producer job.
    paths = {
        root / name
        for name in (
            ".bazelversion",
            ".bazelrc",
            "BUILD.bazel",
            "MODULE.bazel",
            "MODULE.bazel.lock",
            "build/v8/release.py",
        )
    }
    for directory in ("third_party/v8", "third_party/rules_rs"):
        paths.update(
            path
            for path in (root / directory).rglob("*")
            if path.is_file()
            and (
                path.suffix in {".bazel", ".bzl", ".patch"}
                or "libcxx_config" in path.parts
                or path.name == "libcxx_shared_exception_symbols.txt"
            )
        )
    for path in sorted(paths):
        if b"\r\n" in path.read_bytes():
            # Git normalizes these source inputs to LF. Building CRLF copies
            # first invalidates every dependent C++ action after checkout or
            # commit, even though their preprocessed meaning is unchanged.
            raise ValueError(
                f"V8 source input {path.relative_to(root).as_posix()} uses CRLF; "
                "restore LF line endings before compiling to preserve cache reuse"
            )
    return {path.relative_to(root).as_posix(): sha256(path) for path in sorted(paths)}


def bazel_provenance(target: str, root: Path, host_cpu: str | None = None) -> dict:
    if target not in BAZEL_PLATFORMS:
        raise ValueError("Bazel source producer requires a Linux or macOS target")
    if host_cpu is None:
        host_cpu = {
            "x86_64": "x64",
            "amd64": "x64",
            "aarch64": "arm64",
            "arm64": "arm64",
        }.get(platform.machine().lower())
    if host_cpu not in {"x64", "arm64"}:
        raise ValueError("Bazel source producer requires an x64 or ARM64 host")
    target_cpu = "arm64" if target.startswith("aarch64-") else "x64"
    # The default follows the target platform on a matching host. Keep the
    # local graph/cache in that configuration; cross-builds must tell host
    # mksnapshot explicitly which CPU's code to generate.
    config = "v8-source" if host_cpu == target_cpu else f"v8-source-{target_cpu}"
    return {
        "schemaVersion": 2,
        "target": target,
        "builder": "bazel",
        "version": release_metadata(root)["version"],
        "bazelVersion": (root / ".bazelversion").read_text().strip(),
        "platform": BAZEL_PLATFORMS[target],
        "hostCpu": host_cpu,
        "config": config,
        "pairLabel": SOURCE_RELEASE_PAIR,
        "inputs": bazel_source_inputs(root),
    }


def source_lock(root: Path = ROOT) -> dict:
    lock = json.loads((root / "third_party/v8/source-lock.json").read_text())
    if (
        lock.get("schemaVersion") != 1
        or lock.get("repository") != "https://github.com/denoland/rusty_v8"
        or not re.fullmatch(r"[0-9a-f]{40}", lock.get("revision", ""))
        or not re.fullmatch(r"\d+\.\d+\.\d+", lock.get("rustToolchain", ""))
        or not re.fullmatch(r"llvmorg-[A-Za-z0-9.-]+", lock.get("clangRevision", ""))
    ):
        raise ValueError("Expected an exact rusty_v8 source revision and toolchain")
    return lock


def release_metadata(root: Path = ROOT, tag: str | None = None) -> dict[str, str]:
    lock = json.loads((root / "third_party/v8/runtime-lock.json").read_text())
    pairs = load_v8_lock(root / "third_party/v8/runtime-lock.json")
    version = lock["version"]
    source = source_lock(root)
    manifest = tomllib.loads((root / "Cargo.toml").read_text())
    cargo_lock = tomllib.loads((root / "Cargo.lock").read_text())
    versions = {p["version"] for p in cargo_lock["package"] if p["name"] == "v8"}
    binding_versions = set(
        re.findall(
            r"https://static\.crates\.io/crates/v8/v8-([0-9.]+)\.crate",
            (root / "MODULE.bazel").read_text(),
        )
    )
    if (
        manifest["workspace"]["dependencies"]["v8"] != f"={version}"
        or versions != {version}
        or binding_versions != {version}
        or lock["profile"] != PROFILE
        or source["version"] != version
        or not re.fullmatch(r"\d+\.\d+\.\d+", version)
    ):
        raise ValueError("V8 manifest, Cargo lock and sandbox artifact lock must agree")
    if pairs.keys() != BUILD_TARGETS.keys():
        raise ValueError("V8 release runners must cover every locked target")
    release_tag = f"rusty-v8-v{version}"
    if tag is not None and tag != release_tag:
        raise ValueError(f"Tag {tag} does not match {release_tag}")
    return {
        "version": version,
        "source_revision": source["revision"],
        "release_tag": release_tag,
        "matrix": json.dumps(
            {
                "include": [
                    {"target": target, "runner": runner, "smoke": smoke}
                    for target, (runner, smoke) in BUILD_TARGETS.items()
                ]
            },
            separators=(",", ":"),
        ),
    }


def upstream_toolchain(upstream: Path, version: str, root: Path = ROOT) -> str:
    manifest = tomllib.loads((upstream / "Cargo.toml").read_text())
    if manifest["package"]["name"] != "v8" or manifest["package"]["version"] != version:
        raise ValueError("Upstream checkout does not match the pinned v8 crate")
    toolchain = tomllib.loads((upstream / "rust-toolchain.toml").read_text())
    lock = source_lock(root)
    revision = subprocess.check_output(
        ["git", "-C", str(upstream), "rev-parse", "HEAD"], text=True
    ).strip()
    if (
        revision != lock["revision"]
        or toolchain["toolchain"]["channel"] != lock["rustToolchain"]
    ):
        raise ValueError(
            "Upstream source revision or Rust toolchain differs from source lock"
        )
    status = subprocess.check_output(
        ["git", "-C", str(upstream), "submodule", "status", "--recursive"], text=True
    )
    if any(line.startswith(("-", "+", "U")) for line in status.splitlines()):
        raise ValueError("Upstream submodules must match the pinned source checkout")
    return lock["rustToolchain"]


def prepare_compiler(
    upstream: Path, binding_compiler: Path, root: Path = ROOT
) -> dict[str, str]:
    upstream = upstream.resolve()
    upstream_toolchain(upstream, release_metadata(root)["version"], root)
    update = upstream / "tools/clang/scripts/update.py"
    # --print-revision requires an installed compiler. Read the source pin before
    # downloading, then ask the updater to verify the installed version afterward.
    revision = runpy.run_path(str(update))["PACKAGE_VERSION"]
    if revision != source_lock(root)["clangRevision"]:
        raise ValueError("Upstream Chromium compiler differs from source lock")
    subprocess.run(
        [sys.executable, str(update), "--package", "clang"], check=True, cwd=upstream
    )
    installed = subprocess.check_output(
        [sys.executable, str(update), "--print-revision"], text=True
    ).strip()
    if installed != revision:
        raise ValueError("Installed Chromium compiler differs from source lock")
    compiler = upstream / "third_party/llvm-build/Release+Asserts"
    clang = (
        binding_compiler / "bin" / ("clang.exe" if sys.platform == "win32" else "clang")
    )
    version = subprocess.check_output([str(clang), "--version"], text=True)
    expected = source_lock(root)["bindingCompiler"][sys.platform]["version"]
    if not re.search(rf"\bversion {re.escape(expected)}\b", version):
        raise ValueError("Binding compiler version differs from source lock")
    libraries = [
        path
        for path in binding_compiler.rglob("*clang*")
        if path.name in {"libclang.so", "libclang.dylib", "libclang.dll"}
    ]
    if len(libraries) != 1:
        raise ValueError("Expected one pinned libclang shared library")
    resources = subprocess.check_output(
        [str(clang), "--print-resource-dir"], text=True
    ).strip()
    # Binding names from Clang 23 differ from the crate's expected enum names.
    # Keep its compatible Clang 19 separate from V8's source-pinned C++ compiler.
    (compiler / "ash_binding_compiler_version").write_text(expected, encoding="utf-8")
    return {
        "clang_base_path": str(compiler.resolve()),
        "libclang_path": str(libraries[0].parent.resolve()),
        "bindgen_extra_clang_args": shlex.quote(f"-resource-dir={resources}"),
    }


def checksum_name(target: str) -> str:
    return f"rusty_v8_{PROFILE}_{target}.sha256"


def prepare_gnu_sysroot(target: str, output: Path, root: Path = ROOT) -> dict[str, str]:
    pin = source_lock(root)["gnuSysroots"][target]
    output.mkdir(parents=True, exist_ok=True)
    archive = output / "sysroot.tar.xz"
    artifact = LockedFile(archive.name, pin["sha256"], pin["url"], pin["size"])
    if not archive.is_file() or sha256(archive) != artifact.sha256:
        download_and_verify(artifact, archive, timeout=120)
    cross_arm = target == "aarch64-unknown-linux-gnu"
    sdk = output / "sdk"
    if cross_arm:
        sdk = sdk / "debian_bullseye_arm64-sysroot"
    sdk.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:xz") as contents:
        contents.extractall(sdk, filter="data")
    features = (sdk / "usr/include/features.h").read_text()
    version = ".".join(
        re.search(rf"(?m)^#define\s+{macro}\s+(\d+)\s*$", features)[1]
        for macro in ("__GLIBC__", "__GLIBC_MINOR__")
    )
    if version != pin["glibcVersion"]:
        raise ValueError("GNU sysroot libc version differs from source lock")
    (sdk / ".ash-source-lock-sha256").write_text(artifact.sha256, encoding="utf-8")
    if cross_arm:
        prepare_gnu_sysroot("x86_64-unknown-linux-gnu", output / "host", root)
        host_sdk = (output / "host/sdk").resolve()
        host_link = sdk.parent / "debian_bullseye_amd64-sysroot"
        if not host_link.exists():
            host_link.symlink_to(host_sdk, target_is_directory=True)
        # GN selects a sysroot per toolchain CPU. A global ARM sysroot would
        # also apply to the x64 torque/mksnapshot tools and prevent them linking.
        return {
            "GN_ARGS": f"target_sysroot_dir={json.dumps(str(sdk.parent.resolve()))} use_sysroot=true",
            "RUSTY_V8_GNU_SYSROOT": str(sdk.resolve()),
        }
    # Upstream's target_sysroot is musl-only; an explicit sysroot is safe for x64.
    return {
        "GN_ARGS": f"sysroot={json.dumps(str(sdk.resolve()))} use_sysroot=true",
        "RUSTY_V8_GNU_SYSROOT": str(sdk.resolve()),
    }


def gnu_sysroot_path(gn_args: str, target: str) -> Path:
    if not re.search(r"(?m)^\s*use_sysroot\s*=\s*true\s*$", gn_args):
        raise ValueError("GNU source build must use its pinned sysroot")
    match = re.search(r'(?m)^\s*sysroot\s*=\s*("(?:[^"\\]|\\.)*")\s*$', gn_args)
    if match:
        return Path(json.loads(match[1]))
    directory = re.search(
        r'(?m)^\s*target_sysroot_dir\s*=\s*("(?:[^"\\]|\\.)*")\s*$', gn_args
    )
    if target != "aarch64-unknown-linux-gnu" or not directory:
        raise ValueError("GNU source build must use its pinned sysroot")
    return Path(json.loads(directory[1])) / "debian_bullseye_arm64-sysroot"


def provenance_name(target: str) -> str:
    return f"rusty_v8_{PROFILE}_{target}.build.json"


def validate_gn_args(gn_args: str) -> None:
    flags = {
        "v8_enable_sandbox": "true",
        "v8_enable_pointer_compression": "true",
        "v8_enable_external_code_space": "true",
        "use_custom_libcxx": "true",
        "v8_enable_partition_alloc": "false",
        "is_debug": "false",
    }
    for feature, value in flags.items():
        if not re.search(rf"(?m)^\s*{feature}\s*=\s*{value}\s*$", gn_args):
            raise ValueError(f"Source build must set {feature}={value}")


def stage_pair(
    upstream: Path,
    target: str,
    output: Path,
    root: Path = ROOT,
    *,
    pigz: str | None = None,
    compression_jobs: int = 8,
) -> dict[str, str]:
    metadata = release_metadata(root)
    upstream_toolchain(upstream, metadata["version"], root)
    gn_out = upstream / "target" / target / "release" / "gn_out"
    gn_args = (gn_out / "args.gn").read_text()
    validate_gn_args(gn_args)
    pin = source_lock(root)
    if target.endswith("-linux-gnu"):
        sdk = gnu_sysroot_path(gn_args, target)
        if (sdk / ".ash-source-lock-sha256").read_text().strip() != pin["gnuSysroots"][
            target
        ]["sha256"]:
            raise ValueError("GNU source build sysroot differs from source lock")
    compiler = upstream / "third_party/llvm-build/Release+Asserts"
    if (compiler / "cr_build_revision").read_text().strip() != pin["clangRevision"]:
        raise ValueError("Source build must use the pinned C++ compiler")
    platform = (
        "win32"
        if target.endswith("msvc")
        else "darwin"
        if target.endswith("darwin")
        else "linux"
    )
    if (compiler / "ash_binding_compiler_version").read_text().strip() != pin[
        "bindingCompiler"
    ][platform]["version"]:
        raise ValueError("Source build must use the pinned binding compiler")
    library = (
        gn_out
        / "obj"
        / ("rusty_v8.lib" if target.endswith("msvc") else "librusty_v8.a")
    )
    binding = gn_out / "src_binding.rs"
    return stage_outputs(
        library,
        binding,
        target,
        output,
        {
            "schemaVersion": 2,
            "target": target,
            "builder": "cargo-gn",
            "source": {
                key: pin[key]
                for key in (
                    "version",
                    "repository",
                    "revision",
                    "rustToolchain",
                    "clangRevision",
                    "bindingCompiler",
                    "gnuSysroots",
                )
            },
            "gnArgs": gn_args,
        },
        root,
        pigz=pigz,
        compression_jobs=compression_jobs,
    )


def stage_outputs(
    library: Path,
    binding: Path,
    target: str,
    output: Path,
    provenance: dict,
    root: Path,
    *,
    pigz: str | None = None,
    compression_jobs: int = 8,
) -> dict[str, str]:
    pair = load_v8_lock(root / "third_party/v8/runtime-lock.json")[target]
    for path in (library, binding):
        if not path.is_file() or path.stat().st_size == 0:
            raise ValueError(f"Missing or empty V8 source output: {path}")
    compression = {"tool": "python-gzip", "level": 6}
    if pigz:
        if compression_jobs < 1:
            raise ValueError("Compression jobs must be positive")
        # pigz also reads option strings from these variables. Only the
        # explicit command should control the bytes covered by release digests.
        compressor_environment = {
            key: value
            for key, value in os.environ.items()
            if key not in {"GZIP", "PIGZ"}
        }
        version = subprocess.check_output(
            [pigz, "--version"],
            text=True,
            stderr=subprocess.STDOUT,
            env=compressor_environment,
        ).strip()
        if version != "pigz 2.8":
            raise ValueError("Parallel compression requires pigz 2.8")
        compression = {
            "tool": "pigz",
            "level": 6,
            "version": "2.8",
            "jobs": compression_jobs,
        }
    output.mkdir(parents=True, exist_ok=True)
    archive_path = output / pair.archive.name
    binding_path = output / pair.binding.name
    # Finish compression before replacing any previous pair. A failed external
    # compressor must not truncate an archive covered by existing checksums.
    with tempfile.TemporaryDirectory(prefix=".staging-", dir=output) as temporary:
        staged = Path(temporary)
        archive = staged / archive_path.name
        with library.open("rb") as source, archive.open("wb") as destination:
            if pigz:
                subprocess.run(
                    [pigz, "-n", "-6", "-p", str(compression_jobs), "-c"],
                    stdin=source,
                    stdout=destination,
                    env=compressor_environment,
                    check=True,
                )
            else:
                # Match Codex's compression level; omit names and timestamps so
                # checksums are independent of staging time and output paths.
                with gzip.GzipFile(
                    filename="",
                    fileobj=destination,
                    mode="wb",
                    compresslevel=6,
                    mtime=0,
                ) as compressed:
                    shutil.copyfileobj(source, compressed)
        staged_binding = staged / binding_path.name
        shutil.copyfile(binding, staged_binding)
        (staged / checksum_name(target)).write_text(
            "".join(
                f"{sha256(path)}  {path.name}\n" for path in (archive, staged_binding)
            ),
            encoding="utf-8",
            newline="\n",
        )
        (staged / provenance_name(target)).write_text(
            json.dumps({**provenance, "compression": compression}, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        for path in staged.iterdir():
            path.replace(output / path.name)
    return {
        "archive": str(archive_path.resolve()),
        "binding": str(binding_path.resolve()),
    }


def stage_bazel_pair(
    target: str,
    output: Path,
    root: Path = ROOT,
    bazel: str = "bazel",
    jobs: int | None = None,
    *,
    pigz: str | None = None,
    compression_jobs: int = 8,
) -> dict[str, str]:
    provenance = bazel_provenance(target, root)
    # `info` accepts repository/cache options appended by local Bazel launchers;
    # the special --version startup switch accepts no such build options.
    version = subprocess.check_output(
        [bazel, "info", "release"], cwd=root, text=True
    ).strip()
    if version != f"release {provenance['bazelVersion']}":
        raise ValueError("Bazel version differs from the repository pin")
    options = [
        f"--config={provenance['config']}",
        f"--platforms={provenance['platform']}",
        "--lockfile_mode=error",
    ]
    # Always build before querying. A file at a previous output path is not
    # evidence that it was built with the requested CPU/sandbox configuration.
    subprocess.run(
        [
            bazel,
            "build",
            SOURCE_RELEASE_PAIR,
            *options,
            "--remote_download_toplevel",
            *([f"--jobs={jobs}"] if jobs else []),
        ],
        cwd=root,
        check=True,
    )
    files = subprocess.check_output(
        [bazel, "cquery", SOURCE_RELEASE_PAIR, *options, "--output=files"],
        cwd=root,
        text=True,
    ).splitlines()
    if len(files) != 2 or sorted(Path(path).suffix for path in files) != [".a", ".rs"]:
        raise ValueError(
            "Bazel release pair must contain exactly one archive and binding"
        )
    execroot = Path(
        subprocess.check_output(
            [bazel, "info", "execution_root"],
            cwd=root,
            text=True,
        ).strip()
    )
    paths = [execroot / path for path in files]
    library = next(path for path in paths if path.suffix == ".a")
    binding = next(path for path in paths if path.suffix == ".rs")
    if bazel_source_inputs(root) != provenance["inputs"]:
        raise ValueError("Bazel source inputs changed while building the release pair")
    return stage_outputs(
        library,
        binding,
        target,
        output,
        provenance,
        root,
        pigz=pigz,
        compression_jobs=compression_jobs,
    )


def verify_release(artifacts: Path, repository: str, root: Path = ROOT) -> Path:
    metadata = release_metadata(root)
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("Expected a GitHub owner/repository")
    lock = json.loads((root / "third_party/v8/runtime-lock.json").read_text())
    pairs = load_v8_lock(root / "third_party/v8/runtime-lock.json")
    expected_files = {
        name
        for target, pair in pairs.items()
        for name in (
            pair.archive.name,
            pair.binding.name,
            checksum_name(target),
            provenance_name(target),
        )
    }
    # Validate before writing the candidate lock; extra or missing assets cannot publish.
    if {path.name for path in artifacts.iterdir()} != expected_files:
        raise ValueError(
            "Release must contain exactly one archive, binding, checksum and build provenance per target"
        )
    for target, pair in pairs.items():
        paths = [artifacts / pair.archive.name, artifacts / pair.binding.name]
        for path in paths:
            if not path.is_file() or path.stat().st_size == 0:
                raise ValueError(f"Missing or empty release asset: {path}")
        checksum = "".join(f"{sha256(path)}  {path.name}\n" for path in paths)
        if (artifacts / checksum_name(target)).read_text() != checksum:
            raise ValueError(f"Invalid release checksum for {target}")
        provenance = json.loads((artifacts / provenance_name(target)).read_text())
        compression = provenance.pop("compression", None)
        if compression != {"tool": "python-gzip", "level": 6} and not (
            isinstance(compression, dict)
            and set(compression) == {"tool", "level", "version", "jobs"}
            and compression.get("tool") == "pigz"
            and compression.get("level") == 6
            and compression.get("version") == "2.8"
            and type(compression.get("jobs")) is int
            and compression["jobs"] > 0
        ):
            raise ValueError(f"Invalid compression provenance for {target}")
        if target in BAZEL_PLATFORMS:
            if provenance.get("hostCpu") not in {
                "x64",
                "arm64",
            } or provenance != bazel_provenance(target, root, provenance["hostCpu"]):
                raise ValueError(f"Invalid Bazel source provenance for {target}")
        else:
            validate_upstream_provenance(provenance, target, root)
        for kind, path in zip(("archive", "binding"), paths, strict=True):
            lock["artifacts"][target][kind]["sha256"] = sha256(path)
    lock["source"] = {
        "repository": f"https://github.com/{repository}",
        "release": metadata["release_tag"],
    }
    candidate = artifacts / "runtime-lock.json"
    candidate.write_text(
        json.dumps(lock, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    load_v8_lock(candidate)
    return candidate


def validate_upstream_provenance(provenance: dict, target: str, root: Path) -> None:
    pin = source_lock(root)
    if (
        provenance.get("schemaVersion") != 2
        or provenance.get("target") != target
        or provenance.get("builder") != "cargo-gn"
        or provenance.get("source")
        != {
            key: pin[key]
            for key in (
                "version",
                "repository",
                "revision",
                "rustToolchain",
                "clangRevision",
                "bindingCompiler",
                "gnuSysroots",
            )
        }
    ):
        raise ValueError(f"Invalid source provenance for {target}")
    validate_gn_args(provenance["gnArgs"])


def write_outputs(values: dict[str, str], output: Path | None) -> None:
    print(json.dumps(values))
    if output:
        with output.open("a", encoding="utf-8", newline="\n") as stream:
            for key, value in values.items():
                stream.write(f"{key}={value}\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    metadata = commands.add_parser("metadata")
    metadata.add_argument("--tag")
    metadata.add_argument("--github-output", type=Path)
    upstream = commands.add_parser("upstream-toolchain")
    upstream.add_argument("--upstream", type=Path, required=True)
    upstream.add_argument("--github-output", type=Path)
    compiler = commands.add_parser("compiler")
    compiler.add_argument("--upstream", type=Path, required=True)
    compiler.add_argument("--binding-compiler", type=Path, required=True)
    compiler.add_argument("--github-output", type=Path)
    sysroot = commands.add_parser("gnu-sysroot")
    sysroot.add_argument(
        "--target", choices=source_lock()["gnuSysroots"], required=True
    )
    sysroot.add_argument("--output", type=Path, required=True)
    sysroot.add_argument("--github-env", type=Path)
    stage = commands.add_parser("stage")
    stage.add_argument("--upstream", type=Path, required=True)
    stage.add_argument("--target", choices=BUILD_TARGETS, required=True)
    stage.add_argument("--output", type=Path, required=True)
    stage.add_argument("--github-output", type=Path)
    bazel_stage = commands.add_parser("bazel-stage")
    bazel_stage.add_argument("--target", choices=BAZEL_PLATFORMS, required=True)
    bazel_stage.add_argument("--output", type=Path, required=True)
    bazel_stage.add_argument("--bazel", default="bazel")
    bazel_stage.add_argument("--jobs", type=int)
    bazel_stage.add_argument("--github-output", type=Path)
    for command in (stage, bazel_stage):
        command.add_argument(
            "--pigz", help="Explicit path to pigz 2.8; defaults to Python gzip"
        )
        command.add_argument("--compression-jobs", type=int, default=8)
    verify = commands.add_parser("verify")
    verify.add_argument("--artifacts", type=Path, required=True)
    verify.add_argument("--repository", required=True)
    args = parser.parse_args()
    if args.command == "metadata":
        write_outputs(release_metadata(tag=args.tag), args.github_output)
    elif args.command == "upstream-toolchain":
        write_outputs(
            {
                "toolchain": upstream_toolchain(
                    args.upstream, release_metadata()["version"]
                )
            },
            args.github_output,
        )
    elif args.command == "stage":
        if args.compression_jobs < 1:
            parser.error("--compression-jobs must be positive")
        write_outputs(
            stage_pair(
                args.upstream,
                args.target,
                args.output,
                pigz=args.pigz,
                compression_jobs=args.compression_jobs,
            ),
            args.github_output,
        )
    elif args.command == "bazel-stage":
        if args.jobs is not None and args.jobs < 1:
            parser.error("--jobs must be positive")
        if args.compression_jobs < 1:
            parser.error("--compression-jobs must be positive")
        write_outputs(
            stage_bazel_pair(
                args.target,
                args.output,
                bazel=args.bazel,
                jobs=args.jobs,
                pigz=args.pigz,
                compression_jobs=args.compression_jobs,
            ),
            args.github_output,
        )
    elif args.command == "compiler":
        write_outputs(
            prepare_compiler(args.upstream, args.binding_compiler), args.github_output
        )
    elif args.command == "gnu-sysroot":
        values = prepare_gnu_sysroot(args.target, args.output)
        print(json.dumps(values))
        if args.github_env:
            with args.github_env.open("a", encoding="utf-8", newline="\n") as stream:
                for key, value in values.items():
                    stream.write(f"{key}={value}\n")
    else:
        print(verify_release(args.artifacts, args.repository))


if __name__ == "__main__":
    main()
