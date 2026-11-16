"""Resolve the locked media server for development and release packages."""

import json
import re
import sys
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from build.download.artifacts import (
    archive_is_valid,
    download_and_verify,
    extract_member,
)
from build.lib.targets import TARGETS


ROOT = Path(__file__).resolve().parents[2]


def resolve_livekit(target: str, *, root: Path = ROOT) -> Path:
    lock = json.loads(
        (root / "third_party/livekit/runtime-lock.json").read_text(encoding="utf-8")
    )
    if (
        lock.get("schemaVersion") != 1
        or lock.get("runtime") != "livekit"
        or not isinstance(lock.get("version"), str)
        or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", lock["version"])
        or not isinstance(lock.get("artifacts"), dict)
    ):
        raise RuntimeError("Invalid LiveKit Server runtime lock")
    artifact = lock["artifacts"].get(
        target.removesuffix("-musl") + "-gnu" if target.endswith("-musl") else target
    )
    # Dependency production belongs to ash-livekit-server. An incomplete lock
    # must fail here rather than silently turning a product build into a Go build.
    if target not in TARGETS or not isinstance(artifact, dict):
        raise RuntimeError(f"No media server artifact is locked for {target}")
    if (
        not isinstance(artifact.get("archive"), str)
        or not re.fullmatch(r"[A-Za-z0-9_.-]+\.(?:tar\.gz|zip)", artifact["archive"])
        or not isinstance(artifact.get("sha256"), str)
        or not re.fullmatch(r"[0-9a-f]{64}", artifact["sha256"])
        or type(artifact.get("size")) is not int
        or not 0 < artifact["size"] <= 128 * 1024 * 1024
        or not isinstance(artifact.get("url"), str)
    ):
        raise RuntimeError(f"Invalid locked media server artifact for {target}")
    endpoint = urlsplit(artifact["url"])
    if (
        endpoint.scheme != "https"
        or not endpoint.hostname
        or endpoint.username
        or endpoint.password
        or endpoint.query
        or endpoint.fragment
    ):
        raise RuntimeError("LiveKit Server archives require credential-free HTTPS URLs")
    cache = root / "third_party/.cache/livekit" / lock["version"]
    name = "livekit-server.exe" if TARGETS[target].is_windows else "livekit-server"
    executable = cache / target / name
    archive = cache / artifact["archive"]
    locked = SimpleNamespace(
        url=artifact["url"], sha256=artifact["sha256"], size=artifact["size"]
    )
    if not archive_is_valid(archive, locked):
        download_and_verify(locked, archive)
    extract_member(
        archive, "zip" if archive.suffix == ".zip" else "tar.gz", name, executable
    )
    executable.chmod(0o755)
    return executable


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("A Rust target triple is required.")
    print(json.dumps({"executable": str(resolve_livekit(sys.argv[1]))}))
