#!/usr/bin/env python3
"""Apply and verify system signatures for a canonical Ash package."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT))

from build.lib.ash_build.targets import TARGETS, target_spec  # noqa: E402
from build.lib.signing import run_command  # noqa: E402
from build.lib.signing import sha256  # noqa: E402
from build.lib.signing import sign_and_verify  # noqa: E402
from build.lib.signing import verify_command  # noqa: E402
from build.package.layout import (  # noqa: E402
    record_system_signing,
    system_signing_artifacts,
    validate_package_directory,
)


def sign_package(package: Path, target: str, runner=None, *, verify_only=False) -> None:
    package = package.expanduser().resolve()
    spec = target_spec(target)
    if spec.is_linux:
        raise RuntimeError("Linux packages do not use embedded system signatures")
    if not verify_only:
        validate_package_directory(package, spec)
    metadata = json.loads((package / "ash-package.json").read_text(encoding="utf-8"))
    if metadata.get("target") != target or not isinstance(metadata.get("files"), dict):
        raise RuntimeError("Ash package metadata does not match the signing target")
    signed = {}
    for name, path in sorted(system_signing_artifacts(package, spec).items()):
        relative = path.relative_to(package).as_posix()
        unsigned_digest = metadata["files"].get(relative)
        if not isinstance(unsigned_digest, str) or len(unsigned_digest) != 64:
            raise RuntimeError(f"Ash package has no unsigned digest for {relative}")
        if verify_only:
            run_command(verify_command(path, spec.operating_system.value), runner)
            signed_digest = sha256(path)
        else:
            result = sign_and_verify(path, spec.operating_system.value, runner)
            if result.unsigned_sha256 != unsigned_digest:
                raise RuntimeError(f"Ash package changed before signing {relative}")
            signed_digest = result.signed_sha256
        signed[name] = {
            "unsignedSha256": unsigned_digest,
            "signedSha256": signed_digest,
        }
    record_system_signing(package, spec, signed)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--package-dir", type=Path, required=True)
    parser.add_argument("--target", choices=sorted(TARGETS), required=True)
    parser.add_argument("--verify-only", action="store_true")
    arguments = parser.parse_args()
    sign_package(
        arguments.package_dir,
        arguments.target,
        verify_only=arguments.verify_only,
    )
    print(f"Verified system signatures in {arguments.package_dir.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
