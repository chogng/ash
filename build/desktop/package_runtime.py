"""Compose the Desktop runtime variant without changing the standalone source package."""

import argparse
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from build.lib.package import (
    file_sha256,
    package_build_id,
    package_files,
    valid_electron_version,
    validate_package_directory,
)
from build.lib.package_binaries import build_binaries
from build.lib.desktop_capabilities import (
    split_debuggers,
    split_typescript,
    stage_computer_use,
    stage_native_grammars,
)
from build.lib.targets import target_spec
from build.lib.v8 import resolve_v8_cargo_env
from build.release.remote import read_binding

WINDOWS_ICU_DIGEST = (
    Path(__file__).resolve().parents[2] / "third_party/v8/windows-desktop-icu.sha256"
)


def desktop_media_is_bundled(resources: Path, metadata: dict) -> bool:
    media_components = {"livekitClient", "recognizer", "voiceHost"}
    bundled = media_components & metadata["components"].keys()
    descriptor = "ash-resources/capabilities/media.json"
    if bundled == media_components and not (resources / descriptor).exists():
        return True
    if (
        metadata["target"] == "x86_64-pc-windows-msvc"
        and not bundled
        and descriptor in metadata["files"]
        and (resources / descriptor).is_file()
    ):
        return False
    raise ValueError(
        "Desktop requires bundled media or a product-bound Windows media package"
    )


def replace_desktop_code_mode_host(
    resources: Path, metadata: dict, binary: Path
) -> None:
    spec = target_spec(metadata["target"])
    destination = resources / "bin" / spec.code_mode_host_name
    shutil.copy2(binary, destination)
    if metadata["buildProfile"] == "release" and os.environ.get("ASH_SYMBOLS_DIR"):
        from build.release.symbols import SymbolStore

        SymbolStore(
            Path(os.environ["ASH_SYMBOLS_DIR"]), WINDOWS_ICU_DIGEST.parents[2]
        ).collect(binary, destination, spec.target)
    digest = file_sha256(destination)
    metadata["components"]["codeModeHost"]["binarySha256"] = digest
    metadata["files"][f"bin/{spec.code_mode_host_name}"] = digest


def build_shared_icu_host(profile: str, electron_icu: Path) -> Path | None:
    if (
        file_sha256(electron_icu)
        != WINDOWS_ICU_DIGEST.read_text(encoding="ascii").strip()
    ):
        raise RuntimeError(
            "Packaged Electron ICU differs from the pinned rusty-v8 data"
        )
    spec = target_spec("x86_64-pc-windows-msvc")
    pinned_v8 = resolve_v8_cargo_env(spec)
    if pinned_v8.get("ASH_V8_EMBEDDED_ICU") != "1":
        return None
    return build_binaries(
        WINDOWS_ICU_DIGEST.parents[2],
        spec,
        {"ash-code-mode-host": None},
        cargo="cargo",
        cargo_profile=profile,
        environ=os.environ | pinned_v8 | {"ASH_V8_ELECTRON_ICU": "1"},
    )["ash-code-mode-host"]


