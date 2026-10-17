"""Assemble the independently installable optional media capability package."""

from pathlib import Path
import hashlib
import json
import shutil
import tempfile
import gzip
import tarfile
from urllib.parse import urlsplit

from build.lib.package import package_build_id
from build.lib.package import package_files
from build.lib.package_binaries import build_binaries
from build.lib.livekit import resolve_livekit
from build.lib.version import read_workspace_version
from build.lib.targets import TargetSpec


def build_media_package(
    output: Path,
    repository: Path,
    spec: TargetSpec,
    *,
    cargo: str,
    cargo_profile: str,
    livekit_client: Path | None = None,
    recognizer: Path | None = None,
    symbols_dir: Path | None = None,
) -> Path:
    output = output.expanduser().resolve()
    if output.exists():
        raise RuntimeError(f"Refusing to replace existing media package: {output}")
    binaries = build_binaries(
        repository,
        spec,
        {
            "ash-livekit-client": livekit_client,
            "ash-realtime-voice": recognizer,
            "ash-voice-host": None,
        },
        cargo=cargo,
        cargo_profile=cargo_profile,
    )
    return assemble_media_package(
        output, repository, spec, binaries, cargo_profile, symbols_dir
    )


def assemble_media_package(
    output: Path,
    repository: Path,
    spec: TargetSpec,
    binaries: dict[str, Path],
    profile: str,
    symbols_dir: Path | None = None,
) -> Path:
    return assemble_capability_package(
        output, repository, spec, binaries, profile, "media", symbols_dir
    )


def build_livekit_package(
    output: Path,
    repository: Path,
    spec: TargetSpec,
    profile: str,
    url: str | None = None,
    *,
    archive_dir: Path | None = None,
) -> dict:
    if url is not None:
        endpoint = urlsplit(url)
        if (
            endpoint.scheme != "https"
            or not endpoint.hostname
            or endpoint.username
            or endpoint.password
            or endpoint.query
            or endpoint.fragment
        ):
            raise ValueError("LiveKit package URL must be a credential-free HTTPS URL")
    package = assemble_capability_package(
        output,
        repository,
        spec,
        {"livekit-server": resolve_livekit(spec.target, root=repository)},
        profile,
        "livekit",
    )
    return capability_release(
        package, spec, profile, "livekit", url, archive_dir=archive_dir
    )


def capability_release(
    package: Path,
    spec: TargetSpec,
    profile: str,
    kind: str,
    url: str | None = None,
    *,
    archive_dir: Path | None = None,
) -> dict:
    if url is not None:
        endpoint = urlsplit(url)
        if (
            endpoint.scheme != "https"
            or not endpoint.hostname
            or endpoint.username
            or endpoint.password
            or endpoint.query
            or endpoint.fragment
        ):
            raise ValueError(
                "Capability package URL must be a credential-free HTTPS URL"
            )
    validate_capability_package(package, spec, kind)
    metadata = json.loads((package / "ash-package.json").read_text())
    asset = (
        f"ash-{kind}-{metadata['buildId'].removeprefix('sha256:')}-{spec.target}.tar.gz"
    )
    archive_directory = (archive_dir or package.parent).expanduser().resolve()
    archive_directory.mkdir(parents=True, exist_ok=True)
    archive = archive_directory / asset
    with (
        archive.open("wb") as raw,
        gzip.GzipFile(
            filename="", mode="wb", fileobj=raw, mtime=0, compresslevel=9
        ) as compressed,
        tarfile.open(fileobj=compressed, mode="w|", format=tarfile.PAX_FORMAT) as tar,
    ):
        for path in sorted(package.rglob("*")):
            if path.is_file():
                info = tar.gettarinfo(
                    str(path), arcname=path.relative_to(package).as_posix()
                )
                info.uid = info.gid = info.mtime = 0
                info.uname = info.gname = ""
                with path.open("rb") as content:
                    tar.addfile(info, content)
    metadata = json.loads((package / "ash-package.json").read_text())
    source = {
        "kind": "archive",
        "url": url
        or f"https://github.com/chogng/ash/releases/download/v{metadata['version']}/{asset}",
        "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
        "size": archive.stat().st_size,
    }
    if profile != "release" and url is None:
        source = {"kind": "directory", "path": str(package)}
    return {
        "schemaVersion": 1,
        "target": spec.target,
        "buildId": metadata["buildId"],
        "source": source,
    }


