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


def build_desktop_runtime(source: Path, output: Path, electron_version: str) -> Path:
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
    declared = metadata["javascriptRuntime"].get("electronVersion")
    if declared is not None and declared != electron_version:
        raise ValueError("Backend Electron contract differs from this Desktop build")
    if output.exists():
        raise ValueError(f"Refusing to replace Desktop runtime: {output}")
    output.mkdir(parents=True)
    try:
        excluded = {
            source / "ash-resources": {"node"},
            source / "ash-resources/licenses": {"node"},
        }
        for entry in source.iterdir():
            if entry.name in (".lease", "ash-package.json"):
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
        if signing := metadata.get("systemSigning"):
            signing["artifacts"] = [
                record for record in signing["artifacts"] if record["name"] != "node"
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
    args = parser.parse_args()
    print(
        build_desktop_runtime(
            args.source.resolve(), args.output.resolve(), args.electron_version
        )
    )
