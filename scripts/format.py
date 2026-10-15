#!/usr/bin/env python3
"""Format repository sources or check the configured formatters."""

from __future__ import annotations

import argparse
import difflib
from fnmatch import fnmatchcase
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import tomllib
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
LANGUAGES = ("just", "rust", "python", "typescript", "config")
CONFIGURATION = (
    ".just-version",
    "Cargo.toml",
    "rust-toolchain.toml",
    "rustfmt.toml",
    "tsfmt.json",
    ".prettierrc.toml",
    ".prettierignore",
    ".editorconfig",
    "pyproject.toml",
    "ruff.toml",
    ".ruff.toml",
    "scripts/pyproject.toml",
)


@dataclass(frozen=True)
class Command:
    name: str
    args: tuple[str, ...]
    cwd: Path | None = None


def rust_command(check: bool) -> Command:
    metadata = json.loads(
        subprocess.check_output(
            ["cargo", "metadata", "--no-deps", "--format-version", "1"],
            cwd=REPOSITORY_ROOT,
            encoding="utf-8",
        )
    )
    members = set(metadata["workspace_members"])
    packages = []
    for package in metadata["packages"]:
        if package["id"] not in members:
            continue
        manifest = Path(package["manifest_path"]).relative_to(REPOSITORY_ROOT)
        # Cargo can include path dependencies from copied upstream workspaces.
        if "vendor" not in manifest.parts and "third_party" not in manifest.parts:
            packages.append(package["name"])
    if not packages:
        raise ValueError("No first-party Rust workspace packages found.")
    args = ["cargo", "fmt", "--manifest-path", "Cargo.toml"]
    for package in sorted(packages):
        args.extend(("--package", package))
    if check:
        args.extend(("--", "--check"))
    return Command("Rust", tuple(args))


def commands(check: bool, language: str | None = None) -> tuple[Command, ...]:
    if language == "rust":
        return (rust_command(check),)
    just = ["just", "--unstable", "--fmt"]
    ruff = (
        REPOSITORY_ROOT
        / "scripts"
        / ".venv"
        / ("Scripts/ruff.exe" if os.name == "nt" else "bin/ruff")
    )
    python = [str(ruff), "format"]
    if check:
        just.append("--check")
        python.append("--check")
    python.extend(
        (
            "build",
            "scripts",
        )
    )
    pnpm = package_manager() if language in (None, "typescript", "config") else ""
    action = "" if check else ":fix"
    configured = {
        "just": lambda: Command("Just", tuple(just)),
        "rust": lambda: rust_command(check),
        "python": lambda: Command("Python", tuple(python)),
        "typescript": lambda: Command(
            "TypeScript/JavaScript", (pnpm, f"format:ts{action}")
        ),
        "config": lambda: Command(
            "Configuration/documentation", (pnpm, f"format:config{action}")
        ),
    }
    return tuple(
        create()
        for key, create in configured.items()
        if language is None or key == language
    )


def package_manager() -> str:
    pnpm = shutil.which("pnpm")
    if pnpm is None:
        raise FileNotFoundError("Install the pnpm version declared in package.json.")
    return pnpm


def check_just_version(root: Path) -> None:
    expected = (root / ".just-version").read_text(encoding="utf-8").strip()
    actual = subprocess.check_output(["just", "--version"], encoding="utf-8").strip()
    if actual != f"just {expected}":
        raise ValueError(f"Install Just {expected} from .just-version; found {actual}.")


def git(*args: str) -> bytes:
    return subprocess.check_output(["git", *args], cwd=REPOSITORY_ROOT)


def names(data: bytes) -> set[str]:
    return {path.decode("utf-8") for path in data.split(b"\0") if path}


