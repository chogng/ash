"""Resolve the locked media server for development and release packages."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from build.download.artifacts import download_and_verify, extract_member, sha256


ROOT = Path(__file__).resolve().parents[2]


def resolve_livekit(target: str, *, root: Path = ROOT) -> Path:
    lock = json.loads(
        (root / "third_party/livekit/runtime-lock.json").read_text(encoding="utf-8")
    )
    artifact = lock["artifacts"].get(
        target.removesuffix("-musl") + "-gnu" if target.endswith("-musl") else target
    )
    mac = target in ("aarch64-apple-darwin", "x86_64-apple-darwin")
    if artifact is None and not mac:
        raise RuntimeError(f"No media server build is defined for {target}")
    if mac and sys.platform != "darwin":
        raise RuntimeError("The macOS media server must be built on macOS.")
    cache = root / "third_party/.cache/livekit" / lock["version"]
    cache.mkdir(parents=True, exist_ok=True)
    name = "livekit-server.exe" if "windows" in target else "livekit-server"
    executable = cache / target / name
    if artifact is not None:
        archive = cache / artifact["archive"]
        locked = SimpleNamespace(
            url=artifact["url"], sha256=artifact["sha256"], size=None
        )
        if not archive.is_file() or sha256(archive) != locked.sha256:
            download_and_verify(locked, archive, max_bytes=128 * 1024 * 1024)
        extract_member(
            archive, "zip" if archive.suffix == ".zip" else "tar.gz", name, executable
        )
        executable.chmod(0o755)
        return executable

    source = lock["source"]
    archive = cache / "source.tar.gz"
    locked = SimpleNamespace(url=source["url"], sha256=source["sha256"], size=None)
    if not archive.is_file() or sha256(archive) != locked.sha256:
        download_and_verify(locked, archive, max_bytes=10 * 1024 * 1024)
    with tempfile.TemporaryDirectory(prefix=f"{target}-", dir=cache) as temporary:
        directory = Path(temporary)
        subprocess.run(["tar", "-xzf", str(archive), "-C", str(directory)], check=True)
        output = directory / name
        environment = {
            **os.environ,
            "GOTOOLCHAIN": "local",
            "GOWORK": "off",
            "GOFLAGS": "",
            "CGO_ENABLED": "1",
            "GOOS": "darwin",
            "GOARCH": "arm64" if target.startswith("aarch64") else "amd64",
        }
        subprocess.run(
            [
                "go",
                "build",
                "-trimpath",
                "-buildvcs=false",
                "-mod=readonly",
                "-o",
                str(output),
                "./cmd/server",
            ],
            cwd=directory / f"livekit-{lock['version']}",
            env=environment,
            check=True,
        )
        output.chmod(0o755)
        executable.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(output, executable)
    return executable


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("A Rust target triple is required.")
    print(json.dumps({"executable": str(resolve_livekit(sys.argv[1]))}))
