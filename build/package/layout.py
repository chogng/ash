"""Canonical Ash package directory assembly and validation."""

import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
from pathlib import Path
from typing import Dict, Optional

from .bubblewrap import BubblewrapResolution
from .node import NodeResolution
from .ripgrep import RipgrepResolution
from build.lib.ash_build.targets import TargetSpec


LAYOUT_VERSION = 2
METADATA_FILE = "ash-package.json"
SKILL_NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def copy_uds_notices(repository_root: Path, licenses: Path) -> None:
    """Retain the notices for socket-security code linked into both product packages."""
    destination = licenses / "uds"
    destination.mkdir(parents=True)
    for name in ("LICENSE-APACHE", "NOTICE"):
        shutil.copyfile(repository_root / "ash-rs" / "uds" / name, destination / name)


def copy_windows_sandbox_notices(repository_root: Path, licenses: Path) -> None:
    destination = licenses / "windows-sandbox"
    destination.mkdir(parents=True)
    for name in ("LICENSE-APACHE", "NOTICE"):
        shutil.copyfile(
            repository_root / "ash-rs/windows-sandbox" / name, destination / name
        )


def build_package_directory(
    output: Path,
    repository_root: Path,
    version: str,
    spec: TargetSpec,
    server_binary: Path,
    remote_binary: Path,
    remote_server_binary: Path,
    exec_server_binary: Path,
    app_server_daemon_binary: Path,
    code_mode_host_binary: Path,
    ripgrep: RipgrepResolution,
    node: Optional[NodeResolution],
    bubblewrap: Optional[BubblewrapResolution] = None,
    protocol_metadata: Optional[Dict[str, object]] = None,
    build_profile: str = "release",
    cli_binary: Optional[Path] = None,
    update_public_key: Optional[str] = None,
    windows_sandbox_binary: Optional[Path] = None,
) -> None:
    if spec.is_windows != (windows_sandbox_binary is not None):
        raise RuntimeError(
            "Windows packages require their sandbox executable; other targets must omit it"
        )
    output = output.expanduser().resolve()
    if output.exists():
        raise RuntimeError(
            "Refusing to replace existing package output: {}".format(output)
        )
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix="." + output.name + ".partial-", dir=str(output.parent))
    )
    try:
        binary_directory = staging / "bin"
        path_directory = staging / "ash-path"
        skills_directory = staging / "ash-resources" / "skills"
        extensions_directory = staging / "ash-resources" / "extensions"
        product_services_directory = staging / "ash-resources" / "product-services"
        license_directory = staging / "ash-resources" / "licenses" / "ripgrep"
        vscode_license_directory = staging / "ash-resources" / "licenses" / "vscode"
        binary_directory.mkdir()
        if windows_sandbox_binary is not None:
            copy_executable(
                windows_sandbox_binary,
                binary_directory / "ash-windows-sandbox.exe",
                is_windows=True,
            )
            copy_windows_sandbox_notices(
                repository_root, staging / "ash-resources" / "licenses"
            )
        path_directory.mkdir()
        license_directory.mkdir(parents=True)
        vscode_license_directory.mkdir()
        copy_builtin_skills(
            repository_root / "ash-rs" / "skills" / "assets",
            skills_directory,
        )
        copy_builtin_extensions(
            repository_root / "extensions",
            extensions_directory,
        )
        copy_regular_tree(
            repository_root / "resources" / "product-services",
            product_services_directory,
            "product services",
        )

        copy_executable(
            server_binary,
            binary_directory / spec.server_name,
            is_windows=spec.is_windows,
        )
        copy_executable(
            remote_binary,
            binary_directory / spec.remote_name,
            is_windows=spec.is_windows,
        )
        copy_executable(
            remote_server_binary,
            binary_directory / spec.remote_server_name,
            is_windows=spec.is_windows,
        )
        copy_executable(
            exec_server_binary,
            binary_directory / spec.exec_server_name,
            is_windows=spec.is_windows,
        )
        if cli_binary is not None:
            copy_executable(
                cli_binary,
                binary_directory / spec.cli_name,
                is_windows=spec.is_windows,
            )
        copy_executable(
            app_server_daemon_binary,
            binary_directory / spec.app_server_daemon_name,
            is_windows=spec.is_windows,
        )
        copy_executable(
            code_mode_host_binary,
            binary_directory / spec.code_mode_host_name,
            is_windows=spec.is_windows,
        )
        copy_executable(
            ripgrep.executable,
            path_directory / spec.ripgrep_name,
            is_windows=spec.is_windows,
        )
        if node is not None:
            node_directory = staging / "ash-resources" / "node" / "bin"
            node_license_directory = staging / "ash-resources" / "licenses" / "node"
            node_directory.mkdir(parents=True)
            node_license_directory.mkdir(parents=True)
            copy_executable(
                node.executable,
                node_directory / spec.node_name,
                is_windows=spec.is_windows,
            )
            shutil.copyfile(node.license_file, node_license_directory / "LICENSE")
        mxc_license_directory = staging / "ash-resources" / "licenses" / "mxc"
        mxc_license_directory.mkdir()
        shutil.copyfile(
            repository_root / "ash-rs" / "vendor" / "mxc" / "LICENSE.md",
            mxc_license_directory / "LICENSE.md",
        )
        copy_uds_notices(repository_root, staging / "ash-resources" / "licenses")
        for name in ("LICENSE-MIT", "UNLICENSE"):
            shutil.copyfile(
                repository_root / "third_party" / "ripgrep" / name,
                license_directory / name,
            )
        shutil.copyfile(
            repository_root / "third_party" / "vscode" / "LICENSE.txt",
            vscode_license_directory / "LICENSE.txt",
        )

        bubblewrap_metadata = None
        if bubblewrap is not None:
            copy_executable(
                bubblewrap.executable,
                staging / "ash-resources" / "bwrap",
                is_windows=False,
            )
            bubblewrap_license_directory = (
                staging / "ash-resources" / "licenses" / "bubblewrap"
            )
            bubblewrap_license_directory.mkdir()
            for license_file in bubblewrap.license_files:
                shutil.copyfile(
                    license_file,
                    bubblewrap_license_directory / license_file.name,
                )
            bubblewrap_metadata = {
                "version": bubblewrap.version,
                "source": bubblewrap.source,
                "binarySha256": bubblewrap.binary_sha256,
                "sourceArchive": bubblewrap.source_archive,
                "sourceArchiveSha256": bubblewrap.source_archive_sha256,
            }

        ripgrep_metadata = {
            "version": ripgrep.version,
            "source": ripgrep.source,
            "binarySha256": ripgrep.binary_sha256,
        }
        if ripgrep.archive is not None:
            ripgrep_metadata["archive"] = ripgrep.archive
        if ripgrep.archive_sha256 is not None:
            ripgrep_metadata["archiveSha256"] = ripgrep.archive_sha256
        components = {
            "appServerDaemon": {
                "source": "cargo-build",
                "binarySha256": file_sha256(
                    binary_directory / spec.app_server_daemon_name
                ),
            },
            "codeModeHost": {
                "source": "cargo-build",
                "binarySha256": file_sha256(
                    binary_directory / spec.code_mode_host_name
                ),
            },
            "ripgrep": ripgrep_metadata,
            "remote": {
                "source": "cargo-build",
                "binarySha256": file_sha256(binary_directory / spec.remote_name),
            },
            "remoteServer": {
                "source": "cargo-build",
                "binarySha256": file_sha256(binary_directory / spec.remote_server_name),
            },
            "execServer": {
                "source": "cargo-build",
                "binarySha256": file_sha256(binary_directory / spec.exec_server_name),
            },
            "appServer": {
                "source": "cargo-build",
                "binarySha256": file_sha256(binary_directory / spec.server_name),
            },
        }
        if cli_binary is not None:
            if (
                not isinstance(update_public_key, str)
                or re.fullmatch(r"[a-f0-9]{64}", update_public_key) is None
            ):
                raise RuntimeError(
                    "Ash Code packages require a 32-byte hexadecimal update public key"
                )
            components["cli"] = {
                "source": "cargo-build",
                "binarySha256": file_sha256(binary_directory / spec.cli_name),
                "updatePublicKey": update_public_key,
            }
        elif update_public_key is not None:
            raise RuntimeError("--update-public-key requires --cli-bin")
        if node is not None:
            components["node"] = {
                "version": node.version,
                "source": node.source,
                "binarySha256": node.binary_sha256,
                "archive": node.archive,
                "archiveSha256": node.archive_sha256,
            }
        if bubblewrap_metadata is not None:
            components["bubblewrap"] = bubblewrap_metadata
        if windows_sandbox_binary is not None:
            components["windowsSandbox"] = {
                "source": "cargo-build",
                "binarySha256": file_sha256(
                    binary_directory / "ash-windows-sandbox.exe"
                ),
            }
        protocol = (
            protocol_metadata
            if protocol_metadata is not None
            else load_protocol_metadata(repository_root)
        )
        files = package_files(staging)
        runtime_kind = "packagedNode" if node is not None else "hostProvidedNode"
        identity = {
            "buildProfile": build_profile,
            "layoutVersion": LAYOUT_VERSION,
            "version": version,
            "target": spec.target,
            "entrypoint": "bin/" + spec.server_name,
            "pathDir": "ash-path",
            "resourcesDir": "ash-resources",
            "javascriptRuntime": {
                "kind": runtime_kind,
            },
            "components": components,
            "protocol": protocol,
        }
        metadata = {
            **identity,
            "buildId": package_build_id(identity, files),
            "files": files,
        }
        write_json(staging / METADATA_FILE, metadata)
        validate_package_directory(staging, spec)
        staging.rename(output)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def validate_package_directory(package: Path, spec: TargetSpec) -> None:
    required_directories = (
        package / "bin",
        package / "ash-path",
        package / "ash-resources",
    )
    for directory in required_directories:
        if not directory.is_dir():
            raise RuntimeError("Missing package directory: {}".format(directory))

    metadata_path = package / METADATA_FILE
    if not metadata_path.is_file():
        raise RuntimeError("Missing package metadata: {}".format(metadata_path))
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    expected = {
        "layoutVersion": LAYOUT_VERSION,
        "target": spec.target,
        "entrypoint": "bin/" + spec.server_name,
        "pathDir": "ash-path",
        "resourcesDir": "ash-resources",
    }
    for key, expected_value in expected.items():
        if metadata.get(key) != expected_value:
            raise RuntimeError(
                "Invalid package metadata {!r}: expected {!r}, got {!r}".format(
                    key, expected_value, metadata.get(key)
                )
            )

    executables = [
        package / "bin" / spec.server_name,
        package / "bin" / spec.remote_name,
        package / "bin" / spec.remote_server_name,
        package / "bin" / spec.exec_server_name,
        package / "bin" / spec.app_server_daemon_name,
        package / "bin" / spec.code_mode_host_name,
        package / "ash-path" / spec.ripgrep_name,
    ]
    components = metadata.get("components")
    if not isinstance(components, dict):
        raise RuntimeError("Invalid package component metadata")
    first_party_artifacts = {
        "appServerDaemon": package / "bin" / spec.app_server_daemon_name,
        "codeModeHost": package / "bin" / spec.code_mode_host_name,
        "appServer": package / "bin" / spec.server_name,
        "remote": package / "bin" / spec.remote_name,
        "remoteServer": package / "bin" / spec.remote_server_name,
        "execServer": package / "bin" / spec.exec_server_name,
    }
    if spec.is_windows:
        first_party_artifacts["windowsSandbox"] = (
            package / "bin/ash-windows-sandbox.exe"
        )
        executables.append(package / "bin/ash-windows-sandbox.exe")
    if "cli" in components:
        cli = components["cli"]
        if (
            not isinstance(cli, dict)
            or not isinstance(cli.get("updatePublicKey"), str)
            or re.fullmatch(r"[a-f0-9]{64}", cli["updatePublicKey"]) is None
        ):
            raise RuntimeError("Package CLI update public key is invalid")
        first_party_artifacts["cli"] = package / "bin" / spec.cli_name
        executables.append(package / "bin" / spec.cli_name)
    for component_name, artifact in first_party_artifacts.items():
        component = components.get(component_name)
        expected_digest = (
            component.get("binarySha256") if isinstance(component, dict) else None
        )
        if (
            not isinstance(expected_digest, str)
            or re.fullmatch(r"[a-f0-9]{64}", expected_digest) is None
            or file_sha256(artifact) != expected_digest
        ):
            raise RuntimeError(
                "Package component digest does not match: {}".format(component_name)
            )
    files = package_files(package)
    if metadata.get("files") != files:
        raise RuntimeError("Package file manifest does not match its contents")
    identity = {
        key: value for key, value in metadata.items() if key not in ("buildId", "files")
    }
    expected_build_id = package_build_id(identity, files)
    if metadata.get("buildId") != expected_build_id:
        raise RuntimeError(
            "Package build identity does not match its complete file manifest"
        )
    javascript_runtime = metadata.get("javascriptRuntime")
    if javascript_runtime == {"kind": "packagedNode"}:
        if not isinstance(components.get("node"), dict):
            raise RuntimeError("Packaged Node runtime metadata is missing")
        executables.append(package / "ash-resources" / "node" / "bin" / spec.node_name)
    elif javascript_runtime == {"kind": "hostProvidedNode"}:
        if "node" in components:
            raise RuntimeError("Host-provided runtime package contains Node metadata")
        if (package / "ash-resources" / "node").exists():
            raise RuntimeError(
                "Host-provided runtime package contains a Node executable"
            )
        if (package / "ash-resources" / "licenses" / "node").exists():
            raise RuntimeError("Host-provided runtime package contains a Node license")
    else:
        raise RuntimeError("Invalid package JavaScript runtime declaration")
    for executable in executables:
        if not executable.is_file():
            raise RuntimeError("Missing package executable: {}".format(executable))
        if not spec.is_windows and not is_executable(executable):
            raise RuntimeError("Package file is not executable: {}".format(executable))
    for license_name in ("LICENSE-MIT", "UNLICENSE"):
        license_path = package / "ash-resources" / "licenses" / "ripgrep" / license_name
        if not license_path.is_file():
            raise RuntimeError("Missing ripgrep license: {}".format(license_path))
    for name in ("LICENSE-APACHE", "NOTICE"):
        notice = package / "ash-resources" / "licenses" / "uds" / name
        if notice.is_symlink() or not notice.is_file():
            raise RuntimeError("Missing UDS notice: {}".format(notice))
    mxc_license = package / "ash-resources" / "licenses" / "mxc" / "LICENSE.md"
    if mxc_license.is_symlink() or not mxc_license.is_file():
        raise RuntimeError("Missing MXC license")
    vscode_license = package / "ash-resources" / "licenses" / "vscode" / "LICENSE.txt"
    if vscode_license.is_symlink() or not vscode_license.is_file():
        raise RuntimeError(
            "Missing VS Code extension license: {}".format(vscode_license)
        )
    if javascript_runtime == {"kind": "packagedNode"}:
        node_license = package / "ash-resources" / "licenses" / "node" / "LICENSE"
        if node_license.is_symlink() or not node_license.is_file():
            raise RuntimeError("Missing Node.js license: {}".format(node_license))
    validate_builtin_skills(package / "ash-resources" / "skills")
    validate_builtin_extensions(package / "ash-resources" / "extensions")
    validate_product_services(package / "ash-resources" / "product-services")
    if spec.is_linux:
        bubblewrap = package / "ash-resources" / "bwrap"
        if not bubblewrap.is_file() or not is_executable(bubblewrap):
            raise RuntimeError(
                "Linux package is missing executable ash-resources/bwrap"
            )
        for license_name in ("COPYING",):
            license_path = (
                package / "ash-resources" / "licenses" / "bubblewrap" / license_name
            )
            if not license_path.is_file():
                raise RuntimeError(
                    "Missing Bubblewrap license: {}".format(license_path)
                )