def build_desktop_runtime(
    source: Path,
    output: Path,
    electron_version: str,
    remote_release: Path | None = None,
    windows_electron_icu: Path | None = None,
    capability_archives: Path | None = None,
) -> Path:
    source, output = source.resolve(), output.resolve()
    if source == output or source in output.parents or output in source.parents:
        raise ValueError(
            "Desktop output and source package must be separate directories"
        )
    if not valid_electron_version(electron_version):
        raise ValueError("Invalid Desktop Electron version")
    metadata = json.loads((source / "ash-package.json").read_text(encoding="utf-8"))
    spec = target_spec(metadata["target"])
    if not (spec.is_windows or "apple-darwin" in spec.target):
        raise ValueError("Desktop release runtime requires Windows or macOS")
    validate_package_directory(source, spec)
    if remote_release is not None:
        metadata["remoteRuntimeCatalog"] = read_binding(remote_release, metadata)
    if metadata.get("remoteRuntimeCatalog", {}).get("path"):
        raise ValueError(
            "Desktop must bind a network Remote release, not bundle remote archives"
        )
    desktop_media_is_bundled(source, metadata)
    if (
        "livekit" in metadata["components"]
        or (source / "bin" / f"livekit-server{spec.executable_suffix}").exists()
    ):
        raise ValueError(
            "Desktop must keep LiveKit Server in the independent hosting package"
        )
    declared = metadata["javascriptRuntime"].get("electronVersion")
    if declared is not None and declared != electron_version:
        raise ValueError("Backend Electron contract differs from this Desktop build")
    if output.exists():
        raise ValueError(f"Refusing to replace Desktop runtime: {output}")
    output.mkdir(parents=True)
    try:
        excluded = {
            source / "bin": {spec.remote_server_name},
            source / "ash-resources": {"node"},
            source / "ash-resources/licenses": {"node"},
        }
        for entry in source.iterdir():
            if entry.name in (".lease", "ash-package.json", "ash-remote-runtimes"):
                continue
            if entry.is_dir():
                shutil.copytree(
                    entry,
                    output / entry.name,
                    symlinks=True,
                    ignore=lambda directory, names: excluded.get(
                        Path(directory), set()
                    ),
                )
            else:
                shutil.copy2(entry, output / entry.name)
        metadata["components"].pop("node", None)
        metadata["components"].pop("remoteServer", None)
        if capability_archives is not None:
            if spec.target != "x86_64-pc-windows-msvc" or metadata.get("systemSigning"):
                raise ValueError(
                    "Downloadable Desktop capabilities require an unsigned Windows x64 staging package"
                )
            capability_archives.mkdir(parents=True, exist_ok=True)
            staged = Path(
                tempfile.mkdtemp(
                    prefix="desktop-capabilities-", dir=capability_archives
                )
            )
            try:
                split_typescript(output, staged, metadata, spec, capability_archives)
                split_debuggers(output, staged, metadata, spec, capability_archives)
                stage_computer_use(output, staged, metadata, spec, capability_archives)
                stage_native_grammars(
                    output, staged, metadata, spec, capability_archives
                )
            except BaseException:
                shutil.rmtree(staged)
                raise
            if metadata["buildProfile"] == "release":
                shutil.rmtree(staged)
        if windows_electron_icu is not None and not metadata.get("systemSigning"):
            if spec.target != "x86_64-pc-windows-msvc":
                raise ValueError("Shared Electron ICU is configured for Windows x64")
            host = build_shared_icu_host(metadata["buildProfile"], windows_electron_icu)
            if host is not None:
                replace_desktop_code_mode_host(output, metadata, host)
        if signing := metadata.get("systemSigning"):
            signing["artifacts"] = [
                record
                for record in signing["artifacts"]
                if record["name"] not in {"node", "remoteServer"}
            ]
        metadata["javascriptRuntime"] = {
            "kind": "hostProvidedNode",
            "electronVersion": electron_version,
        }
        identity = {
            key: value
            for key, value in metadata.items()
            if key not in ("files", "buildId")
        }
        files = package_files(output)
        metadata.update(files=files, buildId=package_build_id(identity, files))
        (output / "ash-package.json").write_text(
            json.dumps(metadata, indent=2) + "\n", encoding="utf-8"
        )
        validate_package_directory(output, spec)
    except BaseException:
        shutil.rmtree(output)
        raise
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--electron-version", required=True)
    parser.add_argument("--remote-release", type=Path, required=True)
    parser.add_argument("--windows-electron-icu", type=Path)
    parser.add_argument("--capability-archive-dir", type=Path)
    args = parser.parse_args()
    print(
        build_desktop_runtime(
            args.source.resolve(),
            args.output.resolve(),
            args.electron_version,
            args.remote_release.resolve(),
            args.windows_electron_icu,
            args.capability_archive_dir.resolve()
            if args.capability_archive_dir is not None
            else None,
        )
    )