def assemble_capability_package(
    output: Path,
    repository: Path,
    spec: TargetSpec,
    binaries: dict[str, Path],
    profile: str,
    kind: str,
    symbols_dir: Path | None = None,
) -> Path:
    from build.lib.package import copy_executable

    output = output.expanduser().resolve()
    if output.exists():
        raise RuntimeError(f"Refusing to replace existing media package: {output}")
    expected = (
        {"ash-livekit-client", "ash-realtime-voice", "ash-voice-host"}
        if kind == "media"
        else {"livekit-server"}
    )
    if set(binaries) != expected:
        raise ValueError("Capability package has incorrect executables")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.partial-", dir=output.parent)
    )
    try:
        (staging / "bin").mkdir()
        (staging / "ash-path").mkdir()
        resources = staging / "ash-resources"
        resources.mkdir()
        if kind not in ("media", "livekit"):
            raise ValueError("Unsupported capability package kind")
        shutil.copyfile(
            repository
            / (
                "build/resources/media-runtime.json"
                if kind == "media"
                else "livekit-server/runtime.json"
            ),
            resources
            / ("media-runtime.json" if kind == "media" else "livekit-server.json"),
        )
        licenses = (
            ("livekit-rust-sdks", "sherpa-onnx") if kind == "media" else ("livekit",)
        )
        for component in licenses:
            source = repository / "third_party" / component
            destination = resources / "licenses" / component
            destination.mkdir(parents=True)
            for name in ("LICENSE", "NOTICE"):
                shutil.copyfile(source / name, destination / name)
        components = {}
        for name, source in binaries.items():
            target = staging / "bin" / f"{name}{spec.executable_suffix}"
            copy_executable(source, target, spec.is_windows)
            if symbols_dir is not None and name != "livekit-server":
                if profile != "release":
                    raise ValueError("Companion symbols require the release profile")
                from build.release.symbols import SymbolStore

                SymbolStore(symbols_dir, repository).collect(
                    source, target, spec.target
                )
            component = {
                "ash-livekit-client": "livekitClient",
                "ash-realtime-voice": "recognizer",
                "ash-voice-host": "voiceHost",
                "livekit-server": "livekit",
            }[name]
            components[component] = {
                "binarySha256": hashlib.sha256(target.read_bytes()).hexdigest()
            }
        identity = {
            "layoutVersion": 2,
            "version": read_workspace_version(repository / "Cargo.toml"),
            "target": spec.target,
            "buildProfile": profile,
            "entrypoint": f"bin/{'ash-livekit-client' if kind == 'media' else 'livekit-server'}{spec.executable_suffix}",
            "pathDir": "ash-path",
            "resourcesDir": "ash-resources",
            "javascriptRuntime": {"kind": kind},
            "protocol": {
                "major": 1,
                "schemaHash": "sha256:"
                + hashlib.sha256(
                    b"".join(
                        (repository / source).read_bytes()
                        for source in (
                            (
                                "crates/livekit-client/src/protocol.rs",
                                "crates/realtime-voice/src/recognizer.rs",
                            )
                            if kind == "media"
                            else ("third_party/livekit/runtime-lock.json",)
                        )
                    )
                ).hexdigest(),
            },
            "components": components,
        }
        files = package_files(staging)
        metadata = {
            **identity,
            "files": files,
            "buildId": package_build_id(identity, files),
        }
        (staging / "ash-package.json").write_text(
            json.dumps(metadata, indent=2) + "\n", encoding="utf-8"
        )
        validate_capability_package(staging, spec, kind)
        staging.rename(output)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return output


def validate_media_package(package: Path, spec: TargetSpec) -> None:
    validate_capability_package(package, spec, "media")


def validate_capability_package(package: Path, spec: TargetSpec, kind: str) -> None:
    metadata = json.loads((package / "ash-package.json").read_text(encoding="utf-8"))
    if (
        metadata.get("layoutVersion") != 2
        or metadata.get("target") != spec.target
        or metadata.get("javascriptRuntime") != {"kind": kind}
        or metadata.get("entrypoint")
        != f"bin/{'ash-livekit-client' if kind == 'media' else 'livekit-server'}{spec.executable_suffix}"
        or metadata.get("protocol", {}).get("major") != 1
    ):
        raise RuntimeError("Invalid optional media package contract")
    from build.lib.package import system_signing_artifacts

    artifacts = system_signing_artifacts(package, spec)
    for name, path in artifacts.items():
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if metadata["components"][name].get("binarySha256") != digest:
            raise RuntimeError(f"Invalid media package executable: {name}")
    files = package_files(package)
    identity = {
        key: value for key, value in metadata.items() if key not in ("files", "buildId")
    }
    if metadata.get("files") != files or metadata.get("buildId") != package_build_id(
        identity, files
    ):
        raise RuntimeError("Invalid media package content identity")
