"""Compose the Desktop runtime variant without changing the standalone source package."""

import argparse
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from build.lib.package import (
    package_build_id,
    package_files,
    valid_electron_version,
    validate_package_directory,
)
from build.lib.targets import target_spec
from build.release.remote import read_binding


def build_desktop_runtime(
    source: Path,
    output: Path,
    electron_version: str,
    remote_release: Path | None = None,
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
    if not {"livekitClient", "recognizer", "voiceHost"}.issubset(
        metadata["components"]
    ):
        raise ValueError(
            "Desktop requires bundled media; rebuild the backend with --media-distribution bundled"
        )
    if (
        "livekit" in metadata["components"]
        or (source / "bin" / f"livekit-server{spec.executable_suffix}").exists()
    ):
        raise ValueError(
            "Desktop must keep LiveKit Server in the independent hosting package"
        )
    if (source / "ash-resources/capabilities/media.json").exists():
        raise ValueError(
            "Desktop bundled media must not also declare an on-demand media package"
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
    args = parser.parse_args()
    print(
        build_desktop_runtime(
            args.source.resolve(),
            args.output.resolve(),
            args.electron_version,
            args.remote_release.resolve(),
        )
    )