def system_signing_artifacts(package: Path, spec: TargetSpec) -> Dict[str, Path]:
    """Return executable package members covered by system signing."""
    metadata = json.loads((package / METADATA_FILE).read_text(encoding="utf-8"))
    components = metadata.get("components")
    if not isinstance(components, dict):
        raise RuntimeError("Invalid package component metadata")
    artifacts = {
        "appServerDaemon": package / "bin" / spec.app_server_daemon_name,
        "codeModeHost": package / "bin" / spec.code_mode_host_name,
        "ripgrep": package / "ash-path" / spec.ripgrep_name,
        "appServer": package / "bin" / spec.server_name,
        "remote": package / "bin" / spec.remote_name,
        "remoteServer": package / "bin" / spec.remote_server_name,
        "execServer": package / "bin" / spec.exec_server_name,
    }
    if spec.is_windows:
        artifacts["windowsSandbox"] = package / "bin/ash-windows-sandbox.exe"
    if "cli" in components:
        artifacts["cli"] = package / "bin" / spec.cli_name
    if metadata.get("javascriptRuntime") == {"kind": "packagedNode"}:
        artifacts["node"] = package / "ash-resources" / "node" / "bin" / spec.node_name
    for path in artifacts.values():
        if path.is_symlink() or not path.is_file():
            raise RuntimeError("Missing package signing artifact: {}".format(path))
    return artifacts


