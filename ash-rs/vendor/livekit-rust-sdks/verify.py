"""Verify the pinned crate snapshots plus the checked-in SDK patch."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parent
MAX_ARCHIVE = 20 * 1024 * 1024


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--archives",
        type=Path,
        help="Directory containing the original .crate archives",
    )
    args = parser.parse_args()
    metadata = json.loads((ROOT / "upstream.json").read_text())
    with tempfile.TemporaryDirectory(prefix="ash-livekit-verify-") as directory:
        pristine = Path(directory).resolve()
        for name, package in metadata["packages"].items():
            archive_name = f"{name}-{package['version']}.crate"
            if args.archives:
                data = (args.archives / archive_name).read_bytes()
            else:
                url = f"https://static.crates.io/crates/{name}/{archive_name}"
                with urllib.request.urlopen(url, timeout=60) as response:
                    data = response.read(MAX_ARCHIVE + 1)
            if (
                len(data) > MAX_ARCHIVE
                or hashlib.sha256(data).hexdigest() != package["archiveSha256"]
            ):
                raise RuntimeError(f"Archive checksum mismatch: {archive_name}")
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
                for member in archive.getmembers():
                    if not member.isfile():
                        continue
                    relative = Path(member.name).relative_to(
                        f"{name}-{package['version']}"
                    )
                    if relative == Path("Cargo.lock"):
                        continue  # One test-workspace lockfile owns the imported crates.
                    output = pristine / name / relative
                    if not output.resolve().is_relative_to(pristine):
                        raise RuntimeError(
                            "Archive path escapes verification directory"
                        )
                    output.parent.mkdir(parents=True, exist_ok=True)
                    stream = archive.extractfile(member)
                    assert stream is not None
                    output.write_bytes(stream.read())
        subprocess.run(
            ["git", "apply", "--whitespace=nowarn", str(ROOT / metadata["patchFile"])],
            cwd=pristine,
            check=True,
        )
        for name in metadata["packages"]:
            expected = {
                p.relative_to(pristine / name): p.read_bytes()
                for p in (pristine / name).rglob("*")
                if p.is_file()
            }
            actual = {
                p.relative_to(ROOT / name): p.read_bytes()
                for p in (ROOT / name).rglob("*")
                if p.is_file()
            }
            if actual != expected:
                paths = sorted(
                    str(p)
                    for p in actual.keys() | expected.keys()
                    if actual.get(p) != expected.get(p)
                )
                raise RuntimeError(
                    f"Snapshot differs from upstream plus patch: {name}: {paths}"
                )
    print("Verified 3 pinned Rust crates and their local patches")


if __name__ == "__main__":
    main()
