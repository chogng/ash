#!/usr/bin/env python3
"""Publish independently versioned Remote archives and bind their catalog to Desktop."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import tarfile
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from build.code.archive import create_tar_gz  # noqa: E402
from build.lib.package import (  # noqa: E402
    require_verified_system_signing,
    validate_package_directory,
)
from build.lib.targets import target_spec  # noqa: E402

LOCAL_MEDIA_DESCRIPTORS = (
    "ash-resources/capabilities/media.json",
    "ash-resources/capabilities/livekit.json",
)


def digest(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def archive_package(package: Path, output: Path, *, unsigned: bool = False) -> None:
    metadata = json.loads((package / "ash-package.json").read_text())
    spec = target_spec(metadata["target"])
    validate_package_directory(package, spec)
    if (
        metadata["buildProfile"] != "release"
        or metadata["javascriptRuntime"] != {"kind": "packagedNode"}
        or "remoteServer" not in metadata["components"]
        or {"voiceHost", "livekitClient", "recognizer", "livekit"}
        & metadata["components"].keys()
        or any(name in metadata["files"] for name in LOCAL_MEDIA_DESCRIPTORS)
        or output.name != f"ash-remote-{spec.target}.tar.gz"
    ):
        raise ValueError("Remote releases require a media-free release package")
    if not unsigned:
        require_verified_system_signing(package, spec)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + ".partial")
    try:
        if output.exists():
            raise ValueError(f"Refusing to replace a Remote release: {output}")
        create_tar_gz(package, temporary)
        temporary.rename(output)
    finally:
        temporary.unlink(missing_ok=True)
    output.with_suffix(output.suffix + ".sha256").write_text(
        f"{digest(output)}  {output.name}\n"
    )


def archive_record(archive: Path) -> tuple[dict, dict]:
    files = {}
    unpacked = 0
    metadata = None
    with tarfile.open(archive, "r:gz") as source:
        seen = set()
        for member in source:
            name = member.name
            if (
                name.startswith("/")
                or "\\" in name
                or any(part in ("", ".", "..") for part in name.split("/"))
                or name in seen
                or not (member.isdir() or member.isfile())
            ):
                raise ValueError("Remote archive has a duplicate or unsafe entry")
            seen.add(name)
            if member.isdir():
                continue
            unpacked += member.size
            if unpacked > 4 * 1024**3:
                raise ValueError("Remote archive exceeds the unpacked limit")
            stream = source.extractfile(member)
            if name == "ash-package.json":
                if member.size > 1024**2:
                    raise ValueError("Remote package metadata is too large")
                metadata = json.load(stream)
            else:
                files[name] = hashlib.file_digest(stream, "sha256").hexdigest()
    if not metadata or metadata.get("files") != files:
        raise ValueError("Remote archive file hashes differ from its package manifest")
    spec = target_spec(metadata["target"])
    if (
        metadata.get("buildProfile") != "release"
        or metadata.get("javascriptRuntime") != {"kind": "packagedNode"}
        or archive.name != f"ash-remote-{spec.target}.tar.gz"
        or not {"appServer", "appServerDaemon", "remoteServer", "node"}.issubset(
            metadata["components"]
        )
        or {"voiceHost", "livekitClient", "recognizer", "livekit"}
        & metadata["components"].keys()
        or any(name in files for name in LOCAL_MEDIA_DESCRIPTORS)
    ):
        raise ValueError("Remote archive is not a standalone editing/Agent release")
    return {
        "version": metadata["version"],
        "target": spec.target,
        "archive": archive.name,
        "archiveSize": archive.stat().st_size,
        "unpackedSize": unpacked,
        "sha256": digest(archive),
    }, metadata


def write_catalog(
    archives: Path,
    output: Path,
    binding: Path,
    repository: str,
    tag: str,
    targets: list[str],
) -> None:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("Invalid Remote release repository")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", tag):
        raise ValueError("Invalid immutable Remote release tag")
    records = []
    identities = []
    for archive in sorted(archives.glob("ash-remote-*.tar.gz")):
        record, metadata = archive_record(archive)
        records.append(record)
        identities.append((metadata["version"], metadata["protocol"]))
    if (
        not records
        or len(targets) != len(set(targets))
        or {record["target"] for record in records} != set(targets)
        or len(records) != len(targets)
        or any(identity != identities[0] for identity in identities)
    ):
        raise ValueError(
            "Remote catalog must contain every selected target at one protocol/version"
        )
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps({"formatVersion": 1, "artifacts": records}, indent=2) + "\n"
    )
    binding.parent.mkdir(parents=True, exist_ok=True)
    binding.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "version": identities[0][0],
                "protocol": identities[0][1],
                "catalog": {
                    "url": f"https://github.com/{repository}/releases/download/{tag}/catalog.json",
                    "sha256": digest(output),
                },
            },
            indent=2,
        )
        + "\n"
    )


def read_binding(path: Path, metadata: dict) -> dict:
    if path.stat().st_size > 1024**2:
        raise ValueError("Remote release binding is too large")
    document = json.loads(path.read_text())
    if (
        set(document) != {"schemaVersion", "version", "protocol", "catalog"}
        or document["schemaVersion"] != 1
        or document["version"] != metadata["version"]
        or document["protocol"] != metadata["protocol"]
        or not isinstance(document["catalog"], dict)
        or set(document["catalog"]) != {"url", "sha256"}
    ):
        raise ValueError(
            "Remote release binding does not match this client's protocol/version"
        )
    catalog = document["catalog"]
    url = urlsplit(catalog["url"])
    if (
        url.scheme != "https"
        or not url.hostname
        or url.username
        or url.password
        or url.query
        or url.fragment
        or not url.path.endswith("/catalog.json")
        or re.fullmatch(r"[a-f0-9]{64}", catalog["sha256"]) is None
    ):
        raise ValueError("Invalid Remote catalog URL or digest")
    return {**catalog, "trustBinding": "signedProductPackage"}


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    archive = sub.add_parser("archive")
    archive.add_argument("--package-dir", type=Path, required=True)
    archive.add_argument("--output", type=Path, required=True)
    archive.add_argument(
        "--unsigned", action="store_true", help="Local verification only"
    )
    catalog = sub.add_parser("catalog")
    catalog.add_argument("--archives-dir", type=Path, required=True)
    catalog.add_argument("--output", type=Path, required=True)
    catalog.add_argument("--binding-file", type=Path, required=True)
    catalog.add_argument("--repository", required=True)
    catalog.add_argument("--release-tag", required=True)
    catalog.add_argument("--target", action="append", required=True)
    args = parser.parse_args(arguments)
    if args.command == "archive":
        archive_package(args.package_dir, args.output, unsigned=args.unsigned)
    else:
        write_catalog(
            args.archives_dir,
            args.output,
            args.binding_file,
            args.repository,
            args.release_tag,
            args.target,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
