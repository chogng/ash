"""Read the Ash workspace package version from its Cargo manifest."""

import tomllib
from pathlib import Path


def read_workspace_version(manifest_path: Path) -> str:
    with manifest_path.open("rb") as manifest:
        data = tomllib.load(manifest)
    try:
        version = data["workspace"]["package"]["version"]
    except (KeyError, TypeError) as error:
        raise RuntimeError(
            f"Could not find [workspace.package].version in {manifest_path}"
        ) from error
    if not isinstance(version, str) or not version.strip():
        raise RuntimeError(
            f"[workspace.package].version must be a nonempty string in {manifest_path}"
        )
    return version
