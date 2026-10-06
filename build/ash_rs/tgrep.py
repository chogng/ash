"""Build the checksum-locked tgrep source and Ash runtime patch."""

import hashlib
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path

from .cargo import validate_input_binary
from .executable import ExecutableResolution
from build.download.artifacts import sha256
from build.lib.file_lock import exclusive_lock
from build.lib.targets import default_target


def resolve_tgrep(
    spec, lock_path, cache_root, explicit_binary=None, *, cargo="cargo"
) -> ExecutableResolution:
    lock_path = Path(lock_path).resolve()
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    if lock.get("schemaVersion") != 2 or lock.get("runtime") != "tgrep":
        raise RuntimeError("Unsupported tgrep source lock")
    version = lock["version"]
    source = _verified_input(lock_path.parent, lock["source"])
    patch = _verified_input(lock_path.parent, lock["patch"])
    if spec.target not in lock["targets"]:
        raise RuntimeError(f"No tgrep source build is locked for {spec.target}")
    if explicit_binary is not None:
        executable = validate_input_binary(
            explicit_binary, "tgrep executable", "--tgrep-bin", spec.is_windows
        )
        return ExecutableResolution(
            executable, version, "local-override", sha256(executable)
        )
    toolchain = subprocess.check_output([cargo, "--version"], text=True).strip()
    digest = hashlib.sha256(
        json.dumps(
            {
                "source": lock["source"]["sha256"],
                "patch": lock["patch"]["sha256"],
                "target": spec.target,
                "toolchain": toolchain,
            },
            sort_keys=True,
        ).encode()
    ).hexdigest()
    cache = Path(cache_root).resolve() / version / digest
    cache.mkdir(parents=True, exist_ok=True)
    executable = cache / ("tgrep" + spec.executable_suffix)
    manifest = cache / "build.json"
    with exclusive_lock(cache / ".build.lock", create=True):
        # The published executable is self-contained. Compiler outputs belong to
        # this resolver's build lifetime, including caches created by older builds.
        if (cache / "target").exists():
            shutil.rmtree(cache / "target")
        if (
            executable.is_file()
            and manifest.is_file()
            and json.loads(manifest.read_text())["sha256"] == sha256(executable)
        ):
            return ExecutableResolution(
                executable,
                version,
                "locked-source",
                sha256(executable),
                source.name,
                lock["source"]["sha256"],
            )
        # MSVC's compiler and assembler cannot build under the deeply nested
        # checksum cache. Keep transient sources and outputs in the system temp root.
        with tempfile.TemporaryDirectory(prefix="ash-tgrep-") as temporary:
            directory = Path(temporary)
            _extract_source(source, directory)
            # Apply upstream-relative paths independently of any parent checkout.
            patch_environment = dict(os.environ, GIT_CEILING_DIRECTORIES=str(directory.parent))
            for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
                patch_environment.pop(name, None)
            subprocess.run(
                ["git", "apply", "--check", str(patch)],
                cwd=directory,
                env=patch_environment,
                check=True,
            )
            subprocess.run(
                ["git", "apply", str(patch)],
                cwd=directory,
                env=patch_environment,
                check=True,
            )
            target_directory = directory / "target"
            environment = dict(os.environ, CARGO_TARGET_DIR=str(target_directory))
            subprocess.run(
                [
                    cargo,
                    "build",
                    "--locked",
                    "--release",
                    "--target",
                    spec.target,
                    "-p",
                    "tgrep-cli",
                ],
                cwd=directory,
                env=environment,
                check=True,
            )
            output = target_directory / spec.target / "release" / executable.name
            actual = (
                subprocess.check_output([str(output), "--version"], text=True).strip()
                if spec.target == default_target()
                else None
            )
            if actual is not None and actual != f"tgrep {version}":
                raise RuntimeError("tgrep source version disagrees with runtime lock")
            shutil.copy2(output, executable)
            manifest.write_text(
                json.dumps({"sha256": sha256(executable)}), encoding="utf-8"
            )
    return ExecutableResolution(
        executable,
        version,
        "locked-source",
        sha256(executable),
        source.name,
        lock["source"]["sha256"],
    )


def _verified_input(directory, locked):
    path = directory / locked["file"]
    if (
        path.parent != directory
        or not path.is_file()
        or sha256(path) != locked["sha256"]
    ):
        raise RuntimeError(f"tgrep source checksum mismatch: {path.name}")
    return path


def _extract_source(source, directory):
    # The source archive has no symlinks. Validate paths before extracting so
    # a substituted archive cannot write outside its build directory.
    with tarfile.open(source, "r:gz") as archive:
        for member in archive.getmembers():
            path = Path(member.name)
            if (
                path.is_absolute()
                or ".." in path.parts
                or not (member.isfile() or member.isdir())
            ):
                raise RuntimeError("Invalid tgrep source archive member")
        for member in archive.getmembers():
            output = directory / member.name
            if member.isdir():
                output.mkdir(parents=True, exist_ok=True)
            else:
                output.parent.mkdir(parents=True, exist_ok=True)
                with (
                    archive.extractfile(member) as incoming,
                    output.open("wb") as outgoing,
                ):
                    shutil.copyfileobj(incoming, outgoing)
                output.chmod(member.mode & 0o777)
