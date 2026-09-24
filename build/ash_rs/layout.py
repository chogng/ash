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
from urllib.parse import urlsplit

from .bubblewrap import BubblewrapResolution
from .node import NodeResolution
from .ripgrep import RipgrepResolution
from .executable import ExecutableResolution
from build.lib.targets import TargetSpec


LAYOUT = json.loads(Path(__file__).with_suffix(".json").read_text(encoding="utf-8"))
LAYOUT_VERSION = LAYOUT["layoutVersion"]
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
    tgrep: ExecutableResolution,
    node: Optional[NodeResolution],
    bubblewrap: Optional[BubblewrapResolution] = None,
    protocol_metadata: Optional[Dict[str, object]] = None,
    build_profile: str = "release",
    windows_sandbox_binary: Optional[Path] = None,
    voice_host_binary: Optional[Path] = None,
    collaboration_server_binary: Optional[Path] = None,
    livekit: Optional[Dict[str, str]] = None,
    remote_runtime_bundle: Optional[Path] = None,
    remote_runtime_release: Optional[Dict[str, str]] = None,
) -> None:
    if spec.is_windows != (windows_sandbox_binary is not None):
        raise RuntimeError(
            "Windows packages require their sandbox executable; other targets must omit it"
        )
    if (
        voice_host_binary is None
        or collaboration_server_binary is None
        or livekit is None
    ):
        raise RuntimeError("Call helper executables are required in product packages")
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
        executables = {
            "appServer": str(server_binary),
            "remote": str(remote_binary),
            "remoteServer": str(remote_server_binary),
            "execServer": str(exec_server_binary),
            "appServerDaemon": str(app_server_daemon_binary),
            "codeModeHost": str(code_mode_host_binary),
            "voiceHost": str(voice_host_binary),
            "collaborationServer": str(collaboration_server_binary),
            "livekit": livekit["executable"],
        }
        if windows_sandbox_binary is not None:
            executables["windowsSandbox"] = str(windows_sandbox_binary)
        if bubblewrap is not None:
            executables["bubblewrap"] = {
                "binary": str(bubblewrap.executable),
                "license": str(bubblewrap.license_files[0]),
                "licenses": [str(path) for path in bubblewrap.license_files],
                "version": bubblewrap.version,
                "source": bubblewrap.source,
                "archive": bubblewrap.source_archive,
                "archiveSha256": bubblewrap.source_archive_sha256,
            }
        runtime = {
            "executable": str(ripgrep.executable),
            "version": ripgrep.version,
            "source": ripgrep.source,
            "binarySha256": ripgrep.binary_sha256,
        }
        if ripgrep.archive is not None:
            runtime["archive"] = ripgrep.archive
        if ripgrep.archive_sha256 is not None:
            runtime["archiveSha256"] = ripgrep.archive_sha256
        inputs = {
            "staging": str(staging),
            "target": spec.target,
            "platform": "win32" if spec.is_windows else spec.operating_system.value,
            "executables": executables,
            "ripgrep": runtime,
            "tgrep": {
                "executable": str(tgrep.executable),
                "version": tgrep.version,
                "source": tgrep.source,
                "binarySha256": tgrep.binary_sha256,
                **({"archive": tgrep.archive} if tgrep.archive is not None else {}),
                **(
                    {"archiveSha256": tgrep.archive_sha256}
                    if tgrep.archive_sha256 is not None
                    else {}
                ),
            },
            "node": {
                "executable": str(node.executable),
                "license": str(node.license_file),
                "version": node.version,
                "source": node.source,
                "binarySha256": node.binary_sha256,
                "archive": node.archive,
                "archiveSha256": node.archive_sha256,
            }
            if node is not None
            else None,
            "options": {
                "sourceRoot": str(repository_root),
                "version": version,
                "buildProfile": build_profile,
                "protocol": protocol_metadata
                if protocol_metadata is not None
                else load_protocol_metadata(repository_root),
            },
            "remoteRuntimeBundle": str(remote_runtime_bundle)
            if remote_runtime_bundle
            else None,
            "remoteRuntimeRelease": remote_runtime_release,
        }
        assemble_package(staging, inputs)
        validate_package_directory(staging, spec)
        staging.rename(output)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def copy_regular_tree(source: Path, destination: Path, kind: str) -> None:
    metadata = source.lstat()
    if not stat.S_ISDIR(metadata.st_mode):
        raise RuntimeError(f"Built-in {kind} source is not a real directory: {source}")
    destination.mkdir()
    for entry in source.iterdir():
        target = destination / entry.name
        metadata = entry.lstat()
        if stat.S_ISDIR(metadata.st_mode):
            copy_regular_tree(entry, target, kind)
        elif stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1:
            shutil.copyfile(entry, target)
        else:
            raise RuntimeError(
                f"Built-in {kind} asset is not a regular unlinked file: {entry}"
            )


