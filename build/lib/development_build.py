"""Reuse development build discovery while Cargo remains the artifact authority."""

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import time
import tomllib
import uuid


def _stamp(path: Path) -> list[int] | None:
    try:
        stat = path.stat()
        return [stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_ino]
    except FileNotFoundError:
        return None


def _sources(roots: list[str], tracked: list[str], checked: dict | None = None) -> dict:
    files = {Path(name) for name in tracked}
    for name in roots:
        for directory, children, names in os.walk(name):
            if any(
                (Path(directory) / child).is_symlink()
                or getattr((Path(directory) / child).lstat(), "st_file_attributes", 0)
                & 0x400
                for child in children
            ):
                raise OSError("source directory symlinks require Cargo discovery")
            children[:] = [
                child
                for child in children
                if child
                not in {".git", ".build", "target", "node_modules", "__pycache__"}
            ]
            files.update(Path(directory) / name for name in names)
    result = {}
    for path in sorted(files):
        before = _stamp(path)
        if before is None:
            result[str(path)] = None
            continue
        cached = checked.get(str(path)) if checked is not None else None
        if cached and cached[:4] == before:
            result[str(path)] = cached
            continue
        with path.open("rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
        if before != _stamp(path):
            raise OSError("source changed while collecting build inputs")
        result[str(path)] = [*before, digest]
        if checked is not None:
            checked[str(path)] = result[str(path)]
    return result


def _configuration(root: Path, command: list[str]) -> str:
    # Include the complete workspace manifest set, including new glob members and
    # path dependencies. This discovery never substitutes its own feature resolver.
    files = {root / "Cargo.toml", root / "Cargo.lock", Path(__file__)}
    pending = [root / "Cargo.toml"]
    visited = set()
    while pending:
        manifest = pending.pop().resolve()
        if manifest in visited:
            continue
        visited.add(manifest)
        files.add(manifest)
        if not manifest.is_file():
            continue
        document = tomllib.loads(manifest.read_text(encoding="utf-8"))
        for pattern in document.get("workspace", {}).get("members", []):
            pending.extend(
                path / "Cargo.toml" for path in manifest.parent.glob(pattern)
            )

        def paths(table):
            if isinstance(table, dict):
                for value in table.values():
                    if isinstance(value, dict) and isinstance(value.get("path"), str):
                        pending.append(manifest.parent / value["path"] / "Cargo.toml")
                    paths(value)

        paths(document)
    cargo_home = Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo"))
    rustup_home = Path(os.environ.get("RUSTUP_HOME", Path.home() / ".rustup"))
    files.add(rustup_home / "settings.toml")
    for directory in [root, *root.parents, cargo_home.parent]:
        for name in [
            ".cargo/config",
            ".cargo/config.toml",
            "rust-toolchain",
            "rust-toolchain.toml",
        ]:
            files.add(directory / name)
    files.update([cargo_home / "config", cargo_home / "config.toml"])
    digest = hashlib.sha256(
        json.dumps([command, dict(os.environ)], sort_keys=True).encode()
    )
    for path in sorted(files):
        digest.update(str(path).encode())
        digest.update(path.read_bytes() if path.is_file() else b"<missing>")
    # Rustup shims keep the same identity across toolchain updates.
    tools = list((rustup_home / "toolchains").glob("*/bin/rustc*"))
    tools += [
        Path(path) for name in [command[0], "rustc"] if (path := shutil.which(name))
    ]
    digest.update(
        json.dumps({str(path): _stamp(path) for path in tools}, sort_keys=True).encode()
    )
    return digest.hexdigest()


class DevelopmentBuildPlan:
    """Cache successful Desktop feature groups under the builder's OS lock.

    A hit requires the same Cargo configuration, source contents and artifact
    identities. Registry/git package sources remain Cargo's versioned inputs;
    local packages and build-script declarations are checked on every request.
    """

    def __init__(self, root: Path, command: list[str], directory: Path):
        self.root = root
        self.command = command
        self.path = directory / "build-plan.json"
        self.key = _configuration(root, command)
        self.started = time.time_ns()
        self.groups = {}
        self.before = {}
        # Shared dependencies occur in several isolated feature groups. Content
        # checks may be shared within one invocation, never across requests or
        # across a compiler run that may execute build scripts.
        self.checked = {}
        self.packages = None
        try:
            saved = json.loads(self.path.read_text(encoding="utf-8"))
            if saved["version"] == 1 and saved["key"] == self.key:
                if not isinstance(saved["packages"], list) or not all(
                    isinstance(name, str) for name in saved["packages"]
                ):
                    raise ValueError("invalid cached package names")
                self.packages = set(saved["packages"])
                if not isinstance(saved["groups"], dict):
                    raise ValueError("invalid cached groups")
                for entry in saved["groups"].values():
                    if (
                        not isinstance(entry, dict)
                        or not all(
                            isinstance(entry.get(name), dict)
                            for name in ["outputs", "sources", "artifacts"]
                        )
                        or not all(
                            isinstance(entry.get(name), list)
                            and all(isinstance(path, str) for path in entry[name])
                            for name in ["roots", "tracked"]
                        )
                    ):
                        raise ValueError("invalid cached group inputs")
                self.groups = saved["groups"]
        except (OSError, ValueError, KeyError, TypeError):
            self.packages = None
            self.groups = {}
        # A failed or interrupted build cannot leave a reusable plan behind.
        self.path.unlink(missing_ok=True)

    def reuse(self, group: list[str]) -> dict[str, Path] | None:
        entry = self.groups.get(json.dumps(group))
        if not entry:
            return None
        try:
            outputs = entry["outputs"]
            if set(outputs) != set(group) or not all(
                isinstance(path, str) for path in outputs.values()
            ):
                return None
            if not all(
                isinstance(name, str) for name in entry["roots"] + entry["tracked"]
            ):
                return None
            sources = _sources(entry["roots"], entry["tracked"], self.checked)
            self.before[json.dumps(group)] = sources
            if sources != entry["sources"]:
                return None
            if {path: _stamp(Path(path)) for path in entry["artifacts"]} != entry[
                "artifacts"
            ]:
                return None
            return {name: Path(path) for name, path in outputs.items()}
        except (OSError, KeyError, TypeError):
            return None

    def record(
        self, group: list[str], outputs: dict[str, Path], messages: list[dict]
    ) -> None:
        self.checked.clear()
        previous = self.groups.get(json.dumps(group), {})
        roots = set(previous.get("roots", []))
        tracked = set(previous.get("tracked", []))
        artifacts = set()
        resolved = {}

        def resolve(name):
            if name not in resolved:
                resolved[name] = Path(name).resolve()
            return resolved[name]

        cargo_home = Path(
            os.environ.get("CARGO_HOME", Path.home() / ".cargo")
        ).resolve()
        for message in messages:
            if message.get("reason") == "compiler-artifact":
                manifest = resolve(message["manifest_path"])
                if not manifest.is_relative_to(
                    cargo_home / "registry"
                ) and not manifest.is_relative_to(cargo_home / "git"):
                    roots.add(str(manifest.parent))
                for name in message["filenames"]:
                    artifact = Path(name)
                    artifacts.add(str(artifact))
                    dep = artifact.with_name(
                        artifact.name.removeprefix("lib")
                    ).with_suffix(".d")
                    # Fresh dependency dep-info was captured by the previous
                    # successful build; only compilations can add source reads.
                    if (not previous or not message.get("fresh")) and dep.is_file():
                        line = dep.read_text(encoding="utf-8").splitlines()[0]
                        for name in re.findall(
                            r"(?:\\ |[^\s])+", line.split(": ", 1)[1]
                        ):
                            source = resolve(str(self.root / name.replace("\\ ", " ")))
                            if not source.is_relative_to(cargo_home):
                                tracked.add(str(source))
            elif message.get("reason") == "build-script-executed":
                output = Path(message["out_dir"]).parent / "output"
                previous_output = previous.get("sources", {}).get(str(output))
                if (
                    previous_output
                    and previous_output
                    == self.before.get(json.dumps(group), {}).get(str(output))
                    and previous_output[:4] == _stamp(output)
                ):
                    # The declaration text was content-checked before Cargo and
                    # is unchanged. Retain its already collected external reads.
                    continue
                # build.rs may track inputs outside its package and the Cargo graph.
                # Relative paths need its package root, supplied by the artifact.
                if output.is_file():
                    artifact = next(
                        (
                            m
                            for m in messages
                            if m.get("package_id") == message["package_id"]
                            and m.get("manifest_path")
                        ),
                        None,
                    )
                    if artifact is None:
                        self.groups.pop(json.dumps(group), None)
                        return
                    base = Path(artifact["manifest_path"]).parent
                    tracked.add(str(output))
                    for line in output.read_text(encoding="utf-8").splitlines():
                        match = re.match(r"cargo::?rerun-if-changed=(.*)", line)
                        if match:
                            path = resolve(str(base / match[1]))
                            if path.is_dir():
                                roots.add(str(path))
                            else:
                                tracked.add(str(path))
        if not roots or not artifacts:
            return
        try:
            sources = _sources(sorted(roots), sorted(tracked), self.checked)
        except OSError:
            self.groups.pop(json.dumps(group), None)
            return
        # A save during compilation belongs to the next build. Never bless a
        # post-save snapshot as the inputs of an earlier compiler invocation.
        before = self.before.get(json.dumps(group))
        if (before is not None and before != sources) or (
            before is None
            and any(
                stamp and max(stamp[1:3]) > self.started - 1_000_000_000
                for stamp in sources.values()
            )
        ):
            self.groups.pop(json.dumps(group), None)
            return
        self.groups[json.dumps(group)] = {
            "outputs": {name: str(path) for name, path in outputs.items()},
            "roots": sorted(roots),
            "tracked": sorted(tracked),
            "sources": sources,
            "artifacts": {name: _stamp(Path(name)) for name in sorted(artifacts)},
        }

    def save(self) -> None:
        if self.key != _configuration(self.root, self.command):
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(f".{uuid.uuid4()}.tmp")
        try:
            temporary.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "key": self.key,
                        "packages": sorted(self.packages),
                        "groups": self.groups,
                    }
                ),
                encoding="utf-8",
            )
            temporary.replace(self.path)
        finally:
            temporary.unlink(missing_ok=True)