def select_files(paths: list[str], changed: str | None) -> set[str]:
    if git("ls-files", "--unmerged", "-z"):
        raise ValueError("Resolve index conflicts before checking formatting.")
    inventory = names(
        git("ls-files", "--cached", "--others", "--exclude-standard", "-z")
    )
    if changed is not None:
        revision = (
            git("rev-parse", "--verify", "--end-of-options", f"{changed}^{{commit}}")
            .decode()
            .strip()
        )
        base = git("merge-base", revision, "HEAD").decode().strip()
        inventory &= names(
            git(
                "diff",
                "--no-renames",
                "--name-only",
                "--diff-filter=ACMT",
                "-z",
                base,
                "--",
            )
        ) | names(git("ls-files", "--others", "--exclude-standard", "-z"))
    if paths:
        selected: set[str] = set()
        for path in paths:
            absolute = (REPOSITORY_ROOT / path).resolve()
            if not absolute.is_relative_to(REPOSITORY_ROOT):
                raise ValueError(f"Source path must belong to the repository: {path}")
            name = absolute.relative_to(REPOSITORY_ROOT).as_posix()
            matches = {
                item
                for item in inventory
                if name == "." or item == name or item.startswith(name + "/")
            }
            if not matches:
                raise ValueError(f"No repository files matched: {path}")
            selected |= matches
        inventory = selected
    return {
        name
        for name in inventory
        if (REPOSITORY_ROOT / name).is_file()
        and not (REPOSITORY_ROOT / name).is_symlink()
    }


def snapshot_files(snapshot: Path, selected: set[str]) -> None:
    for name in selected | set(CONFIGURATION):
        source = REPOSITORY_ROOT / name
        if source.is_file() and not source.is_symlink():
            target = snapshot / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read_bytes())


def chunks(paths: list[str]):
    # Stay below Windows command-line limits even when a branch changes many files.
    batch: list[str] = []
    length = 0
    for path in paths:
        if batch and length + len(path) > 6000:
            yield batch
            batch, length = [], 0
        batch.append(path)
        length += len(path) + 3
    if batch:
        yield batch


def scoped_commands(
    check: bool, root: Path, files: set[str], language: str | None
) -> list[Command]:
    configured = []
    mode = "--check" if check else "--write"
    enabled = set(LANGUAGES) if language is None else {language}
    if "just" in enabled and "justfile" in files:
        configured.append(
            Command(
                "Just",
                (
                    "just",
                    "--unstable",
                    "--fmt",
                    "--justfile",
                    str(root / "justfile"),
                    *(("--check",) if check else ()),
                ),
                root,
            )
        )
    if "python" in enabled:
        ruff = (
            REPOSITORY_ROOT
            / "scripts/.venv"
            / ("Scripts/ruff.exe" if os.name == "nt" else "bin/ruff")
        )
        for batch in chunks(
            [
                str(root / name)
                for name in sorted(files)
                if name.endswith(".py") and name.startswith(("build/", "scripts/"))
            ]
        ):
            configured.append(
                Command(
                    "Python",
                    (
                        str(ruff),
                        "format",
                        *(("--check",) if check else ()),
                        "--",
                        *batch,
                    ),
                    root,
                )
            )
    frontend = [
        name
        for name in files
        if Path(name).suffix
        in {".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"}
    ]
    config = [
        str(root / name)
        for name in sorted(files)
        if Path(name).suffix
        in {".json", ".jsonc", ".yml", ".yaml", ".md", ".css", ".html"}
    ]
    if ("typescript" in enabled and frontend) or ("config" in enabled and config):
        bun = subprocess.check_output(
            [package_manager(), "exec", "bun", "--print", "process.execPath"],
            cwd=REPOSITORY_ROOT,
            encoding="utf-8",
        ).strip()
        if "typescript" in enabled and frontend:
            configured.append(
                Command(
                    "TypeScript/JavaScript",
                    (
                        bun,
                        str(REPOSITORY_ROOT / "build/format.ts"),
                        mode,
                        "--content-root",
                        str(root),
                    ),
                )
            )
        if "config" in enabled:
            for batch in chunks(config):
                configured.append(
                    Command(
                        "Configuration/documentation",
                        (
                            bun,
                            str(
                                REPOSITORY_ROOT
                                / "node_modules/prettier/bin/prettier.cjs"
                            ),
                            mode,
                            "--config",
                            str(root / ".prettierrc.toml"),
                            "--ignore-path",
                            str(root / ".prettierignore"),
                            "--",
                            *batch,
                        ),
                        root,
                    )
                )
    return configured