def record_system_signing(
    package: Path,
    spec: TargetSpec,
    signed_artifacts: Dict[str, Dict[str, str]],
) -> None:
    """Refresh package identity after embedded signatures change executable bytes."""
    metadata_path = package / METADATA_FILE
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    components = metadata.get("components")
    if not isinstance(components, dict):
        raise RuntimeError("Invalid package component metadata")
    expected = system_signing_artifacts(package, spec)
    if set(signed_artifacts) != set(expected):
        raise RuntimeError(
            "System signing record does not cover every package executable"
        )
    records = []
    for name, path in sorted(expected.items()):
        record = signed_artifacts[name]
        signed_digest = record.get("signedSha256")
        unsigned_digest = record.get("unsignedSha256")
        if (
            not isinstance(unsigned_digest, str)
            or not isinstance(signed_digest, str)
            or file_sha256(path) != signed_digest
        ):
            raise RuntimeError("System signing digest does not match {}".format(name))
        relative = path.relative_to(package).as_posix()
        records.append(
            {
                "name": name,
                "path": relative,
                "unsignedSha256": unsigned_digest,
                "signedSha256": signed_digest,
            }
        )
        if name in {
            "appServerDaemon",
            "cli",
            "codeModeHost",
            "node",
            "ripgrep",
            "appServer",
            "remote",
            "remoteServer",
            "execServer",
            "windowsSandbox",
        }:
            component = components.get(name)
            if not isinstance(component, dict):
                raise RuntimeError("Missing package component {}".format(name))
            component["binarySha256"] = signed_digest
    metadata["systemSigning"] = {
        "formatVersion": 1,
        "platform": spec.operating_system.value,
        "status": "verified",
        "artifacts": records,
    }
    files = package_files(package)
    identity = {
        key: value for key, value in metadata.items() if key not in ("buildId", "files")
    }
    metadata["files"] = files
    metadata["buildId"] = package_build_id(identity, files)
    write_json(metadata_path, metadata)
    validate_package_directory(package, spec)


