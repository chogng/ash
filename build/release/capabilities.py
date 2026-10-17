#!/usr/bin/env python3
"""Build independent first-party capabilities and stage the exact product-bound assets."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
import tarfile
from pathlib import Path
from pathlib import PurePosixPath
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from build.lib.media_package import build_livekit_package  # noqa: E402
from build.lib.media_package import build_media_package  # noqa: E402
from build.lib.media_package import capability_release  # noqa: E402
from build.lib.package import file_sha256  # noqa: E402
from build.lib.package import package_build_id  # noqa: E402
from build.lib.sherpa import SUPPORTED_TARGETS  # noqa: E402
from build.lib.targets import TARGETS  # noqa: E402
from build.lib.targets import default_target  # noqa: E402


def validate_archive(path: Path, release: dict, kind: str, target: str) -> None:
    """Verify both the transport binding and the complete extracted package identity."""
    source = release["source"]
    if (
        path.is_symlink()
        or not path.is_file()
        or path.stat().st_size != source["size"]
        or file_sha256(path) != source["sha256"]
    ):
        raise RuntimeError(f"Capability archive differs from product binding: {path}")
    files = {}
    metadata = None
    with tarfile.open(path, "r:gz") as archive:
        for member in archive:
            name = PurePosixPath(member.name)
            if (
                not member.isfile()
                or name.is_absolute()
                or ".." in name.parts
                or str(name) != member.name
                or "\\" in member.name
                or member.name in files
            ):
                raise RuntimeError(f"Invalid capability archive member: {member.name}")
            stream = archive.extractfile(member)
            if stream is None:
                raise RuntimeError("Missing capability archive bytes")
            if member.name == "ash-package.json":
                if metadata is not None or member.size > 1024 * 1024:
                    raise RuntimeError("Invalid capability metadata")
                metadata = json.load(stream)
            else:
                digest = hashlib.sha256()
                while chunk := stream.read(1024 * 1024):
                    digest.update(chunk)
                files[member.name] = digest.hexdigest()
    if (
        not isinstance(metadata, dict)
        or metadata.get("target") != target
        or metadata.get("javascriptRuntime") != {"kind": kind}
        or metadata.get("buildId") != release["buildId"]
        or metadata.get("files") != files
    ):
        raise RuntimeError(
            f"Capability archive identity differs from product binding: {path}"
        )
    identity = {
        key: value for key, value in metadata.items() if key not in ("files", "buildId")
    }
    if package_build_id(identity, files) != release["buildId"]:
        raise RuntimeError(f"Invalid capability package content identity: {path}")


def stage_packages(
    packages: list[Path], archives: list[Path], output: Path
) -> list[str]:
    """Stage only archives referenced by the supplied products, failing before any copy."""
    planned = {}
    for package in packages:
        metadata = json.loads(
            (package / "ash-package.json").read_text(encoding="utf-8")
        )
        identity = {
            key: value
            for key, value in metadata.items()
            if key not in ("files", "buildId")
        }
        files = metadata.get("files")
        if (
            metadata.get("layoutVersion") != 2
            or not isinstance(files, dict)
            or package_build_id(identity, files) != metadata.get("buildId")
        ):
            raise RuntimeError(f"Invalid product package identity: {package}")
        target = metadata["target"]
        if target not in TARGETS:
            raise RuntimeError(f"Unsupported product target: {target}")
        components = metadata.get("components", {})
        bundled = {"livekitClient", "recognizer", "voiceHost"}.intersection(components)
        if bundled:
            if bundled != {"livekitClient", "recognizer", "voiceHost"}:
                raise RuntimeError(f"Incomplete bundled media: {package}")
            for component, binary in (
                ("livekitClient", "ash-livekit-client"),
                ("recognizer", "ash-realtime-voice"),
                ("voiceHost", "ash-voice-host"),
            ):
                relative = f"bin/{binary}{TARGETS[target].executable_suffix}"
                path = package / relative
                if (
                    path.is_symlink()
                    or not path.is_file()
                    or file_sha256(path) != files.get(relative)
                    or components[component].get("binarySha256") != files.get(relative)
                ):
                    raise RuntimeError(f"Invalid bundled media executable: {path}")
            descriptor = "ash-resources/capabilities/media.json"
            if descriptor in files or (package / descriptor).exists():
                raise RuntimeError(
                    f"Bundled media must not also declare a download: {package}"
                )
        expected = (
            ("media", "livekit")
            if target in SUPPORTED_TARGETS and not bundled
            else ("livekit",)
        )
        for kind in expected:
            relative = f"ash-resources/capabilities/{kind}.json"
            descriptor = package / relative
            if (
                descriptor.is_symlink()
                or not descriptor.is_file()
                or file_sha256(descriptor) != metadata.get("files", {}).get(relative)
            ):
                raise RuntimeError(f"Unbound capability descriptor: {descriptor}")
            release = json.loads(descriptor.read_text(encoding="utf-8"))
            source = release.get("source", {})
            endpoint = urlsplit(source.get("url", ""))
            name = endpoint.path.rsplit("/", 1)[-1]
            if (
                release.get("schemaVersion") != 1
                or release.get("target") != target
                or not re.fullmatch(r"sha256:[a-f0-9]{64}", release.get("buildId", ""))
                or source.get("kind") != "archive"
                or endpoint.scheme != "https"
                or not endpoint.hostname
                or endpoint.username
                or endpoint.password
                or endpoint.query
                or endpoint.fragment
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz", name)
                or type(source.get("size")) is not int
                or not 0 < source["size"] <= 128 * 1024 * 1024
                or not re.fullmatch(r"[a-f0-9]{64}", source.get("sha256", ""))
            ):
                raise RuntimeError(f"Invalid release capability binding: {descriptor}")
            canonical = f"ash-{kind}-{release['buildId'].removeprefix('sha256:')}-{target}.tar.gz"
            candidates = [
                directory / candidate
                for directory in archives
                for candidate in dict.fromkeys((name, canonical))
                if (directory / candidate).is_file()
            ]
            if not candidates:
                raise RuntimeError(f"Missing product-bound capability archive: {name}")
            for candidate in candidates:
                validate_archive(candidate, release, kind, target)
            if name in planned and file_sha256(planned[name]) != source["sha256"]:
                raise RuntimeError(f"Conflicting capability asset name: {name}")
            destination = output / name
            if destination.is_symlink() or (
                destination.exists() and file_sha256(destination) != source["sha256"]
            ):
                raise RuntimeError(
                    f"Refusing to replace different capability asset: {destination}"
                )
            planned[name] = candidates[0]
    output.mkdir(parents=True, exist_ok=True)
    for name, source in sorted(planned.items()):
        destination = output / name
        if not destination.exists():
            shutil.copyfile(source, destination)
    return sorted(planned)


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build")
    build.add_argument("--kind", choices=("media", "livekit"), required=True)
    build.add_argument("--target", choices=sorted(TARGETS), default=default_target())
    build.add_argument("--package-dir", type=Path, required=True)
    build.add_argument("--archive-dir", type=Path)
    build.add_argument("--descriptor-file", type=Path, required=True)
    build.add_argument("--cargo-profile", default="release")
    build.add_argument("--cargo", default="cargo")
    build.add_argument("--recognizer-bin", type=Path)
    build.add_argument("--livekit-client-bin", type=Path)
    build.add_argument("--symbols-dir", type=Path)
    build.add_argument("--url")
    stage = commands.add_parser("stage")
    stage.add_argument("--package-dir", type=Path, action="append", required=True)
    stage.add_argument("--archives-dir", type=Path, action="append", required=True)
    stage.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(arguments)
    if args.command == "stage":
        print(
            json.dumps(stage_packages(args.package_dir, args.archives_dir, args.output))
        )
        return 0
    spec = TARGETS[args.target]
    if args.kind == "media":
        if args.target not in SUPPORTED_TARGETS:
            parser.error("Media is unavailable for this target")
        package = build_media_package(
            args.package_dir,
            ROOT,
            spec,
            cargo=args.cargo,
            cargo_profile=args.cargo_profile,
            livekit_client=args.livekit_client_bin,
            recognizer=args.recognizer_bin,
            symbols_dir=args.symbols_dir,
        )
        release = capability_release(
            package,
            spec,
            args.cargo_profile,
            "media",
            args.url,
            archive_dir=args.archive_dir,
        )
    else:
        if args.livekit_client_bin or args.recognizer_bin or args.symbols_dir:
            parser.error("Local media binaries and Rust symbols apply only to media")
        release = build_livekit_package(
            args.package_dir,
            ROOT,
            spec,
            args.cargo_profile,
            args.url,
            archive_dir=args.archive_dir,
        )
    args.descriptor_file.parent.mkdir(parents=True, exist_ok=True)
    args.descriptor_file.write_text(
        json.dumps(release, indent=2) + "\n", encoding="utf-8"
    )
    print(args.descriptor_file.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
