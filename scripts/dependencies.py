#!/usr/bin/env python3
"""Check Cargo dependency declarations, ownership, versions, and unused entries."""

from __future__ import annotations

import argparse
from collections import defaultdict, deque
import json
from pathlib import Path
import re
import subprocess
import sys
import tomllib


ROOT = Path(__file__).resolve().parents[1]
SHEAR_VERSION = "1.13.4"
SECTIONS = ("dependencies", "build-dependencies", "dev-dependencies")
AGENT_HANDLERS = (
    "operations.rs",
    "session_operations.rs",
    "queue_operations.rs",
    "automation_execution.rs",
    "agent_selection.rs",
    "interaction_runtime.rs",
)


def read_toml(path: Path) -> dict:
    with path.open("rb") as stream:
        return tomllib.load(stream)


def dependency_sections(manifest: dict):
    for section in SECTIONS:
        yield section, manifest.get(section, {})
    for target, table in manifest.get("target", {}).items():
        for section in SECTIONS:
            yield f"target.{target}.{section}", table.get(section, {})


def declaration_errors(root: Path, metadata: dict) -> list[str]:
    errors = []
    members = set(metadata["workspace_members"])
    packages = [p for p in metadata["packages"] if p["id"] in members]
    member_paths = {Path(p["manifest_path"]).parent.resolve() for p in packages}
    root_workspace = read_toml(root / "Cargo.toml")["workspace"]
    workspace = root_workspace.get("dependencies", {})
    if root_workspace.get("metadata", {}).get("cargo-shear", {}).get("ignored"):
        errors.append(
            "Cargo.toml: put justified cargo-shear exceptions in the owning package, not the workspace"
        )
    for package in packages:
        path = Path(package["manifest_path"])
        manifest = read_toml(path)
        for section, dependencies in dependency_sections(manifest):
            for name, value in dependencies.items():
                dependency = {"version": value} if isinstance(value, str) else value
                label = f"{path.relative_to(root)} [{section}] {name}"
                if dependency.get("workspace") is True:
                    if name not in workspace:
                        errors.append(f"{label}: missing workspace dependency")
                    # Cargo may ignore an override; reject it rather than trusting the resolved graph.
                    forbidden = set(dependency) & {
                        "version",
                        "git",
                        "rev",
                        "branch",
                        "tag",
                        "path",
                        "registry",
                        "package",
                    }
                    if forbidden:
                        errors.append(
                            f"{label}: inherited source overrides {sorted(forbidden)}"
                        )
                    continue
                local = dependency.get("path")
                if local and (path.parent / local).resolve() in member_paths:
                    continue
                errors.append(
                    f"{label}: third-party dependencies must inherit workspace = true"
                )
    for name, value in workspace.items():
        dependency = {"version": value} if isinstance(value, str) else value
        if "git" in dependency and (
            not re.fullmatch(r"[0-9a-fA-F]{40}", dependency.get("rev", ""))
            or "branch" in dependency
            or "tag" in dependency
        ):
            errors.append(f"Cargo.toml {name}: pin Git dependencies with rev")
    return errors


def boundary_errors(root: Path, metadata: dict) -> list[str]:
    members = set(metadata["workspace_members"])
    packages = {p["name"]: p for p in metadata["packages"] if p["id"] in members}
    paths = {
        name: Path(p["manifest_path"]).relative_to(root).parts
        for name, p in packages.items()
    }
    edges = {
        name: sorted({d["name"] for d in p["dependencies"] if d["kind"] != "dev"})
        for name, p in packages.items()
    }
    errors = []
    for start, parts in paths.items():
        queue = deque([(start, [start])])
        visited = {start}
        while queue:
            current, chain = queue.popleft()
            for dependency in edges.get(current, []):
                if dependency in visited:
                    continue
                visited.add(dependency)
                next_chain = chain + [dependency]
                destination = paths.get(dependency, ())
                forbidden = (
                    (
                        parts[0] in {"ash-rs", "app"}
                        and dependency in {"ash-cli", "ash-tui"}
                    )
                    or (
                        parts[0] == "ash-rs" and destination and destination[0] == "app"
                    )
                    or (
                        start == "ash-app-server-daemon"
                        and dependency == "ash-app-server"
                    )
                    or (
                        start in {"ash-core-api", "ash-hooks"}
                        and dependency in {"ash-core", "ash-app-server"}
                    )
                    or (
                        start == "ash-keybinding"
                        and dependency
                        in {"crossterm", "winit", "zui", "ash-ui-components"}
                    )
                )
                if forbidden:
                    errors.append(
                        "forbidden dependency path: " + " -> ".join(next_chain)
                    )
                else:
                    queue.append((dependency, next_chain))
    return errors


