"""Linux detached signing and verification commands."""

from pathlib import Path


def sign_command(
    artifact: Path, signature: Path, identity: str, tool: str
) -> list[str]:
    return [
        tool,
        "sign-blob",
        "--yes",
        "--key",
        identity,
        "--output-signature",
        str(signature),
        str(artifact),
    ]


def verify_command(
    artifact: Path, signature: Path, identity: str, tool: str
) -> list[str]:
    return [
        tool,
        "verify-blob",
        "--key",
        identity,
        "--signature",
        str(signature),
        str(artifact),
    ]