def require_verified_system_signing(package: Path, spec: TargetSpec) -> None:
    if spec.is_linux:
        return
    metadata = json.loads((package / METADATA_FILE).read_text(encoding="utf-8"))
    signing = metadata.get("systemSigning")
    if (
        not isinstance(signing, dict)
        or signing.get("platform") != spec.operating_system.value
        or signing.get("status") != "verified"
    ):
        raise RuntimeError(
            "macOS and Windows release packages require verified system signing"
        )
    artifacts = signing.get("artifacts")
    expected = system_signing_artifacts(package, spec)
    if not isinstance(artifacts, list) or len(artifacts) != len(expected):
        raise RuntimeError("System signing record is incomplete")
    observed = {}
    for record in artifacts:
        if not isinstance(record, dict):
            raise RuntimeError("System signing record is invalid")
        name = record.get("name")
        path = record.get("path")
        digest = record.get("signedSha256")
        if not isinstance(name, str) or name in observed or name not in expected:
            raise RuntimeError("System signing record has an invalid artifact name")
        expected_path = expected[name].relative_to(package).as_posix()
        if path != expected_path or digest != file_sha256(expected[name]):
            raise RuntimeError("System signing record does not match {}".format(name))
        observed[name] = digest
    if set(observed) != set(expected):
        raise RuntimeError("System signing record is incomplete")