def agent_handler_errors(root: Path) -> list[str]:
    """Keep Agent handlers on the contract while server assembly selects Core owners."""
    errors = []
    implementation = re.compile(
        r"\bash_core\b|\bself\s*\.\s*"
        r"(?:threads|multi_agent|turn_backend|turn_executor_snapshot)\b"
    )
    for name in AGENT_HANDLERS:
        path = root / "ash-rs/app-server/src/server" / name
        if not path.is_file():
            errors.append(f"{path.relative_to(root)}: missing Agent handler; update its boundary rule")
            continue
        match = implementation.search(path.read_text())
        if match:
            errors.append(
                f"{path.relative_to(root)}: Agent handlers must use core-api operations; "
                f"Core implementation access {match.group()!r} belongs in server assembly"
            )
    return errors


def duplicate_versions(lock: dict) -> dict[str, set[str]]:
    versions = defaultdict(set)
    for package in lock["package"]:
        identity = package["version"]
        source = package.get("source", "")
        if source and source != "registry+https://github.com/rust-lang/crates.io-index":
            identity += " " + source
        versions[package["name"]].add(identity)
    return {name: values for name, values in versions.items() if len(values) > 1}


def version_errors(actual: dict[str, set[str]], policy: dict) -> list[str]:
    errors = []
    accepted = {}
    for entry in policy.get("multiple_versions", []):
        name = entry["name"]
        versions = entry["versions"]
        if (
            name in accepted
            or len(set(versions)) != len(versions)
            or len(versions) < 2
            or not entry.get("reason", "").strip()
        ):
            errors.append(f"invalid multiple-version policy for {name}")
        accepted[name] = set(versions)
    for name in sorted(actual.keys() | accepted.keys()):
        if actual.get(name, set()) != accepted.get(name, set()):
            errors.append(
                f"{name}: resolved versions {sorted(actual.get(name, set()))}; "
                f"reviewed versions {sorted(accepted.get(name, set()))}. "
                f"Inspect cargo tree --workspace --target all -i {name}; update the exact versions and reason."
            )
    return errors


def shear_errors(
    executable: str, root: Path, member_dirs: set[Path] | None = None
) -> list[str]:
    version = subprocess.check_output([executable, "--version"], text=True).strip()
    if version != f"Version: {SHEAR_VERSION}":
        return [f"expected cargo-shear {SHEAR_VERSION}, got {version}"]
    result = subprocess.run(
        [executable, "--locked", "--deny-warnings", "--format", "json"],
        cwd=root,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode not in (0, 1):
        return [f"cargo-shear failed: {result.stderr or result.stdout}"]
    report = json.loads(result.stdout)
    errors = []
    workspace = read_toml(root / "Cargo.toml")["workspace"].get("dependencies", {})
    for finding in report["findings"]:
        message = f"{finding.get('file', '')}: {finding['message']}"
        if finding["code"] == "shear/unused_workspace_dependency":
            name = finding["message"].split("`")[1]
            dependency = workspace.get(name, {})
            # A first-party catalog entry adds no dependency edge or compilation unit.
            if (
                isinstance(dependency, dict)
                and "path" in dependency
                and (root / dependency["path"]).resolve() in (member_dirs or set())
            ):
                continue
        if finding["code"] == "shear/unlinked_files":
            # File organization is outside this dependency gate. Never suppress dependency findings.
            print(f"cargo-shear file note: {message}", file=sys.stderr)
        else:
            errors.append(message)
    if result.returncode and not report["findings"]:
        errors.append(f"cargo-shear failed without findings: {result.stderr}")
    return errors


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--shear", default="cargo-shear", help="path to pinned cargo-shear executable"
    )
    args = parser.parse_args(arguments)
    try:
        metadata = json.loads(
            subprocess.check_output(
                [
                    "cargo",
                    "metadata",
                    "--locked",
                    "--offline",
                    "--no-deps",
                    "--format-version",
                    "1",
                ],
                cwd=ROOT,
                text=True,
            )
        )
        duplicates = duplicate_versions(read_toml(ROOT / "Cargo.lock"))
        errors = declaration_errors(ROOT, metadata)
        errors += boundary_errors(ROOT, metadata)
        errors += agent_handler_errors(ROOT)
        errors += version_errors(
            duplicates, read_toml(ROOT / ".cargo/dependencies.toml")
        )
        members = set(metadata["workspace_members"])
        member_dirs = {
            Path(package["manifest_path"]).parent.resolve()
            for package in metadata["packages"]
            if package["id"] in members
        }
        errors += shear_errors(args.shear, ROOT, member_dirs)
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f"Dependency check failed: {error}", file=sys.stderr)
        return 1
    for error in errors:
        print(error, file=sys.stderr)
    if errors:
        return 1
    print(
        f"Dependency checks passed: {len(metadata['workspace_members'])} members, {len(duplicates)} reviewed multiple-version packages; cargo-shear {SHEAR_VERSION}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
