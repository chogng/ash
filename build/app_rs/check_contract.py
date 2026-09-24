"""Validate the checked-in app package and signing contracts."""

from __future__ import annotations

import json
import sys
from pathlib import Path


EXPECTED_PLATFORMS = {
    "darwin": ("codesign", "embedded", "ASH_MACOS_SIGNING_IDENTITY"),
    "linux": ("cosign", "detached", "APP_COSIGN_IDENTITY"),
    "windows": ("signtool", "embedded", "ASH_WINDOWS_SIGNING_THUMBPRINT"),
}


def fail(message: str) -> None:
    raise SystemExit(f"app release contract check failed: {message}")


def load(path: Path):
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        fail(f"could not read {path}: {error}")


def main() -> int:
    if len(sys.argv) != 3:
        fail("usage: check_contract.py package-contract.json signing-policy.json")
    contract = load(Path(sys.argv[1]))
    policy = load(Path(sys.argv[2]))
    if contract.get("product") != "app":
        fail("package contract product must be app")
    expected_binaries = {
        "darwin": "bin/app",
        "linux": "bin/app",
        "windows": "bin/app.exe",
    }
    if contract.get("binaryByPlatform") != expected_binaries:
        fail("package contract must name the executable for every platform")
    if "artifact" in policy:
        fail("signing policy must use the target-bound package artifact")
    if contract.get("signatureRecord") != policy.get("signatureRecord"):
        fail("package and signing contracts disagree on signature record")
    expected_invariant = (
        "The signed binary digest and every declared Remote runtime catalog binding "
        "must be verified before publication."
    )
    if contract.get("releaseInvariant") != expected_invariant:
        fail(
            "release invariant does not require signed binary and catalog verification"
        )
    if (
        contract.get("optionalRemoteRuntimeCatalog")
        != "ash-remote-runtimes/catalog.json"
    ):
        fail("package contract does not name the optional Remote runtime catalog")
    if contract.get("optionalNetworkRemoteRuntimeCatalog") != (
        "credential-free HTTPS catalog.json URL plus SHA-256 compiled into the signed binary"
    ):
        fail(
            "package contract does not define the optional network Remote catalog binding"
        )
    if "compiled into the signed app binary" not in contract.get(
        "remoteRuntimeTrustBinding", ""
    ):
        fail("package contract does not bind the Remote catalog into the signed binary")
    if policy.get("releaseRequired") is not True:
        fail("signing policy must require release signing")
    authenticated_resources = policy.get("authenticatedResources")
    if not isinstance(authenticated_resources, dict) or set(
        authenticated_resources
    ) != {
        "remoteRuntimeCatalog",
        "remoteRuntimeArtifacts",
    }:
        fail("signing policy must describe the Remote runtime trust chain")

    platforms = policy.get("platforms")
    if not isinstance(platforms, dict) or set(platforms) != set(EXPECTED_PLATFORMS):
        fail("signing policy must cover exactly darwin, linux, and windows")
    for platform, (tool, mode, environment) in EXPECTED_PLATFORMS.items():
        config = platforms.get(platform)
        if not isinstance(config, dict):
            fail(f"missing {platform} signing config")
        if (
            config.get("tool"),
            config.get("signatureMode"),
            config.get("identityEnvironment"),
        ) != (tool, mode, environment):
            fail(f"invalid {platform} signing config")
        verification = config.get("verification")
        if (
            not isinstance(verification, list)
            or not verification
            or verification[0] != tool
        ):
            fail(f"{platform} verification must invoke {tool}")
        if mode == "detached" and not config.get("signatureFile"):
            fail(f"{platform} detached signing requires signatureFile")
    if (
        platforms["darwin"].get("notarizationProfileEnvironment")
        != "ASH_MACOS_NOTARY_PROFILE"
    ):
        fail("macOS signing must name the shared notarization profile")
    if (
        platforms["windows"].get("timestampUrlEnvironment")
        != "ASH_WINDOWS_TIMESTAMP_URL"
    ):
        fail("Windows signing must name the shared timestamp service")

    print("app release contract OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
