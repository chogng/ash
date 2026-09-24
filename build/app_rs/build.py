"""Build a deterministic unsigned app package directory."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Sequence
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from build.lib.targets import TARGETS
from build.lib.targets import target_spec
from build.remote.bundle import RemoteRuntimeBundle
from build.remote.bundle import validate_remote_runtime_bundle
from build.ash_rs.cargo import cargo_environment
from build.lib.cargo import cargo_artifact_executable
from build.lib.cargo import cargo_rendered_diagnostic
from build.lib.cargo import parse_cargo_message
from build.lib.cargo import resolve_cargo_target_directory
from build.ash_rs.layout import copy_uds_notices
from build.ash_rs.layout import copy_windows_sandbox_notices
from build.ash_rs.layout import package_build_id
from build.ash_rs.layout import package_files
from build.ash_rs.layout import validate_package_directory
from build.ash_rs.layout import write_json

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]

APP_ROOT = REPOSITORY_ROOT / "app-rs"


@dataclass(frozen=True)
class RemoteRuntimeNetworkRelease:
    url: str
    catalog_sha256: str


def remote_runtime_network_release(
    url: str, catalog_sha256: str
) -> RemoteRuntimeNetworkRelease:
    try:
        parsed = urlsplit(url)
        hostname = parsed.hostname
        username = parsed.username
        password = parsed.password
    except ValueError as error:
        raise RuntimeError("Remote runtime catalog URL is invalid") from error
    if (
        parsed.scheme != "https"
        or not hostname
        or username
        or password
        or parsed.query
        or parsed.fragment
        or not parsed.path.endswith("/catalog.json")
    ):
        raise RuntimeError(
            "Remote runtime catalog URL must be a credential-free HTTPS catalog.json URL without query or fragment"
        )
    if len(catalog_sha256) != 64 or any(
        character not in "0123456789abcdef" for character in catalog_sha256
    ):
        raise RuntimeError(
            "Remote runtime catalog SHA-256 must be lowercase hexadecimal"
        )
    return RemoteRuntimeNetworkRelease(url, catalog_sha256)


def host_target(cargo: str) -> str:
    result = subprocess.run(
        [cargo, "-vV"],
        check=True,
        capture_output=True,
        text=True,
    )
    for line in result.stdout.splitlines():
        if line.startswith("host:"):
            return line.split(":", 1)[1].strip()
    raise RuntimeError("cargo -vV did not report a host target")


def package_version() -> str:
    manifest = (APP_ROOT / "Cargo.toml").read_text()
    package_section = manifest.split("[package]", 1)[1].split("[", 1)[0]
    for line in package_section.splitlines():
        if line.strip().startswith("version"):
            return line.split('"', 2)[1]
    raise RuntimeError("app-rs/Cargo.toml does not define a package version")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def resolve_binary(
    cargo: str,
    profile: str,
    target: str,
    explicit: Optional[Path],
    remote_runtime_bundle: Optional[RemoteRuntimeBundle],
    remote_runtime_release: Optional[RemoteRuntimeNetworkRelease],
) -> Path:
    if explicit is not None:
        return explicit.expanduser().resolve()

    command = [
        cargo,
        "build",
        "--manifest-path",
        str(APP_ROOT / "Cargo.toml"),
        "--package",
        "app",
        "--bin",
        "app",
        "--locked",
        "--profile",
        profile,
    ]
    target_directory = resolve_cargo_target_directory(REPOSITORY_ROOT)
    command.extend(
        [
            "--target-dir",
            str(target_directory),
            "--message-format",
            "json-render-diagnostics",
        ]
    )
    command.extend(["--target", target])
    environment = cargo_environment(target_spec(target))
    selected_sha256 = (
        remote_runtime_release.catalog_sha256
        if remote_runtime_release is not None
        else remote_runtime_bundle.catalog_sha256
        if remote_runtime_bundle is not None
        else None
    )
    if selected_sha256 is not None:
        environment["APP_REMOTE_RUNTIME_CATALOG_SHA256"] = selected_sha256
    else:
        environment.pop("APP_REMOTE_RUNTIME_CATALOG_SHA256", None)
    if remote_runtime_release is not None:
        environment["APP_REMOTE_RUNTIME_CATALOG_URL"] = remote_runtime_release.url
    else:
        environment.pop("APP_REMOTE_RUNTIME_CATALOG_URL", None)
    result = subprocess.run(
        command,
        check=False,
        capture_output=True,
        env=environment,
        text=True,
    )
    if result.stderr:
        sys.stderr.write(result.stderr)
    executable = None
    for line in result.stdout.splitlines():
        message = parse_cargo_message(line)
        diagnostic = cargo_rendered_diagnostic(message)
        if diagnostic:
            sys.stderr.write(diagnostic)
        executable = cargo_artifact_executable(message, "app") or executable
    if result.returncode != 0:
        raise subprocess.CalledProcessError(
            result.returncode,
            command,
            output=result.stdout,
            stderr=result.stderr,
        )
    if executable is None:
        raise RuntimeError("cargo build did not report the app executable")
    return Path(executable)


def build_package(
    output: Path,
    binary: Path,
    target: str,
    profile: str,
    runtime_package: Path,
    remote_runtime_bundle: Optional[RemoteRuntimeBundle] = None,
    remote_runtime_release: Optional[RemoteRuntimeNetworkRelease] = None,
) -> None:
    spec = target_spec(target)
    if profile != "release":
        raise RuntimeError("app packages require the release Cargo profile")
    runtime_package = runtime_package.expanduser().resolve()
    validate_package_directory(runtime_package, spec)
    runtime_metadata = json.loads(
        (runtime_package / "ash-package.json").read_text(encoding="utf-8")
    )
    if (
        runtime_metadata.get("javascriptRuntime") != {"kind": "packagedNode"}
        or runtime_metadata.get("buildProfile") != "release"
        or "cli" in runtime_metadata["components"]
        or "app" in runtime_metadata["components"]
        or "systemSigning" in runtime_metadata
    ):
        raise RuntimeError("app release requires an unsigned packaged-Node runtime")
    if output.exists():
        raise RuntimeError(f"refusing to replace existing package directory: {output}")
    if (
        remote_runtime_bundle is not None
        and remote_runtime_release is not None
        and remote_runtime_bundle.catalog_sha256
        != remote_runtime_release.catalog_sha256
    ):
        raise RuntimeError(
            "network Remote runtime digest does not match the selected local bundle"
        )
    selected_sha256 = (
        remote_runtime_release.catalog_sha256
        if remote_runtime_release is not None
        else remote_runtime_bundle.catalog_sha256
        if remote_runtime_bundle is not None
        else None
    )
    if remote_runtime_bundle is not None:
        verified_bundle = validate_remote_runtime_bundle(remote_runtime_bundle.root)
        if verified_bundle.catalog_sha256 != remote_runtime_bundle.catalog_sha256:
            raise RuntimeError(
                "Remote runtime catalog changed after product build selection"
            )
    if (
        selected_sha256 is not None
        and selected_sha256.encode() not in binary.read_bytes()
    ):
        raise RuntimeError(
            "app binary does not contain the selected Remote runtime catalog digest"
        )
    if (
        remote_runtime_release is not None
        and remote_runtime_release.url.encode() not in binary.read_bytes()
    ):
        raise RuntimeError(
            "app binary does not contain the selected Remote runtime catalog URL"
        )
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent))
    try:
        shutil.copytree(runtime_package, staging, dirs_exist_ok=True)
        staged_binary = staging / "bin" / spec.app_name
        shutil.copy2(binary, staged_binary)
        if spec.is_windows:
            copy_windows_sandbox_notices(REPOSITORY_ROOT, staging / "licenses")
        copy_uds_notices(REPOSITORY_ROOT, staging / "licenses")
        mxc_license = staging / "licenses" / "mxc"
        mxc_license.mkdir(parents=True)
        shutil.copyfile(
            REPOSITORY_ROOT / "ash-rs/vendor/mxc/LICENSE.md",
            mxc_license / "LICENSE.md",
        )
        if os.name != "nt":
            staged_binary.chmod(staged_binary.stat().st_mode | 0o111)
        shutil.copy2(
            APP_ROOT / "packaging" / "app-signing-policy.json",
            staging / "app-signing-policy.json",
        )
        if remote_runtime_bundle is not None:
            shutil.copytree(
                remote_runtime_bundle.root,
                staging / "ash-remote-runtimes",
            )
        metadata = {
            "formatVersion": 1,
            "product": "app",
            "version": package_version(),
            "target": target,
            "profile": profile,
            "binary": {
                "path": f"bin/{spec.app_name}",
                "sha256": sha256(staged_binary),
            },
            "signing": {
                "status": "unsigned",
                "requiredForRelease": True,
                "policy": "app-signing-policy.json",
            },
        }
        if remote_runtime_release is not None:
            metadata["remoteRuntimeCatalog"] = {
                "url": remote_runtime_release.url,
                "sha256": remote_runtime_release.catalog_sha256,
                "trustBinding": "compiledIntoSignedBinary",
            }
        elif remote_runtime_bundle is not None:
            metadata["remoteRuntimeCatalog"] = {
                "path": "ash-remote-runtimes/catalog.json",
                "sha256": remote_runtime_bundle.catalog_sha256,
                "trustBinding": "compiledIntoSignedBinary",
            }
        (staging / "app-package.json").write_text(json.dumps(metadata, indent=2) + "\n")
        runtime_metadata["components"]["app"] = {
            "source": "cargo-build",
            "binarySha256": sha256(staged_binary),
        }
        runtime_metadata["files"] = package_files(staging)
        identity = {
            key: value
            for key, value in runtime_metadata.items()
            if key not in ("buildId", "files")
        }
        runtime_metadata["buildId"] = package_build_id(
            identity, runtime_metadata["files"]
        )
        write_json(staging / "ash-package.json", runtime_metadata)
        validate_package_directory(staging, spec)
        staging.rename(output)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def main(arguments: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--package-dir", type=Path, required=True)
    parser.add_argument("--runtime-package", type=Path, required=True)
    parser.add_argument("--target", choices=sorted(TARGETS))
    parser.add_argument("--app-bin", type=Path)
    parser.add_argument("--cargo", default="cargo")
    parser.add_argument("--cargo-profile", default="release")
    parser.add_argument("--remote-runtime-bundle", type=Path)
    parser.add_argument("--remote-runtime-catalog-url")
    parser.add_argument("--remote-runtime-catalog-sha256")
    args = parser.parse_args(arguments)

    target = args.target or host_target(args.cargo)
    remote_runtime_bundle = (
        validate_remote_runtime_bundle(args.remote_runtime_bundle)
        if args.remote_runtime_bundle is not None
        else None
    )
    if (args.remote_runtime_catalog_url is None) != (
        args.remote_runtime_catalog_sha256 is None
    ):
        parser.error(
            "--remote-runtime-catalog-url and --remote-runtime-catalog-sha256 are required together"
        )
    remote_runtime_release = (
        remote_runtime_network_release(
            args.remote_runtime_catalog_url,
            args.remote_runtime_catalog_sha256,
        )
        if args.remote_runtime_catalog_url is not None
        else None
    )
    binary = resolve_binary(
        args.cargo,
        args.cargo_profile,
        target,
        args.app_bin,
        remote_runtime_bundle,
        remote_runtime_release,
    )
    binary = binary.expanduser().resolve()
    if not binary.is_file():
        raise RuntimeError(f"app executable does not exist: {binary}")
    output = args.package_dir.expanduser().resolve()
    build_package(
        output,
        binary,
        target,
        args.cargo_profile,
        args.runtime_package,
        remote_runtime_bundle,
        remote_runtime_release,
    )
    print(f"Built app {target} package at {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