def copy_builtin_skills(source_root: Path, destination: Path) -> None:
    source = source_root / "ash-rs/skills/assets"
    if not stat.S_ISDIR(source.lstat().st_mode):
        raise RuntimeError(f"Built-in Skill source is not a real directory: {source}")
    entries = [entry for entry in source.iterdir() if entry.name != "BUILD.bazel"]
    if not entries:
        raise RuntimeError("Built-in Skill source is empty")
    destination.mkdir(parents=True)
    for entry in entries:
        if (
            not stat.S_ISDIR(entry.lstat().st_mode)
            or SKILL_NAME.fullmatch(entry.name) is None
        ):
            raise RuntimeError(f"Invalid built-in Skill directory: {entry.name}")
        if not (entry / "SKILL.md").is_file():
            raise RuntimeError(f"Built-in Skill is missing SKILL.md: {entry.name}")
        copy_regular_tree(entry, destination / entry.name, "Skill")


def copy_builtin_extensions(source_root: Path, destination: Path) -> None:
    source = source_root / "extensions"
    if not stat.S_ISDIR(source.lstat().st_mode):
        raise RuntimeError(
            f"Built-in extension source is not a real directory: {source}"
        )
    entries = [
        entry
        for entry in source.iterdir()
        if entry.name not in ("README.md", "BUILD.bazel")
    ]
    if not entries:
        raise RuntimeError("Built-in extension source is empty")
    destination.mkdir(parents=True)
    for entry in entries:
        if not stat.S_ISDIR(entry.lstat().st_mode):
            raise RuntimeError(f"Invalid built-in extension package: {entry.name}")
        manifest = entry / "package.json"
        if not stat.S_ISREG(manifest.lstat().st_mode):
            raise RuntimeError(
                f"Built-in extension package.json is not a regular file: {entry.name}"
            )
        copy_regular_tree(entry, destination / entry.name, "extension package")


def copy_executable(source: Path, destination: Path, is_windows: bool) -> None:
    shutil.copyfile(source, destination)
    if not is_windows:
        destination.chmod(0o755)


