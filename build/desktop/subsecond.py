"""Run the pinned Subsecond driver against a development-only Cargo workspace."""

import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from build.lib.grammars import resolve_grammars_cargo_env
from build.lib.file_lock import exclusive_lock

ROOT = Path(__file__).resolve().parents[2]
ENTRY = "crates/app-server-subsecond"
DEV_DEPENDENCIES = re.compile(
    r"^\[(?:[^\n\]]*\.)?dev-dependencies(?:\.[^\n\]]+)?\][^\n]*\n.*?(?=^\[|\Z)",
    re.M | re.S,
)


def write_changed(path: Path, content: bytes) -> None:
    if not path.is_file() or path.read_bytes() != content:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)


def prepare_workspace(destination: Path) -> None:
    # Copy the worktree, including uncommitted and untracked source. The pinned
    # driver replays the whole Cargo workspace graph, including test-only edges.
    paths = subprocess.check_output(
        ["git", "ls-files", "-co", "--exclude-standard", "-z"], cwd=ROOT
    )
    tracked = set()
    for entry in paths.split(b"\0"):
        if not entry:
            continue
        name = os.fsdecode(entry)
        source = ROOT / name
        if not source.is_file():
            continue
        tracked.add(name)
        data = source.read_bytes()
        if source.name == "Cargo.toml":
            manifest = DEV_DEPENDENCIES.sub("", data.decode())
            if name == "Cargo.toml":
                manifest, count = re.subn(
                    r"^members = \[\n.*?^\]",
                    f'members = ["{ENTRY}"]',
                    manifest,
                    count=1,
                    flags=re.M | re.S,
                )
                if count != 1:
                    raise RuntimeError(
                        "Cannot isolate the App Server workspace members"
                    )
                manifest = re.sub(
                    r"^default-members = .*$",
                    f'default-members = ["{ENTRY}"]',
                    manifest,
                    flags=re.M,
                )
                manifest = manifest.replace('strip = "symbols"', "strip = false", 1)
            data = manifest.encode()
        write_changed(destination / name, data)
        target = destination / name
        mode = source.stat().st_mode & 0o777
        if target.stat().st_mode & 0o777 != mode:
            target.chmod(mode)
    inventory = destination / ".ash-subsecond-sources.json"
    if inventory.is_file():
        for name in set(json.loads(inventory.read_text())) - tracked:
            (destination / name).unlink(missing_ok=True)
    write_changed(inventory, json.dumps(sorted(tracked)).encode())
    template = ROOT / "build/desktop/subsecond"
    write_changed(
        destination / ENTRY / "Cargo.toml", (template / "Cargo.toml.in").read_bytes()
    )
    write_changed(
        destination / ENTRY / "src/main.rs", (template / "main.rs").read_bytes()
    )
    metadata = Path(".build/protocol/metadata.json")
    protocol = destination / metadata.parent
    if protocol.is_symlink():
        protocol.unlink()
    write_changed(destination / metadata, (ROOT / metadata).read_bytes())
    cache = destination / "third_party/.cache"
    if not cache.is_symlink():
        cache.symlink_to(ROOT / "third_party/.cache", target_is_directory=True)


def main() -> None:
    if sys.platform != "darwin" or platform.machine() != "arm64":
        raise RuntimeError(
            "Subsecond development is currently validated on Apple Silicon macOS"
        )
    dx = shutil.which(os.environ.get("ASH_SUBSECOND_DX", "dx"))
    if not dx:
        raise RuntimeError(
            "Install Dioxus CLI 0.7.10 or set ASH_SUBSECOND_DX to its executable"
        )
    dx = str(Path(dx).resolve())
    environment = dict(os.environ)
    sysroot = subprocess.check_output(
        ["rustc", "--print", "sysroot"], cwd=ROOT, text=True
    ).strip()
    environment["DYLD_LIBRARY_PATH"] = os.pathsep.join(
        value
        for value in (
            environment.get("ASH_SUBSECOND_LIBRARY_PATH"),
            str(Path(sysroot) / "lib"),
        )
        if value
    )
    version = subprocess.check_output(
        [dx, "--version"], env=environment, text=True
    ).split()
    if version[:2] != ["dioxus", "0.7.10"]:
        raise RuntimeError(
            f"Subsecond development requires dx 0.7.10, got {' '.join(version)}"
        )

    # The launcher owns this per-invocation workspace, profile and runtime pointer.
    workspace = ROOT / ".build/desktop/subsecond/workspace"
    pointer = Path(environment["ASH_DEV_APP_SERVER_GENERATION"])
    generation = json.loads(pointer.read_text())["runtime"]
    if not re.fullmatch(r"generations/[a-f0-9]{64}", generation):
        raise RuntimeError("Invalid development runtime selection")
    environment.update(resolve_grammars_cargo_env("aarch64-apple-darwin"))
    environment.update(
        ASH_DEV_RUNTIME_ROOT=str(pointer.parent / generation),
        CARGO_TARGET_DIR=str(ROOT / ".build/desktop/subsecond-target"),
        RUSTY_V8_MIRROR=str(ROOT / "third_party/.cache/v8"),
    )
    lock = workspace.parent / "driver.lock"
    with exclusive_lock(lock, create=True, blocking=False) as acquired:
        if not acquired:
            raise RuntimeError("Another Ash Subsecond driver is already running")
        prepare_workspace(workspace)
        subprocess.run(
            [
                dx,
                "serve",
                "--platform",
                "macos",
                "--hot-patch",
                "--interactive=false",
                "--addr",
                "127.0.0.1",
                "--port",
                environment.get("ASH_SUBSECOND_PORT", "39139"),
                "--package",
                "ash-app-server-subsecond",
                "--bin",
                "ash-app-server-subsecond",
                "--profile",
                "dev-small",
                "--args=--managed",
            ],
            cwd=workspace,
            env=environment,
            check=True,
        )


if __name__ == "__main__":
    main()
