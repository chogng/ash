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

from build.download.artifacts import (
    download_and_verify,
    extract_member,
    publish,
    sha256,
    temporary_file,
)
from build.lib.file_lock import exclusive_lock


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
    go = shutil.which("go")
    if go is None:
        raise RuntimeError(
            "Building LiveKit Server for macOS requires Go 1.26 or newer on PATH"
        )
    locked = SimpleNamespace(url=source["url"], sha256=source["sha256"], size=None)
    if not archive.is_file() or sha256(archive) != locked.sha256:
        download_and_verify(locked, archive, max_bytes=10 * 1024 * 1024)
    executable.parent.mkdir(parents=True, exist_ok=True)
    receipt = executable.with_suffix(".sha256")
    with (
        exclusive_lock(executable.parent / ".build.lock", create=True),
        tempfile.TemporaryDirectory(prefix=f"{target}-", dir=cache) as temporary,
    ):
        directory = Path(temporary)
        subprocess.run(["tar", "-xzf", str(archive), "-C", str(directory)], check=True)
        output = directory / name
        try:
            previous_digest = receipt.read_text(encoding="ascii").strip()
        except (FileNotFoundError, UnicodeError):
            previous_digest = None
        # Go reuses a linked executable only when its output already exists.
        # Seed a private copy after checking its full contents: Go's build ID
        # check alone would not detect damage elsewhere in the binary. Go still
        # owns source, target, toolchain and build-option invalidation.
        if (
            previous_digest is not None
            and executable.is_file()
            and sha256(executable) == previous_digest
        ):
            shutil.copyfile(executable, output)
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
                go,
                "build",
                "-trimpath",
                "-buildvcs=false",
                "-mod=readonly",
                "-ldflags=-s -w",
                "-o",
                str(output),
                "./cmd/server",
            ],
            cwd=directory / f"livekit-{lock['version']}",
            env=environment,
            check=True,
        )
        # Package receipts include mtime: replacing identical Go output would
        # invalidate a reusable development package on every source scan miss.
        digest = sha256(output)
        publish(output, executable, digest)
        executable.chmod(0o755)
        # Publish after the executable under the same lock. An interrupted
        # publication leaves a mismatch and therefore takes the full build path.
        with temporary_file(receipt) as temporary_receipt:
            temporary_receipt.write_text(digest + "\n", encoding="ascii")
            publish(temporary_receipt, receipt, sha256(temporary_receipt))
    return executable


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("A Rust target triple is required.")
    print(json.dumps({"executable": str(resolve_livekit(sys.argv[1]))}))