def assemble_package(staging: Path, inputs: dict) -> None:
    """Create the same canonical package for development and release callers."""
    options = inputs["options"]
    source_root = Path(options["sourceRoot"])
    target = inputs["target"]
    is_windows = inputs["platform"] == "win32"
    executables = inputs["executables"]
    resources = staging / LAYOUT["resourcesDir"]
    binary_dir = staging / "bin"
    binary_dir.mkdir(parents=True)
    (staging / LAYOUT["pathDir"]).mkdir(parents=True)
    copy_builtin_skills(source_root, resources / "skills")
    copy_builtin_extensions(source_root, resources / "extensions")
    copy_regular_tree(
        source_root / "resources/product-services",
        resources / "product-services",
        "product services",
    )
    remote_bundle = inputs.get("remoteRuntimeBundle")
    if remote_bundle:
        copy_regular_tree(
            Path(remote_bundle),
            staging / "ash-remote-runtimes",
            "Remote runtime bundle",
        )

    suffix = ".exe" if is_windows else ""
    for component, relative in LAYOUT["binaries"].items():
        destination = staging / relative.format(exe=suffix)
        copy_executable(Path(executables[component]), destination, is_windows)
    if is_windows:
        copy_executable(
            Path(executables["windowsSandbox"]),
            binary_dir / "ash-windows-sandbox.exe",
            True,
        )
        copy_windows_sandbox_notices(source_root, resources / "licenses")
    ripgrep = inputs["ripgrep"]
    tgrep = inputs["tgrep"]
    copy_executable(
        Path(ripgrep["executable"]),
        staging / LAYOUT["pathDir"] / ("rg" + suffix),
        is_windows,
    )
    tgrep_dir = resources / "tgrep"
    tgrep_dir.mkdir()
    copy_executable(
        Path(tgrep["executable"]), tgrep_dir / ("tgrep" + suffix), is_windows
    )
    node = inputs.get("node")
    if node is not None:
        node_dir = resources / "node/bin"
        node_dir.mkdir(parents=True)
        copy_executable(
            Path(node["executable"]), node_dir / ("node" + suffix), is_windows
        )
        node_license = resources / "licenses/node"
        node_license.mkdir(parents=True)
        shutil.copyfile(node["license"], node_license / "LICENSE")
    for license in LAYOUT["licenses"]:
        destination = staging / license["destination"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source_root / license["source"], destination)

    components = {
        "tgrep": {
            key: value
            for key, value in tgrep.items()
            if key in ("archive", "archiveSha256", "binarySha256", "source", "version")
        },
        "ripgrep": {
            key: value
            for key, value in ripgrep.items()
            if key in ("archive", "archiveSha256", "binarySha256", "source", "version")
        },
    }
    for component, relative in LAYOUT["binaries"].items():
        components[component] = {
            "source": "cargo-build",
            "binarySha256": file_sha256(staging / relative.format(exe=suffix)),
        }
    if is_windows:
        components["windowsSandbox"] = {
            "source": "cargo-build",
            "binarySha256": file_sha256(binary_dir / "ash-windows-sandbox.exe"),
        }
    if node is not None:
        components["node"] = {
            key: node[key]
            for key in ("archive", "archiveSha256", "binarySha256", "source", "version")
        }
    if inputs["platform"] == "linux":
        bubblewrap = executables.get("bubblewrap")
        if bubblewrap is None:
            raise RuntimeError("Linux package is missing the Bubblewrap build")
        copy_executable(Path(bubblewrap["binary"]), resources / "bwrap", False)
        license_dir = resources / "licenses/bubblewrap"
        license_dir.mkdir(parents=True)
        for license_path in bubblewrap.get("licenses", [bubblewrap["license"]]):
            license = Path(license_path)
            shutil.copyfile(license, license_dir / license.name)
        components["bubblewrap"] = {
            "binarySha256": file_sha256(Path(bubblewrap["binary"])),
            "source": bubblewrap.get("source", "vendored-source-build"),
            "sourceArchive": bubblewrap["archive"],
            "sourceArchiveSha256": bubblewrap["archiveSha256"],
            "version": bubblewrap["version"],
        }

    remote_release = inputs.get("remoteRuntimeRelease")
    catalog = None
    if remote_bundle or remote_release:
        packaged_digest = (
            file_sha256(staging / "ash-remote-runtimes/catalog.json")
            if remote_bundle
            else None
        )
        if (
            remote_release
            and packaged_digest
            and remote_release["sha256"] != packaged_digest
        ):
            raise RuntimeError(
                "Network Remote runtime catalog SHA-256 does not match the packaged catalog"
            )
        catalog = (
            {
                "url": remote_release["url"],
                "sha256": remote_release["sha256"],
                "trustBinding": "signedProductPackage",
            }
            if remote_release
            else {
                "path": "ash-remote-runtimes/catalog.json",
                "sha256": packaged_digest,
                "trustBinding": "signedProductPackage",
            }
        )
    identity = {
        "buildProfile": options["buildProfile"],
        "components": components,
        "entrypoint": LAYOUT["entrypoint"].format(exe=suffix),
        "javascriptRuntime": {"kind": "packagedNode" if node else "hostProvidedNode"},
        "layoutVersion": LAYOUT_VERSION,
        "pathDir": LAYOUT["pathDir"],
        "protocol": options["protocol"],
        "resourcesDir": LAYOUT["resourcesDir"],
        "target": target,
        "version": options["version"],
    }
    if catalog:
        identity["remoteRuntimeCatalog"] = catalog
    files = package_files(staging)
    metadata = {
        **identity,
        "buildId": package_build_id(identity, files),
        "files": files,
    }
    write_json(staging / METADATA_FILE, metadata)


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
        "entrypoint": LAYOUT["entrypoint"].format(
            exe=".exe" if spec.is_windows else ""
        ),
        "pathDir": LAYOUT["pathDir"],
        "resourcesDir": LAYOUT["resourcesDir"],
    }
    for key, expected_value in expected.items():
        if metadata.get(key) != expected_value:
            raise RuntimeError(
                "Invalid package metadata {!r}: expected {!r}, got {!r}".format(
                    key, expected_value, metadata.get(key)
                )
            )

    executables = [
        package / relative.format(exe=spec.executable_suffix)
        for relative in LAYOUT["binaries"].values()
    ]
    executables.append(package / LAYOUT["pathDir"] / spec.ripgrep_name)
    executables.append(
        package / "ash-resources/tgrep" / ("tgrep" + spec.executable_suffix)
    )
    components = metadata.get("components")
    if not isinstance(components, dict):
        raise RuntimeError("Invalid package component metadata")
    first_party_artifacts = {
        component: package / relative.format(exe=".exe" if spec.is_windows else "")
        for component, relative in LAYOUT["binaries"].items()
    }
    first_party_artifacts["tgrep"] = (
        package / "ash-resources/tgrep" / ("tgrep" + spec.executable_suffix)
    )
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
    if "app" in components:
        first_party_artifacts["app"] = package / "bin" / spec.app_name
        executables.append(package / "bin" / spec.app_name)
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
    for license in LAYOUT["licenses"]:
        path = package / license["destination"]
        if path.is_symlink() or not path.is_file():
            raise RuntimeError(f"Missing package license: {path}")
    if javascript_runtime == {"kind": "packagedNode"}:
        node_license = package / "ash-resources" / "licenses" / "node" / "LICENSE"
        if node_license.is_symlink() or not node_license.is_file():
            raise RuntimeError("Missing Node.js license: {}".format(node_license))
    validate_builtin_skills(package / "ash-resources" / "skills")
    validate_builtin_extensions(package / "ash-resources" / "extensions")
    validate_product_services(package / "ash-resources" / "product-services")
    remote_catalog = metadata.get("remoteRuntimeCatalog")
    if remote_catalog is not None:
        if (
            not isinstance(remote_catalog, dict)
            or remote_catalog.get("trustBinding") != "signedProductPackage"
            or not isinstance(remote_catalog.get("sha256"), str)
            or re.fullmatch(r"[a-f0-9]{64}", remote_catalog["sha256"]) is None
        ):
            raise RuntimeError("Invalid Remote runtime catalog package binding")
        if (
            remote_catalog.get("path") == "ash-remote-runtimes/catalog.json"
            and "url" not in remote_catalog
        ):
            catalog_path = package / "ash-remote-runtimes/catalog.json"
            catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
            if (
                file_sha256(catalog_path) != remote_catalog["sha256"]
                or catalog.get("formatVersion") != 1
                or not isinstance(catalog.get("artifacts"), list)
                or not catalog["artifacts"]
            ):
                raise RuntimeError("Invalid packaged Remote runtime catalog")
        elif "path" not in remote_catalog and isinstance(
            remote_catalog.get("url"), str
        ):
            url = urlsplit(remote_catalog["url"])
            if (
                url.scheme != "https"
                or not url.hostname
                or url.username
                or url.password
                or url.query
                or url.fragment
                or not url.path.endswith("/catalog.json")
            ):
                raise RuntimeError("Invalid Remote runtime catalog package source")
        else:
            raise RuntimeError("Invalid Remote runtime catalog package source")
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
        "voiceHost": package / "bin" / ("ash-voice-host" + spec.executable_suffix),
        "collaborationServer": package
        / "bin"
        / ("ash-collaboration-server" + spec.executable_suffix),
        "livekit": package / "bin" / ("livekit-server" + spec.executable_suffix),
        "ripgrep": package / "ash-path" / spec.ripgrep_name,
        "tgrep": package / "ash-resources/tgrep" / ("tgrep" + spec.executable_suffix),
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
            "voiceHost",
            "collaborationServer",
            "livekit",
            "node",
            "ripgrep",
            "tgrep",
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


def load_protocol_metadata(repository_root: Path) -> Dict[str, object]:
    metadata = json.loads(
        (repository_root / "ash-rs/app-server-protocol/schema/metadata.json").read_text(
            encoding="utf-8"
        )
    )
    if (
        not isinstance(metadata, dict)
        or any(
            type(metadata.get(key)) is not int or metadata[key] < 0
            for key in ("major", "revision")
        )
        or not isinstance(metadata.get("schemaHash"), str)
        or re.fullmatch(r"sha256:[a-f0-9]{64}", metadata["schemaHash"]) is None
    ):
        raise RuntimeError("Generated App Server protocol metadata is invalid")
    return metadata
