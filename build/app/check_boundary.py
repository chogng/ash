"""Validate the single-root Cargo workspace and app product boundary."""

from __future__ import annotations

import re
import sys
from pathlib import Path


EXPECTED_APP_MEMBERS = {
    "app",
    "app/commands",
    "app/editor",
    "app/icons",
    "app/markdown",
    "app/keybindings",
    "app/settings",
    "app/terminal-runtime",
    "app/workbench",
    "app/zui",
}

RETIRED_PRODUCT_PATHS = {
    "app/composer",
    "app/src",
    "app/src/workbench_host",
    "app/src/workbench_host.rs",
    "app/workbench-model",
    "ash-rs/native",
    "ash-rs/agent-sidebar",
    "ash-rs/editor",
    "ash-rs/icons",
    "ash-rs/markdown",
    "ash-rs/renderer",
    "ash-rs/settings",
    "ash-rs/ui",
    "ash-rs/wgpu",
    "ash-rs/winit",
}

RETIRED_ZUI_SIBLING_PATHS = {
    "app/icon",
    "app/renderer",
    "app/wgpu",
    "app/winit",
    "app/zui-core",
}

RETIRED_UI_PACKAGE_NAMES = {
    "ash-agent-sidebar",
    "ash-editor",
    "ash-icons",
    "ash-markdown",
    "ash-renderer",
    "ash-settings",
    "ash-ui",
    "ash-wgpu",
    "ash-winit",
    "zui",
}


def fail(message: str) -> None:
    raise SystemExit(f"app boundary check failed: {message}")


def workspace_members(manifest_text: str) -> set[str]:
    workspace_section = re.search(
        r"(?ms)^\[workspace\]\s*(.*?)(?=^\[|\Z)", manifest_text
    )
    member_values = (
        re.search(r"(?ms)^members\s*=\s*\[(.*?)\]", workspace_section.group(1))
        if workspace_section
        else None
    )
    return (
        set(re.findall(r'"([^"]+)"', member_values.group(1)))
        if member_values
        else set()
    )


def package_name(manifest_text: str) -> str | None:
    package_section = re.search(r"(?ms)^\[package\]\s*(.*?)(?=^\[|\Z)", manifest_text)
    match = (
        re.search(r'^name\s*=\s*"([^"]+)"\s*$', package_section.group(1), re.MULTILINE)
        if package_section
        else None
    )
    return match.group(1) if match else None


