"""Select Rust product tests affected by changed repository paths."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TUI_PRODUCTS = (
    "ash-tui",
    "ash-cli",
    "ash-app-server",
    "ash-app-server-daemon",
    "ash-remote-server",
)
GLOBAL_INPUTS = {
    Path("Cargo.toml"),
    Path("Cargo.lock"),
    Path("rust-toolchain.toml"),
    Path("justfile"),
    Path("scripts/cargo.py"),
    Path("scripts/ci_impact.py"),
    Path("build/runtime/ripgrep.py"),
    Path("third_party/ripgrep/runtime-lock.json"),
    Path(".github/workflows/rust-warnings.yml"),
}


def dependency_closure(metadata: dict, products: tuple[str, ...]) -> set[str]:
    members = set(metadata["workspace_members"])
    packages = {
        package["name"]: package
        for package in metadata["packages"]
        if package["id"] in members
    }
    missing = set(products).difference(packages)
    if missing:
        raise ValueError(f"unknown Cargo products: {sorted(missing)}")
    selected = set(products)
    pending = list(products)
    while pending:
        package = packages[pending.pop()]
        for dependency in package["dependencies"]:
            name = dependency["name"]
            if name in packages and name not in selected:
                selected.add(name)
                pending.append(name)
    return selected


def tui_affected(changed_files: list[str], metadata: dict, root: Path) -> bool:
    if not changed_files:
        return True
    members = set(metadata["workspace_members"])
    owners = sorted(
        (
            (Path(package["manifest_path"]).parent.relative_to(root), package["name"])
            for package in metadata["packages"]
            if package["id"] in members
        ),
        key=lambda owner: len(owner[0].parts),
        reverse=True,
    )
    required = dependency_closure(metadata, TUI_PRODUCTS)
    for raw in changed_files:
        if not isinstance(raw, str):
            raise ValueError("changed files must be paths")
        path = Path(raw)
        if path.is_absolute() or ".." in path.parts:
            return True
        if path in GLOBAL_INPUTS or path.parts[:1] == (".cargo",):
            return True
        if path.parts[:2] == ("build", "lib"):
            return True
        if path.suffix == ".md":
            continue
        if path.parts[:2] == ("scripts", "code"):
            return True
        if not path.parts or path.parts[0] not in {
            "app-rs",
            "code",
            "cli",
            "ash-rs",
            "third_party",
        }:
            continue
        owner = next(
            (name for directory, name in owners if path.is_relative_to(directory)), None
        )
        if owner is None or owner in required:
            return True
    return False


def main() -> None:
    changed_files = json.loads(os.environ["CHANGED_FILES_JSON"])
    if not isinstance(changed_files, list):
        raise ValueError("CHANGED_FILES_JSON must contain a list")
    metadata = json.loads(
        subprocess.check_output(
            ["cargo", "metadata", "--locked", "--no-deps", "--format-version", "1"],
            cwd=ROOT,
            text=True,
        )
    )
    affected = tui_affected(changed_files, metadata, ROOT)
    result = f"tui={str(affected).lower()}\n"
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(result)
    print(result.strip())


if __name__ == "__main__":
    main()