def scoped_rust(check: bool, root: Path, files: set[str]) -> bool:
    candidates = sorted(
        name
        for name in files
        if name.endswith(".rs")
        and not {"vendor", "third_party"}.intersection(Path(name).parts)
    )
    if not candidates:
        return True
    workspace = tomllib.loads((root / "Cargo.toml").read_text(encoding="utf-8"))[
        "workspace"
    ]
    channel = tomllib.loads((root / "rust-toolchain.toml").read_text(encoding="utf-8"))[
        "toolchain"
    ]["channel"]
    success = True
    for name in candidates:
        if not any(fnmatchcase(name, member + "/*") for member in workspace["members"]):
            continue
        path = root / name
        original = path.read_bytes()
        # stdin formats this file alone: an out-of-line `mod` must not pull in
        # another file's contents or expand the incremental scope.
        result = subprocess.run(
            [
                "rustup",
                "run",
                channel,
                "rustfmt",
                "--config-path",
                str(root / "rustfmt.toml"),
                "--emit",
                "stdout",
            ],
            cwd=root,
            input=original,
            capture_output=True,
            check=False,
        )
        if result.returncode:
            print(
                f"Rust formatter failed: {name}\n{result.stderr.decode('utf-8')}",
                file=sys.stderr,
            )
            success = False
        elif result.stdout != original:
            if check:
                print(f"File not formatted: {name}", file=sys.stderr)
                print(
                    "".join(
                        difflib.unified_diff(
                            original.decode().splitlines(True),
                            result.stdout.decode().splitlines(True),
                            fromfile=name,
                            tofile=name,
                        )
                    ),
                    file=sys.stderr,
                )
                success = False
            else:
                path.write_bytes(result.stdout)
    return success


def execute(configured: list[Command] | tuple[Command, ...]) -> bool:
    failures = []
    with ThreadPoolExecutor(max_workers=max(1, min(5, len(configured)))) as executor:
        for name, returncode, output in executor.map(run, configured):
            if returncode:
                failures.append(name)
                print(f"==> {name} formatter failed\n{output}", file=sys.stderr)
    if failures:
        print(f"Formatting failed: {', '.join(sorted(set(failures)))}", file=sys.stderr)
    return not failures


def scoped(
    check: bool,
    paths: list[str],
    changed: str | None,
    language: str | None,
) -> int:
    selected = select_files(paths, changed)
    if not selected:
        print("No selected files need formatting checks.")
        return 0
    with tempfile.TemporaryDirectory(prefix="ash-format-") as directory:
        root = Path(directory)
        snapshot_files(root, selected)
        originals = {name: (root / name).read_bytes() for name in selected}
        success = execute(scoped_commands(check, root, selected, language))
        if language in (None, "rust"):
            success = scoped_rust(check, root, selected) and success
        if not success:
            return 1
        if not check:
            updates = {
                name: (root / name).read_bytes()
                for name in selected
                if (root / name).read_bytes() != originals[name]
            }
            # Another editor or agent may have changed a file during formatting.
            # Validate all write targets before applying any output.
            for name in updates:
                if (REPOSITORY_ROOT / name).read_bytes() != originals[name]:
                    raise ValueError(f"File changed during formatting; retry: {name}")
            for name, contents in updates.items():
                (REPOSITORY_ROOT / name).write_bytes(contents)
        print(
            f"Formatting {'checked' if check else 'formatted'} {len(selected)} selected files."
        )
    return 0


def run(command: Command) -> tuple[str, int, str]:
    try:
        if command.name == "Just":
            check_just_version(command.cwd or REPOSITORY_ROOT)
        result = subprocess.run(
            command.args,
            cwd=command.cwd or REPOSITORY_ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            encoding="utf-8",
            check=False,
        )
    except (OSError, ValueError) as error:
        return command.name, 1, f"$ {shlex.join(command.args)}\n{error}\n"
    return command.name, result.returncode, result.stdout


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--check",
        action="store_true",
        help="check formatting without modifying files",
    )
    parser.add_argument(
        "--language",
        choices=LANGUAGES,
        help="run only the selected language's formatter",
    )
    parser.add_argument(
        "--changed",
        metavar="REF",
        help="select branch and working-tree changes since the merge base with REF",
    )
    parser.add_argument("paths", nargs="*", help="repository files or directories")
    args = parser.parse_args(arguments)
    try:
        if args.paths or args.changed is not None:
            return scoped(args.check, args.paths, args.changed, args.language)
        return int(not execute(commands(args.check, args.language)))
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f"Formatting failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