def copy_builtin_skills(source: Path, destination: Path) -> None:
    if source.is_symlink() or not source.is_dir():
        raise RuntimeError(
            "Built-in Skill source is not a real directory: {}".format(source)
        )
    skill_directories = [
        child
        for child in sorted(source.iterdir(), key=lambda path: path.name)
        if child.name != "BUILD.bazel"
    ]
    if not skill_directories:
        raise RuntimeError("Built-in Skill source is empty: {}".format(source))
    destination.mkdir(parents=True)
    for skill_directory in skill_directories:
        if (
            skill_directory.is_symlink()
            or not skill_directory.is_dir()
            or SKILL_NAME.fullmatch(skill_directory.name) is None
        ):
            raise RuntimeError(
                "Invalid built-in Skill directory: {}".format(skill_directory)
            )
        if not (skill_directory / "SKILL.md").is_file():
            raise RuntimeError(
                "Built-in Skill is missing SKILL.md: {}".format(skill_directory)
            )
        copy_regular_tree(skill_directory, destination / skill_directory.name)


def copy_builtin_extensions(source: Path, destination: Path) -> None:
    if source.is_symlink() or not source.is_dir():
        raise RuntimeError(
            "Built-in extension source is not a real directory: {}".format(source)
        )
    extension_entries = [
        child
        for child in sorted(source.iterdir(), key=lambda path: path.name)
        if child.name not in ("README.md", "BUILD.bazel")
    ]
    if not extension_entries:
        raise RuntimeError("Built-in extension source is empty: {}".format(source))
    destination.mkdir(parents=True)
    for extension_directory in extension_entries:
        if extension_directory.is_symlink() or not extension_directory.is_dir():
            raise RuntimeError(
                "Invalid built-in extension package: {}".format(extension_directory)
            )
        manifest = extension_directory / "package.json"
        if manifest.is_symlink() or not manifest.is_file():
            raise RuntimeError(
                "Built-in extension is missing package.json: {}".format(
                    extension_directory
                )
            )
        copy_regular_tree(
            extension_directory,
            destination / extension_directory.name,
            "extension package",
        )