def main() -> int:
    if len(sys.argv) != 4:
        fail("usage: check_boundary.py root-Cargo.toml app-Cargo.toml Cargo.lock")

    root_manifest_path = Path(sys.argv[1])
    app_manifest_path = Path(sys.argv[2])
    lock_path = Path(sys.argv[3])
    root_manifest = root_manifest_path.read_text(encoding="utf-8")
    app_manifest = app_manifest_path.read_text(encoding="utf-8")
    lock_text = lock_path.read_text(encoding="utf-8")
    repository_root = root_manifest_path.parent

    if "[workspace]" not in root_manifest:
        fail("root Cargo.toml does not define the workspace")
    if "[workspace]" in app_manifest:
        fail("app/Cargo.toml still defines a nested workspace")
    if package_name(app_manifest) != "app":
        fail(f"expected app package app, got {package_name(app_manifest)!r}")
    shared_keybinding_path = repository_root / "ash-rs" / "keybinding" / "Cargo.toml"
    if not shared_keybinding_path.exists():
        fail("shared ash-rs/keybinding crate is missing")
    shared_keybinding_manifest = shared_keybinding_path.read_text(encoding="utf-8")
    if package_name(shared_keybinding_manifest) != "ash-keybinding":
        fail("ash-rs/keybinding must provide the ash-keybinding package")
    forbidden_keybinding_dependencies = (
        "crossterm",
        "winit",
        "ash-ui",
        "ash-winit",
        "zui",
    )
    for dependency in forbidden_keybinding_dependencies:
        if re.search(rf"(?m)^{re.escape(dependency)}\s*=", shared_keybinding_manifest):
            fail(f"shared ash-keybinding depends on platform/UI crate: {dependency}")
    launch_path = repository_root / "app" / "workbench" / "remote" / "launch.rs"
    launch_text = launch_path.read_text(encoding="utf-8")
    if 'const DEFAULT_REMOTE_RUNTIME: &str = "ash-remote-server";' not in launch_text:
        fail("app Remote must default to the product-neutral ash-remote-server runtime")

    product_host_references = ("ash-cli", "ash-code/cli")
    boundary_sources = [
        *(repository_root / "app").rglob("Cargo.toml"),
        *(repository_root / "app").rglob("*.rs"),
    ]
    for source_path in boundary_sources:
        source_text = source_path.read_text(encoding="utf-8")
        for forbidden_reference in product_host_references:
            if forbidden_reference in source_text:
                fail(
                    f"app source references Ash Code product host: "
                    f"{source_path}: {forbidden_reference}"
                )

    members = workspace_members(root_manifest)
    missing_members = EXPECTED_APP_MEMBERS - members
    if missing_members:
        fail(f"root workspace is missing app members: {sorted(missing_members)}")
    if 'default-members = ["app"]' not in root_manifest:
        fail("root workspace must default to the app product")

    retired_paths = sorted(
        path for path in RETIRED_PRODUCT_PATHS if (repository_root / path).exists()
    )
    if retired_paths:
        fail(f"retired Native UI paths still exist: {retired_paths}")

    retired_zui_siblings = sorted(
        path for path in RETIRED_ZUI_SIBLING_PATHS if (repository_root / path).exists()
    )
    if retired_zui_siblings:
        fail(
            "zui implementation responsibilities escaped into sibling crates: "
            f"{retired_zui_siblings}"
        )

    for manifest_text in (root_manifest, app_manifest):
        if "ash-rs/native" in manifest_text or "ash-native" in manifest_text:
            fail("manifest still references the retired native workspace")

    for path in re.findall(r'^path\s*=\s*"([^"]+)"\s*$', app_manifest, re.MULTILINE):
        if path.startswith("../"):
            fail(f"app dependency still escapes through a cross-workspace path: {path}")

    for manifest_path in (repository_root / "ash-rs").rglob("Cargo.toml"):
        manifest_text = manifest_path.read_text(encoding="utf-8")
        package_name_match = re.search(
            r'^name\s*=\s*"([^"]+)"\s*$', manifest_text, re.MULTILINE
        )
        if (
            package_name_match
            and package_name_match.group(1) in RETIRED_UI_PACKAGE_NAMES
        ):
            fail(f"retired Native UI package remains under ash-rs: {manifest_path}")
        for retired_package_name in RETIRED_UI_PACKAGE_NAMES:
            if re.search(
                rf"^\s*{re.escape(retired_package_name)}\s*=",
                manifest_text,
                re.MULTILINE,
            ):
                fail(
                    f"shared backend manifest depends on retired Native UI package: {manifest_path}"
                )

    for build_path in (repository_root / "ash-rs").rglob("BUILD.bazel"):
        build_text = build_path.read_text(encoding="utf-8")
        for retired_package_name in RETIRED_UI_PACKAGE_NAMES:
            if re.search(rf"\b{re.escape(retired_package_name)}\b", build_text):
                fail(
                    f"shared backend BUILD file references retired Native UI package: {build_path}"
                )

    if (repository_root / "ash-rs" / "Cargo.toml").exists():
        fail("ash-rs/Cargo.toml still exists as a nested workspace manifest")
    if (repository_root / "app" / "Cargo.lock").exists():
        fail("app/Cargo.lock still exists; the root lockfile must be canonical")
    if (repository_root / "ash-rs" / "Cargo.lock").exists():
        fail("ash-rs/Cargo.lock still exists; the root lockfile must be canonical")
    if 'name = "app"' not in lock_text:
        fail("root Cargo.lock does not contain the app package")

    print(f"app boundary OK: {root_manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
