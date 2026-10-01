"""Prepare locked speech libraries once, independently of Cargo profiles and features."""

from __future__ import annotations

import json
import os
import re
import shutil
import tarfile
from collections.abc import Mapping
from dataclasses import dataclass, replace
from pathlib import Path

from build.download.artifacts import (
    download_and_verify,
    publish,
    sha256,
    temporary_file,
)
from build.lib.targets import TARGETS, TargetSpec


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_LOCK = ROOT / "third_party/sherpa-onnx/runtime-lock.json"
DEFAULT_CACHE = ROOT / "third_party/.cache/sherpa-onnx"
REPOSITORY = "https://github.com/k2-fsa/sherpa-onnx"
# These are the static link inputs declared by the locked sherpa-onnx-sys build script.
LIBRARIES = (
    "sherpa-onnx-c-api",
    "sherpa-onnx-core",
    "kaldi-decoder-core",
    "sherpa-onnx-kaldifst-core",
    "sherpa-onnx-fstfar",
    "sherpa-onnx-fst",
    "kaldi-native-fbank-core",
    "kissfft-float",
    "piper_phonemize",
    "espeak-ng",
    "ucd",
    "onnxruntime",
    "ssentencepiece_core",
)


@dataclass(frozen=True)
class SpeechArchive:
    name: str
    sha256: str
    size: int
    url: str


def load_sherpa_lock(path: Path = DEFAULT_LOCK) -> tuple[str, dict[str, SpeechArchive]]:
    document = json.loads(path.read_text())
    version = document["version"]
    if (
        document["schemaVersion"] != 1
        or document["runtime"] != "sherpa-onnx"
        or not re.fullmatch(r"\d+\.\d+\.\d+", version)
        or document["source"] != {"repository": REPOSITORY, "release": f"v{version}"}
        or document["artifacts"].keys() != TARGETS.keys()
    ):
        raise RuntimeError(f"Invalid Sherpa resource lock: {path}")
    archives = {}
    for target, entry in document["artifacts"].items():
        name = entry["name"]
        if (
            Path(name).name != name
            or not name.startswith(f"sherpa-onnx-v{version}-")
            or not name.endswith(".tar.bz2")
            or not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"])
            or not isinstance(entry["size"], int)
            or entry["size"] <= 0
        ):
            raise RuntimeError(f"Invalid Sherpa archive for {target}")
        archives[target] = SpeechArchive(
            name,
            entry["sha256"],
            entry["size"],
            f"{REPOSITORY}/releases/download/v{version}/{name}",
        )
    return version, archives


def resolve_sherpa_cargo_env(
    spec: TargetSpec,
    *,
    environ: Mapping[str, str] | None = None,
    lock_path: Path = DEFAULT_LOCK,
    cache_root: Path = DEFAULT_CACHE,
) -> dict[str, str]:
    environment = os.environ if environ is None else environ
    if environment.get("SHERPA_ONNX_LIB_DIR"):
        return {}
    version, archives = load_sherpa_lock(lock_path)
    archive = archives[spec.target]
    if local := environment.get("SHERPA_ONNX_ARCHIVE_DIR"):
        archive = replace(archive, url=(Path(local) / archive.name).resolve().as_uri())
    names = {f"{name}.lib" if spec.is_windows else f"lib{name}.a" for name in LIBRARIES}
    directory = cache_root / f"v{version}"
    libraries = materialize(archive, names, directory)
    return {"SHERPA_ONNX_LIB_DIR": str(libraries.resolve())}


def materialize(archive: SpeechArchive, names: set[str], cache: Path) -> Path:
    extracted = cache / archive.name.removesuffix(".tar.bz2")
    libraries = extracted / "lib"
    manifest_path = extracted / "files.json"
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text())
        if (
            manifest["archive"] == archive.sha256
            and manifest["files"].keys() == names
            and all(
                (libraries / name).is_file() and sha256(libraries / name) == digest
                for name, digest in manifest["files"].items()
            )
        ):
            return libraries

    cached = cache / archive.name
    if not cached.is_file() or sha256(cached) != archive.sha256:
        download_and_verify(archive, cached, timeout=120)
    prefix = archive.name.removesuffix(".tar.bz2") + "/lib/"
    members = {prefix + name for name in names}
    files = {}
    # Stream the compressed archive once; unpack only the SDK's exact regular-file inputs.
    with tarfile.open(cached, "r|bz2") as contents:
        for member in contents:
            if member.name not in members:
                continue
            name = member.name.removeprefix(prefix)
            if not member.isfile() or name in files:
                raise RuntimeError(f"Invalid Sherpa library member: {member.name}")
            source = contents.extractfile(member)
            with source, temporary_file(libraries / name) as temporary:
                with temporary.open("wb") as output:
                    shutil.copyfileobj(source, output)
                digest = sha256(temporary)
                publish(temporary, libraries / name, digest)
            files[name] = digest
    if files.keys() != names:
        raise RuntimeError(
            f"Sherpa archive is missing libraries: {sorted(names - files.keys())}"
        )
    with temporary_file(manifest_path) as temporary:
        temporary.write_text(
            json.dumps({"archive": archive.sha256, "files": files}) + "\n"
        )
        publish(temporary, manifest_path, sha256(temporary))
    return libraries
