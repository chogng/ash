"""Compare complete development and release packages from identical inputs."""

import hashlib
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from build.lib.targets import TARGETS
from build.package.bubblewrap import BubblewrapResolution
from build.package.layout import (
    LAYOUT,
    build_package_directory,
    load_protocol_metadata,
    validate_package_directory,
)
from build.package.node import NodeResolution
from build.package.ripgrep import RipgrepResolution
from build.package.version import read_workspace_version

ROOT = Path(__file__).resolve().parents[2]


class LayoutTests(unittest.TestCase):
    def test_development_and_release_produce_the_same_package(self):
        script = f"""
import {{ assemblePackage }} from {json.dumps((ROOT / "build/package/layout.ts").as_uri())};
let text = '';
for await (const block of process.stdin) text += block;
const args = JSON.parse(text);
await assemblePackage(args.output, args.target, args.platform, args.protocol, args.executables, args.ripgrep, args.node);
"""
        for target, platform in [
            ("x86_64-pc-windows-msvc", "win32"),
            ("aarch64-apple-darwin", "darwin"),
            ("x86_64-unknown-linux-gnu", "linux"),
        ]:
            for packaged_node in (False, True):
                with (
                    self.subTest(target=target, packaged_node=packaged_node),
                    tempfile.TemporaryDirectory() as directory,
                ):
                    root = Path(directory)

                    def binary(name):
                        path = root / name
                        path.write_bytes(name.encode())
                        path.chmod(0o755)
                        return path

                    executables = {name: binary(name) for name in LAYOUT["binaries"]}
                    spec = TARGETS[target]
                    sandbox = binary("windowsSandbox") if spec.is_windows else None
                    rg = binary("ripgrep")
                    ripgrep = RipgrepResolution(
                        rg,
                        "test",
                        "upstream-release",
                        hashlib.sha256(rg.read_bytes()).hexdigest(),
                        "rg.zip",
                        "a" * 64,
                    )
                    node_binary, license = binary("node"), binary("node-license")
                    node = (
                        NodeResolution(
                            node_binary,
                            license,
                            "test",
                            "upstream-release",
                            hashlib.sha256(node_binary.read_bytes()).hexdigest(),
                            "node.zip",
                            "b" * 64,
                        )
                        if packaged_node
                        else None
                    )
                    bwrap = binary("bwrap") if spec.is_linux else None
                    copying = binary("COPYING") if spec.is_linux else None
                    bubblewrap = (
                        BubblewrapResolution(
                            bwrap,
                            "test",
                            hashlib.sha256(bwrap.read_bytes()).hexdigest(),
                            "bwrap.tar",
                            "c" * 64,
                            [copying],
                            "vendored-source-build",
                        )
                        if bwrap
                        else None
                    )
                    # Reproduce a checkout with no Desktop-generated protocol files.
                    isolated = root / "checkout"
                    for name in (
                        "build/package/layout.ts",
                        "build/package/layout.json",
                        "build/package/productServices.ts",
                        "build/download/artifacts.ts",
                    ):
                        destination = isolated / name
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copyfile(ROOT / name, destination)
                    self.assertFalse((isolated / "ash-ts/generated").exists())
                    with patch(
                        "build.package.layout.__file__",
                        str(isolated / "build/package/layout.py"),
                    ):
                        release = root / "release"
                        build_package_directory(
                            release,
                            ROOT,
                            read_workspace_version(ROOT / "Cargo.toml"),
                            spec,
                            executables["appServer"],
                            executables["remote"],
                            executables["remoteServer"],
                            executables["execServer"],
                            executables["appServerDaemon"],
                            executables["codeModeHost"],
                            ripgrep,
                            node,
                            bubblewrap,
                            protocol_metadata=load_protocol_metadata(ROOT),
                            build_profile="dev-small",
                            windows_sandbox_binary=sandbox,
                        )
                    inputs = {name: str(path) for name, path in executables.items()}
                    if sandbox:
                        inputs["windowsSandbox"] = str(sandbox)
                    if bubblewrap:
                        inputs["bubblewrap"] = {
                            "binary": str(bwrap),
                            "license": str(copying),
                            "version": "test",
                            "archive": "bwrap.tar",
                            "archiveSha256": "c" * 64,
                        }
                    development = root / "development"
                    args = {
                        "output": str(development),
                        "target": target,
                        "platform": platform,
                        "protocol": load_protocol_metadata(ROOT),
                        "executables": inputs,
                        "ripgrep": {
                            "executable": str(rg),
                            "version": "test",
                            "source": "upstream-release",
                            "binarySha256": ripgrep.binary_sha256,
                            "archive": "rg.zip",
                            "archiveSha256": "a" * 64,
                        },
                    }
                    if node:
                        args["node"] = {
                            "executable": str(node_binary),
                            "license": str(license),
                            "version": "test",
                            "source": "upstream-release",
                            "binarySha256": node.binary_sha256,
                            "archive": "node.zip",
                            "archiveSha256": "b" * 64,
                        }
                    result = subprocess.run(
                        ["node", "--input-type=module", "--eval", script],
                        input=json.dumps(args),
                        text=True,
                        capture_output=True,
                        timeout=60,
                        cwd=ROOT,
                    )
                    self.assertEqual(0, result.returncode, result.stderr)
                    validate_package_directory(development, spec)
                    self.assertEqual(
                        json.loads((release / "ash-package.json").read_text()),
                        json.loads((development / "ash-package.json").read_text()),
                    )
