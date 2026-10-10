"""Remote delivery requirements apply before work and produce a complete package."""

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from build import app_server, remote
from build.lib.executable import ExecutableResolution
from build.lib.node import NodeResolution
from build.lib.package import validate_package_directory
from build.lib.targets import TARGETS


class RemotePackageTests(unittest.TestCase):
    def test_unsupported_target_and_missing_node_reject_before_building(self) -> None:
        with patch.object(remote, "build_package") as build:
            for options in (
                ["--target", "x86_64-pc-windows-msvc"],
                [
                    "--target",
                    "aarch64-apple-darwin",
                    "--javascript-runtime",
                    "host-provided-node",
                ],
            ):
                with self.subTest(options=options), self.assertRaises(ValueError):
                    remote.main(["--package-dir", "unused", *options])
            build.assert_not_called()

    def test_declared_target_selection_is_consumed_before_building(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "remote").mkdir()
            (root / "remote/package.json").write_text(
                json.dumps(
                    {
                        "ash": {
                            "javascriptRuntime": "packaged-node",
                            "targets": ["aarch64-apple-darwin"],
                        },
                    }
                )
            )
            with (
                patch.object(remote, "ROOT", root),
                patch.object(remote, "build_package") as build,
            ):
                with self.assertRaisesRegex(ValueError, "target is not supported"):
                    remote.main(
                        ["--package-dir", "unused", "--target", "x86_64-apple-darwin"]
                    )
                build.assert_not_called()

    def test_remote_entrypoint_assembles_verified_node_and_backend_resources(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)

            def executable(name):
                path = root / name
                path.write_bytes(name.encode())
                path.chmod(0o755)
                return path

            def tool(name):
                path = executable(name)
                return ExecutableResolution(
                    path,
                    "test",
                    "local-override",
                    hashlib.sha256(path.read_bytes()).hexdigest(),
                )

            binaries = {
                name: executable(name)
                for name in (
                    "ash-app-server",
                    "ash-app-server-daemon",
                    "ash-remote",
                    "ash-remote-host",
                    "ash-remote-server",
                    "ash-exec-server",
                    "ash-code-mode-host",
                    "ash-external-js-ext",
                    "ash-github-authentication",
                    "ash-voice-host",
                    "ash-collaboration-server",
                )
            }
            node = executable("node")
            license_file = root / "node-license"
            license_file.write_text("Node test license")
            output = root / "package"
            target = "aarch64-apple-darwin"
            with (
                patch.object(app_server, "build_binaries", return_value=binaries),
                patch.object(app_server, "resolve_ripgrep", return_value=tool("rg")),
                patch.object(app_server, "resolve_tgrep", return_value=tool("tgrep")),
                patch.object(
                    app_server,
                    "resolve_node",
                    return_value=NodeResolution(
                        node,
                        license_file,
                        "test",
                        "local-override",
                        hashlib.sha256(node.read_bytes()).hexdigest(),
                        "node.zip",
                        "a" * 64,
                    ),
                ),
                patch.object(app_server, "resolve_bubblewrap", return_value=None),
                patch.object(
                    app_server,
                    "resolve_livekit",
                    return_value=executable("livekit-server"),
                ),
            ):
                self.assertEqual(
                    0, remote.main(["--target", target, "--package-dir", str(output)])
                )
            validate_package_directory(output, TARGETS[target])
            metadata = json.loads((output / "ash-package.json").read_text())
            self.assertEqual({"kind": "packagedNode"}, metadata["javascriptRuntime"])
            self.assertEqual(
                b"ash-remote-server", (output / "bin/ash-remote-server").read_bytes()
            )
            self.assertEqual(
                b"node", (output / "ash-resources/node/bin/node").read_bytes()
            )
            self.assertTrue((output / "ash-resources/extensions").is_dir())
            self.assertTrue((output / "ash-resources/skills").is_dir())
