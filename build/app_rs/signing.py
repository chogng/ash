"""Shared signing and verification logic for staged app packages."""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from build.lib.targets import TargetSpec
from build.lib.targets import target_spec
from build.remote.bundle import RemoteRuntimeBundle
from build.remote.bundle import validate_remote_runtime_bundle
from build.linux import signing as linux
from build.lib.signing import run_command
from build.lib.signing import sha256
from build.lib.signing import sign_command as system_sign_command
from build.lib.signing import verify_command as system_verify_command
from build.runtime.layout import package_build_id
from build.runtime.layout import package_files
from build.runtime.layout import system_signing_artifacts
from build.runtime.layout import validate_package_directory
from build.runtime.layout import write_json as write_runtime_json

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


CommandRunner = Callable[[Sequence[str]], None]


@dataclass(frozen=True)
class AuthenticatedRemoteRuntimeCatalog:
    sha256: str
    url: Optional[str]
    bundle: Optional[RemoteRuntimeBundle]


def load_json(path: Path) -> Dict[str, object]:
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"could not read JSON file {path}: {error}") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"expected a JSON object in {path}")
    return value


def write_json(path: Path, value: Dict[str, object]) -> None:
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    os.replace(temporary, path)


def refresh_runtime_metadata(package_dir: Path, spec: TargetSpec) -> None:
    path = package_dir / "ash-package.json"
    metadata = load_json(path)
    components = metadata.get("components")
    if not isinstance(components, dict) or not isinstance(components.get("app"), dict):
        raise RuntimeError("app package is missing its shared runtime component")
    components["app"]["binarySha256"] = sha256(package_dir / "bin" / spec.app_name)
    for name, artifact in system_signing_artifacts(package_dir, spec).items():
        component = components.get(name)
        if not isinstance(component, dict):
            raise RuntimeError(f"app package is missing the {name} component")
        component["binarySha256"] = sha256(artifact)
    files = package_files(package_dir)
    identity = {
        key: value for key, value in metadata.items() if key not in ("buildId", "files")
    }
    metadata["files"] = files
    metadata["buildId"] = package_build_id(identity, files)
    write_runtime_json(path, metadata)
    validate_package_directory(package_dir, spec)


def package_context(package_dir: Path) -> Dict[str, object]:
    package_dir = package_dir.expanduser().resolve()
    metadata_path = package_dir / "app-package.json"
    metadata = load_json(metadata_path)
    signing = metadata.get("signing")
    binary = metadata.get("binary")
    target = metadata.get("target")
    if not isinstance(signing, dict) or not isinstance(binary, dict):
        raise RuntimeError(f"invalid app package metadata: {metadata_path}")
    if not isinstance(target, str):
        raise RuntimeError(f"app package metadata has no target: {metadata_path}")
    spec = target_spec(target)

    binary_path = binary.get("path")
    policy_name = signing.get("policy")
    record_name = signing.get("signatureRecord", "app-signature.json")
    if not isinstance(binary_path, str) or not isinstance(policy_name, str):
        raise RuntimeError(f"invalid binary or policy path in {metadata_path}")
    if not isinstance(record_name, str):
        raise RuntimeError(f"invalid signature record path in {metadata_path}")
    expected_binary_path = f"bin/{spec.app_name}"
    if binary_path != expected_binary_path:
        raise RuntimeError(
            f"app package target {target} requires binary path {expected_binary_path}"
        )

    artifact = (package_dir / binary_path).resolve()
    policy_path = (package_dir / policy_name).resolve()
    record_path = (package_dir / record_name).resolve()
    for path, label in (
        (artifact, "binary"),
        (policy_path, "policy"),
        (record_path, "signature record"),
    ):
        try:
            path.relative_to(package_dir)
        except ValueError as error:
            raise RuntimeError(
                f"{label} path escapes package directory: {path}"
            ) from error

    if not artifact.is_file():
        raise RuntimeError(f"app executable does not exist: {artifact}")
    if not policy_path.is_file():
        raise RuntimeError(f"signing policy does not exist: {policy_path}")

    policy = load_json(policy_path)
    platforms = policy.get("platforms")
    if not isinstance(platforms, dict):
        raise RuntimeError(f"signing policy has no platform map: {policy_path}")

    remote_runtime_catalog = authenticated_remote_runtime_catalog(
        package_dir, metadata, artifact
    )

    return {
        "package_dir": package_dir,
        "metadata_path": metadata_path,
        "metadata": metadata,
        "binary": binary,
        "artifact": artifact,
        "policy": policy,
        "platforms": platforms,
        "record_path": record_path,
        "remote_runtime_catalog": remote_runtime_catalog,
        "target_spec": spec,
    }