def copy_regular_tree(source: Path, destination: Path, kind: str = "Skill") -> None:
    destination.mkdir()
    for child in sorted(source.iterdir(), key=lambda path: path.name):
        metadata = child.lstat()
        target = destination / child.name
        if child.is_symlink():
            raise RuntimeError(
                "Built-in {} asset is a symbolic link: {}".format(kind, child)
            )
        if stat.S_ISDIR(metadata.st_mode):
            copy_regular_tree(child, target, kind)
        elif stat.S_ISREG(metadata.st_mode):
            if metadata.st_nlink > 1:
                raise RuntimeError(
                    "Built-in {} asset is a hard link: {}".format(kind, child)
                )
            shutil.copyfile(child, target)
        else:
            raise RuntimeError(
                "Built-in {} asset is not a regular file or directory: {}".format(
                    kind, child
                )
            )


def validate_builtin_skills(skills_directory: Path) -> None:
    if skills_directory.is_symlink() or not skills_directory.is_dir():
        raise RuntimeError("Package is missing built-in Skills")
    skill_directories = sorted(skills_directory.iterdir(), key=lambda path: path.name)
    if not skill_directories:
        raise RuntimeError("Package contains no built-in Skills")
    for skill_directory in skill_directories:
        if (
            skill_directory.is_symlink()
            or not skill_directory.is_dir()
            or SKILL_NAME.fullmatch(skill_directory.name) is None
            or not (skill_directory / "SKILL.md").is_file()
        ):
            raise RuntimeError(
                "Package contains an invalid built-in Skill: {}".format(skill_directory)
            )


def validate_builtin_extensions(extensions_directory: Path) -> None:
    if extensions_directory.is_symlink() or not extensions_directory.is_dir():
        raise RuntimeError("Package is missing built-in extensions")
    extension_directories = sorted(
        extensions_directory.iterdir(), key=lambda path: path.name
    )
    if not extension_directories:
        raise RuntimeError("Package contains no built-in extensions")
    for extension_directory in extension_directories:
        if (
            extension_directory.is_symlink()
            or not extension_directory.is_dir()
            or not (extension_directory / "package.json").is_file()
        ):
            raise RuntimeError(
                "Package contains an invalid built-in extension: {}".format(
                    extension_directory
                )
            )


