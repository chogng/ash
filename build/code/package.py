"""Compose a managed Code release from a verified shared runtime package."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT))

from build.lib.targets import target_spec  # noqa: E402
from build.ash_rs.cargo import validate_input_binary  # noqa: E402
from build.ash_rs.layout import file_sha256  # noqa: E402
from build.ash_rs.layout import package_build_id  # noqa: E402
from build.ash_rs.layout import package_files  # noqa: E402
from build.ash_rs.layout import validate_package_directory  # noqa: E402
from build.ash_rs.layout import write_json  # noqa: E402


def build_code_package(
    runtime_package: Path,
    output: Path,
    cli_binary: Path,
    update_public_key: str,
) -> None:
    runtime_package = runtime_package.expanduser().resolve()
    output = output.expanduser().resolve()
    if output.exists():
        raise RuntimeError(f"Refusing to replace existing Code package: {output}")
    if re.fullmatch(r"[a-f0-9]{64}", update_public_key) is None:
        raise RuntimeError(
            "Code packages require a 32-byte hexadecimal update public key"
        )
    metadata = json.loads(
        (runtime_package / "ash-package.json").read_text(encoding="utf-8")
    )
    target = metadata.get("target")
    if not isinstance(target, str):
        raise RuntimeError("Shared runtime package has no target")
    spec = target_spec(target)
    validate_package_directory(runtime_package, spec)
    components = metadata["components"]
    if (
        "cli" in components
        or "app" in components
        or metadata.get("javascriptRuntime") != {"kind": "packagedNode"}
        or metadata.get("buildProfile") != "release"
        or "systemSigning" in metadata
    ):
        raise RuntimeError("Code release requires an unsigned packaged-Node runtime")
    cli_binary = validate_input_binary(
        cli_binary, "Ash CLI", "--cli-bin", spec.is_windows
    )

    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.partial-", dir=output.parent)
    )
    try:
        shutil.copytree(runtime_package, staging, dirs_exist_ok=True)
        cli = staging / "bin" / spec.cli_name
        shutil.copy2(cli_binary, cli)
        components["cli"] = {
            "source": "cargo-build",
            "binarySha256": file_sha256(cli),
            "updatePublicKey": update_public_key,
        }
        metadata["files"] = package_files(staging)
        identity = {
            key: value
            for key, value in metadata.items()
            if key not in ("buildId", "files")
        }
        metadata["buildId"] = package_build_id(identity, metadata["files"])
        write_json(staging / "ash-package.json", metadata)
        validate_package_directory(staging, spec)
        staging.rename(output)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-package", type=Path, required=True)
    parser.add_argument("--package-dir", type=Path, required=True)
    parser.add_argument("--cli-bin", type=Path, required=True)
    parser.add_argument("--update-public-key", required=True)
    args = parser.parse_args(arguments)
    build_code_package(
        args.runtime_package, args.package_dir, args.cli_bin, args.update_public_key
    )
    print(f"Built Code package at {args.package_dir.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