def authenticated_remote_runtime_catalog(
    package_dir: Path,
    metadata: Dict[str, object],
    artifact: Path,
) -> Optional[AuthenticatedRemoteRuntimeCatalog]:
    value = metadata.get("remoteRuntimeCatalog")
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) not in (
        {"path", "sha256", "trustBinding"},
        {"url", "sha256", "trustBinding"},
    ):
        raise RuntimeError("invalid Remote runtime catalog binding in app-package.json")
    expected_sha256 = value.get("sha256")
    if (
        not isinstance(expected_sha256, str)
        or len(expected_sha256) != 64
        or any(character not in "0123456789abcdef" for character in expected_sha256)
    ):
        raise RuntimeError("invalid Remote runtime catalog digest")
    if value.get("trustBinding") != "compiledIntoSignedBinary":
        raise RuntimeError("unsupported Remote runtime catalog trust binding")
    if expected_sha256.encode() not in artifact.read_bytes():
        raise RuntimeError(
            "signed app binary does not contain the Remote runtime catalog digest"
        )
    url = value.get("url")
    if isinstance(url, str):
        try:
            parsed = urlsplit(url)
            hostname = parsed.hostname
            username = parsed.username
            password = parsed.password
        except ValueError as error:
            raise RuntimeError("invalid network Remote runtime catalog URL") from error
        if (
            parsed.scheme != "https"
            or not hostname
            or username
            or password
            or parsed.query
            or parsed.fragment
            or not parsed.path.endswith("/catalog.json")
        ):
            raise RuntimeError("invalid network Remote runtime catalog URL")
        if url.encode() not in artifact.read_bytes():
            raise RuntimeError(
                "signed app binary does not contain the Remote runtime catalog URL"
            )
        return AuthenticatedRemoteRuntimeCatalog(expected_sha256, url, None)
    path = value.get("path")
    if not isinstance(path, str):
        raise RuntimeError("invalid Remote runtime catalog path")
    catalog = (package_dir / path).resolve()
    try:
        catalog.relative_to(package_dir)
    except ValueError as error:
        raise RuntimeError(
            f"Remote runtime catalog path escapes package: {catalog}"
        ) from error
    if catalog.name != "catalog.json":
        raise RuntimeError("Remote runtime catalog binding must name catalog.json")
    bundle = validate_remote_runtime_bundle(catalog.parent)
    if bundle.catalog_sha256 != expected_sha256:
        raise RuntimeError(
            "bundled Remote runtime catalog digest does not match package metadata"
        )
    return AuthenticatedRemoteRuntimeCatalog(expected_sha256, None, bundle)


def signing_platform(context: Dict[str, object]) -> str:
    spec = context["target_spec"]
    assert isinstance(spec, TargetSpec)
    return spec.operating_system.value


def platform_config(context: Dict[str, object]) -> Dict[str, object]:
    platform = signing_platform(context)
    platforms = context["platforms"]
    assert isinstance(platforms, dict)
    config = platforms.get(platform)
    if not isinstance(config, dict):
        raise RuntimeError(f"signing policy has no {platform} configuration")
    tool = config.get("tool")
    identity_environment = config.get("identityEnvironment")
    signature_mode = config.get("signatureMode")
    if not isinstance(tool, str) or not isinstance(identity_environment, str):
        raise RuntimeError(f"incomplete {platform} signing policy")
    if signature_mode not in {"embedded", "detached"}:
        raise RuntimeError(f"invalid {platform} signature mode: {signature_mode}")
    if signature_mode == "detached" and not isinstance(
        config.get("signatureFile"), str
    ):
        raise RuntimeError(f"detached {platform} signing requires signatureFile")
    return config


def signature_path(
    context: Dict[str, object], config: Dict[str, object]
) -> Optional[Path]:
    if config.get("signatureMode") != "detached":
        return None
    package_dir = context["package_dir"]
    assert isinstance(package_dir, Path)
    value = config.get("signatureFile")
    assert isinstance(value, str)
    path = (package_dir / value).resolve()
    try:
        path.relative_to(package_dir)
    except ValueError as error:
        raise RuntimeError(
            f"signature path escapes package directory: {path}"
        ) from error
    return path