def validate_product_services(product_services_directory: Path) -> None:
    if (
        product_services_directory.is_symlink()
        or not product_services_directory.is_dir()
    ):
        raise RuntimeError("Package is missing product services")
    config_path = product_services_directory / "product-services.json"
    root_path = product_services_directory / "marketplace-root.json"
    for path in (config_path, root_path):
        if path.is_symlink() or not path.is_file():
            raise RuntimeError(
                "Package is missing product service file: {}".format(path)
            )
    if not 0 < config_path.stat().st_size <= 1024 * 1024:
        raise RuntimeError(
            "Package product services configuration exceeds its file contract"
        )
    document = json.loads(config_path.read_text(encoding="utf-8"))
    if not isinstance(document, dict):
        raise RuntimeError("Package product services configuration is invalid")
    marketplaces = document.get("marketplaces")
    if document.get("schemaVersion") != 2 or not isinstance(marketplaces, list):
        raise RuntimeError("Package product services configuration is invalid")
    names = set()
    for source in marketplaces:
        if not isinstance(source, dict):
            raise RuntimeError("Package product services configuration is invalid")
        name = source.get("name")
        if (
            not isinstance(name, str)
            or re.fullmatch(r"[A-Za-z0-9_-]{1,128}", name) is None
            or name in names
        ):
            raise RuntimeError("Package Marketplace names must be valid and unique")
        names.add(name)
        relative = source.get("trustedRoot")
        if name == "ash" and relative != "marketplace-root.json":
            raise RuntimeError(
                "Package product services does not pin the Ash Marketplace root"
            )
        if not isinstance(relative, str) or "\\" in relative or ":" in relative:
            raise RuntimeError("Package trust root must be a contained relative file")
        segments = relative.split("/")
        if any(segment in ("", ".", "..") for segment in segments):
            raise RuntimeError("Package trust root must be a contained relative file")
        path = product_services_directory
        for index, segment in enumerate(segments):
            path = path / segment
            metadata = path.lstat()
            last = index == len(segments) - 1
            if stat.S_ISLNK(metadata.st_mode) or (
                (
                    not stat.S_ISREG(metadata.st_mode)
                    or not 0 < metadata.st_size <= 1024 * 1024
                )
                if last
                else not stat.S_ISDIR(metadata.st_mode)
            ):
                raise RuntimeError(
                    "Package trust root must be a bounded regular file inside product services"
                )
    if "ash" not in names:
        raise RuntimeError(
            "Package product services does not pin the Ash Marketplace root"
        )


def copy_executable(source: Path, destination: Path, is_windows: bool) -> None:
    shutil.copyfile(source, destination)
    if not is_windows:
        mode = destination.stat().st_mode
        destination.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def is_executable(path: Path) -> bool:
    if os.name == "nt":
        return True
    return bool(path.stat().st_mode & stat.S_IXUSR)


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def package_files(package: Path) -> Dict[str, str]:
    files = {}

    def visit(directory: Path) -> None:
        for path in sorted(directory.iterdir(), key=lambda candidate: candidate.name):
            if path.is_symlink():
                raise RuntimeError("Package contains a symbolic path: {}".format(path))
            if path.is_dir():
                visit(path)
            elif path.is_file():
                relative = path.relative_to(package).as_posix()
                if relative not in (METADATA_FILE, ".lease"):
                    files[relative] = file_sha256(path)
            else:
                raise RuntimeError(
                    "Package contains an unsupported file: {}".format(path)
                )

    visit(package)
    return files


def package_build_id(identity: Dict[str, object], files: Dict[str, str]) -> str:
    digest = hashlib.sha256()
    digest.update(b"ash-package-build-v2\0")
    digest.update(
        json.dumps(
            identity,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    )
    digest.update(b"\0")
    for path, file_digest in sorted(files.items()):
        digest.update(path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(file_digest.encode("ascii"))
        digest.update(b"\0")
    return "sha256:" + digest.hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(64 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def load_protocol_metadata(
    repository_root: Path,
    generated_typescript: Optional[Path] = None,
) -> Dict[str, object]:
    generated = (
        generated_typescript
        or repository_root
        / "ash-rs"
        / "app-server-protocol"
        / "schema"
        / "typescript"
        / "protocol.ts"
    ).read_text(encoding="utf-8")
    major = re.search(
        r"^export const APP_SERVER_PROTOCOL_MAJOR = (\d+) as const;$",
        generated,
        re.MULTILINE,
    )
    revision = re.search(
        r"^export const APP_SERVER_PROTOCOL_REVISION = (\d+) as const;$",
        generated,
        re.MULTILINE,
    )
    schema_hash = re.search(
        r'^export const APP_SERVER_SCHEMA_HASH = "(sha256:[a-f0-9]{64})" as const;$',
        generated,
        re.MULTILINE,
    )
    if major is None or revision is None or schema_hash is None:
        raise RuntimeError("Generated App Server protocol metadata is invalid")
    return {
        "major": int(major.group(1)),
        "revision": int(revision.group(1)),
        "schemaHash": schema_hash.group(1),
    }
