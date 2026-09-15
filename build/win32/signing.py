"""Windows executable signing and verification commands."""

import os
from pathlib import Path


WINDOWS_TIMESTAMP_URL = "http://timestamp.digicert.com"


def sign_command(artifact: Path, identity: str) -> list[str]:
    return [
        os.environ.get("ASH_WINDOWS_SIGNTOOL") or "signtool",
        "sign",
        "/fd",
        "SHA256",
        "/sha1",
        identity,
        "/tr",
        os.environ.get("ASH_WINDOWS_TIMESTAMP_URL") or WINDOWS_TIMESTAMP_URL,
        "/td",
        "SHA256",
        str(artifact),
    ]


def verify_command(artifact: Path) -> list[str]:
    return [
        os.environ.get("ASH_WINDOWS_SIGNTOOL") or "signtool",
        "verify",
        "/pa",
        "/all",
        "/v",
        str(artifact),
    ]