def identity_for(config: Dict[str, object]) -> str:
    environment = config["identityEnvironment"]
    assert isinstance(environment, str)
    identity = os.environ.get(environment)
    if not identity:
        raise RuntimeError(
            f"release signing requires environment variable {environment}"
        )
    return identity


def sign_command(
    context: Dict[str, object],
    config: Dict[str, object],
    platform: str,
    identity: str,
) -> List[str]:
    tool = config["tool"]
    assert isinstance(tool, str)
    artifact = context["artifact"]
    assert isinstance(artifact, Path)
    if platform in {"darwin", "windows"}:
        return system_sign_command(artifact, platform)
    if platform == "linux":
        signature = signature_path(context, config)
        assert signature is not None
        return linux.sign_command(artifact, signature, identity, tool)

    raise RuntimeError(f"unsupported app signing platform: {platform}")


def verify_command(
    context: Dict[str, object],
    config: Dict[str, object],
    platform: str,
) -> List[str]:
    tool = config["tool"]
    assert isinstance(tool, str)
    artifact = context["artifact"]
    assert isinstance(artifact, Path)
    if platform in {"darwin", "windows"}:
        return system_verify_command(artifact, platform)
    if platform == "linux":
        signature = signature_path(context, config)
        assert signature is not None
        return linux.verify_command(artifact, signature, identity_for(config), tool)
    raise RuntimeError(f"unsupported app signing platform: {platform}")


def _metadata_digest(context: Dict[str, object]) -> str:
    binary = context["binary"]
    assert isinstance(binary, dict)
    value = binary.get("sha256")
    if not isinstance(value, str) or len(value) != 64:
        raise RuntimeError("app package metadata has no valid binary sha256")
    return value


def sign_package(
    package_dir: Path,
    runner: Optional[CommandRunner] = None,
) -> Dict[str, object]:
    context = package_context(package_dir)
    platform = signing_platform(context)
    config = platform_config(context)
    metadata = context["metadata"]
    assert isinstance(metadata, dict)
    signing = metadata["signing"]
    assert isinstance(signing, dict)
    if signing.get("status") != "unsigned":
        raise RuntimeError(
            f"package is not unsigned; refusing to sign status={signing.get('status')}"
        )

    artifact = context["artifact"]
    assert isinstance(artifact, Path)
    unsigned_digest = _metadata_digest(context)
    actual_digest = sha256(artifact)
    if actual_digest != unsigned_digest:
        raise RuntimeError("staged binary digest does not match app-package.json")
    validate_package_directory(context["package_dir"], context["target_spec"])

    detached_signature = signature_path(context, config)
    if detached_signature is not None and detached_signature.exists():
        raise RuntimeError(
            f"refusing to replace existing signature: {detached_signature}"
        )

    run_command(sign_command(context, config, platform, identity_for(config)), runner)
    if detached_signature is not None and not detached_signature.is_file():
        raise RuntimeError(
            f"signing tool did not create signature: {detached_signature}"
        )

    signed_digest = sha256(artifact)
    record = {
        "formatVersion": 1,
        "product": "app",
        "platform": platform,
        "tool": config["tool"],
        "artifact": metadata["binary"]["path"],
        "unsignedSha256": unsigned_digest,
        "signedSha256": signed_digest,
        "status": "signed",
    }
    remote_runtime_catalog = context["remote_runtime_catalog"]
    if remote_runtime_catalog is not None:
        assert isinstance(remote_runtime_catalog, AuthenticatedRemoteRuntimeCatalog)
        record["remoteRuntimeCatalogSha256"] = remote_runtime_catalog.sha256
    if detached_signature is not None:
        record["signatureFile"] = str(
            detached_signature.relative_to(context["package_dir"])
        )

    binary = metadata["binary"]
    assert isinstance(binary, dict)
    binary["sha256"] = signed_digest
    signing["status"] = "signed"
    signing["unsignedSha256"] = unsigned_digest
    signing["signedSha256"] = signed_digest
    signing["signatureRecord"] = str(
        context["record_path"].relative_to(context["package_dir"])
    )
    write_json(context["record_path"], record)
    write_json(context["metadata_path"], metadata)
    refresh_runtime_metadata(context["package_dir"], context["target_spec"])
    return record


