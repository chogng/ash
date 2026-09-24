#!/usr/bin/env python3
"""Fetch the locked PDFium runtime for the shared Rust PDF capability."""

import argparse
import json
import platform
import subprocess
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from build.download.artifacts import download_and_verify, sha256


ROOT = Path(__file__).resolve().parents[2]


def host_target() -> str:
    hosts = {
        ("Darwin", "arm64"): "darwin-arm64",
        ("Darwin", "x86_64"): "darwin-x64",
        ("Linux", "x86_64"): "linux-x64",
        ("Windows", "AMD64"): "win-x64",
    }
    host = (platform.system(), platform.machine())
    if host not in hosts:
        raise RuntimeError(
            f"No PDFium artifact is locked for {host[0]}-{host[1]}; pass --target explicitly."
        )
    return hosts[host]


def fetch_pdfium(target: str, output: Path, *, root: Path = ROOT) -> Path:
    lock = json.loads(
        (root / "third_party/pdfium/runtime-lock.json").read_text(encoding="utf-8")
    )
    artifact = lock["artifacts"].get(target)
    if artifact is None:
        raise RuntimeError(f"Unknown PDFium target: {target}")
    output = output.expanduser().resolve()
    receipt = output / ".ash-pdfium-receipt.json"
    if output.exists():
        if (output / artifact["library"]).is_file() and receipt.is_file():
            existing = json.loads(receipt.read_text(encoding="utf-8"))
            if all(
                existing.get(key) == value
                for key, value in (
                    ("version", lock["version"]),
                    ("archive", artifact["archive"]),
                    ("sha256", artifact["sha256"]),
                )
            ):
                print(f"PDFium {lock['version']} already verified at {output}")
                return output
        raise RuntimeError(f"Refusing to replace existing output directory: {output}")

    archive = (
        root
        / "third_party/.cache/pdfium"
        / lock["version"]
        / target
        / artifact["archive"]
    )
    if not archive.is_file() or sha256(archive) != artifact["sha256"]:
        source = lock["source"]
        url = f"{source['repository']}/releases/download/{source['release']}/{artifact['archive']}"
        download_and_verify(
            SimpleNamespace(url=url, sha256=artifact["sha256"], size=None),
            archive,
            max_bytes=512 * 1024 * 1024,
        )
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=f".{output.name}.partial-", dir=output.parent
    ) as temporary:
        staging = Path(temporary)
        subprocess.run(["tar", "-xzf", str(archive), "-C", str(staging)], check=True)
        if not (staging / artifact["library"]).is_file():
            raise RuntimeError(
                f"Archive {artifact['archive']} does not contain {artifact['library']}"
            )
        receipt = {
            "version": lock["version"],
            "target": target,
            "archive": artifact["archive"],
            "sha256": artifact["sha256"],
        }
        (staging / ".ash-pdfium-receipt.json").write_text(
            json.dumps(receipt, indent=2) + "\n", encoding="utf-8"
        )
        staging.rename(output)
    print(f"Verified and extracted PDFium {lock['version']} for {target} to {output}")
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", default=None)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    fetch_pdfium(args.target or host_target(), args.output)