def verify_package(
    package_dir: Path,
    runner: Optional[CommandRunner] = None,
) -> Dict[str, object]:
    context = package_context(package_dir)
    platform = signing_platform(context)
    config = platform_config(context)
    metadata = context["metadata"]
    assert isinstance(metadata, dict)
    signing = metadata["signing"]
    assert isinstance(signing, dict)
    if signing.get("status") not in {"signed", "verified"}:
        raise RuntimeError("package must be signed before verification")

    artifact = context["artifact"]
    assert isinstance(artifact, Path)
    digest = sha256(artifact)
    if digest != _metadata_digest(context):
        raise RuntimeError("signed binary digest does not match app-package.json")
    validate_package_directory(context["package_dir"], context["target_spec"])
    record_path = context["record_path"]
    if not record_path.is_file():
        raise RuntimeError(f"signature record does not exist: {record_path}")
    record = load_json(record_path)
    if record.get("platform") != platform or record.get("status") not in {
        "signed",
        "verified",
    }:
        raise RuntimeError(
            "signature record does not match the requested platform or state"
        )
    if record.get("signedSha256") != digest:
        raise RuntimeError("signature record digest does not match the staged binary")
    remote_runtime_catalog = context["remote_runtime_catalog"]
    if remote_runtime_catalog is not None:
        assert isinstance(remote_runtime_catalog, AuthenticatedRemoteRuntimeCatalog)
        if record.get("remoteRuntimeCatalogSha256") != remote_runtime_catalog.sha256:
            raise RuntimeError(
                "signature record does not bind the Remote runtime catalog"
            )

    detached_signature = signature_path(context, config)
    if detached_signature is not None and not detached_signature.is_file():
        raise RuntimeError(f"signature file does not exist: {detached_signature}")

    run_command(verify_command(context, config, platform), runner)
    record["status"] = "verified"
    record["verifiedSha256"] = digest
    signing["status"] = "verified"
    signing["verifiedSha256"] = digest
    write_json(record_path, record)
    write_json(context["metadata_path"], metadata)
    refresh_runtime_metadata(context["package_dir"], context["target_spec"])
    return record


def record_verified_package(
    package_dir: Path,
    runner: Optional[CommandRunner] = None,
) -> Dict[str, object]:
    """Verify a signature applied by a managed service and refresh package metadata."""
    context = package_context(package_dir)
    platform = signing_platform(context)
    if platform not in {"darwin", "windows"}:
        raise RuntimeError("managed signing is supported only for macOS and Windows")
    config = platform_config(context)
    metadata = context["metadata"]
    assert isinstance(metadata, dict)
    signing = metadata["signing"]
    assert isinstance(signing, dict)
    if signing.get("status") != "unsigned":
        raise RuntimeError("managed signing requires an unsigned package record")
    artifact = context["artifact"]
    assert isinstance(artifact, Path)
    unsigned_digest = _metadata_digest(context)
    run_command(verify_command(context, config, platform), runner)
    signed_digest = sha256(artifact)
    record = {
        "formatVersion": 1,
        "product": "app",
        "platform": platform,
        "tool": config["tool"],
        "artifact": metadata["binary"]["path"],
        "unsignedSha256": unsigned_digest,
        "signedSha256": signed_digest,
        "verifiedSha256": signed_digest,
        "status": "verified",
    }
    remote_runtime_catalog = context["remote_runtime_catalog"]
    if remote_runtime_catalog is not None:
        assert isinstance(remote_runtime_catalog, AuthenticatedRemoteRuntimeCatalog)
        record["remoteRuntimeCatalogSha256"] = remote_runtime_catalog.sha256
    binary = metadata["binary"]
    assert isinstance(binary, dict)
    binary["sha256"] = signed_digest
    signing["status"] = "verified"
    signing["unsignedSha256"] = unsigned_digest
    signing["signedSha256"] = signed_digest
    signing["verifiedSha256"] = signed_digest
    signing["signatureRecord"] = str(
        context["record_path"].relative_to(context["package_dir"])
    )
    write_json(context["record_path"], record)
    write_json(context["metadata_path"], metadata)
    refresh_runtime_metadata(context["package_dir"], context["target_spec"])
    return record


def main(arguments: Optional[Sequence[str]] = None) -> int:
    operations = {
        "sign": sign_package,
        "verify": verify_package,
        "record": record_verified_package,
    }
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "action",
        choices=operations,
        help="Sign a staged package, verify its signature record, or verify and record managed signing.",
    )
    parser.add_argument("--package-dir", type=Path, required=True)
    args = parser.parse_args(arguments)
    record = operations[args.action](args.package_dir)
    print(
        f"App package {record['status']}: {record['platform']} {record['signedSha256']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
