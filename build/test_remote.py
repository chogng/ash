"""Remote delivery requirements apply before work and produce a complete package."""

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from build import app_server, remote
from build.lib import media_package
from build.lib.executable import ExecutableResolution
from build.lib.node import NodeResolution
from build.lib.package import validate_package_directory
from build.lib.package import system_signing_artifacts
from build.lib.package import record_system_signing
from build.lib.package import require_verified_system_signing
from build.lib.package_test_support import create_package_sources
from build.lib.targets import TARGETS


class RemotePackageTests(unittest.TestCase):
    def test_remote_rejects_local_media_inputs_before_preparation(self) -> None:
        with patch.object(app_server, "generate_protocol") as prepare:
            for flag in (
                "--media-package-dir",
                "--media-package-url",
                "--livekit-package-dir",
                "--livekit-package-url",
                "--recognizer-bin",
                "--livekit-client-bin",
            ):
                with (
                    self.subTest(flag=flag),
                    self.assertRaisesRegex(ValueError, "Media-free packages"),
                ):
                    remote.main(
                        [
                            "--target",
                            "aarch64-apple-darwin",
                            "--package-dir",
                            "unused",
                            flag,
                            "unused",
                        ]
                    )
            prepare.assert_not_called()

    def test_unsupported_target_and_missing_node_reject_before_building(self) -> None:
        with patch.object(remote, "build_package") as build:
            for options in (
                ["--target", "aarch64-apple-darwin", "--media-distribution", "bundled"],
                [
                    "--target",
                    "aarch64-apple-darwin",
                    "--media-distribution",
                    "optional",
                ],
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
            (root / "remote-server").mkdir()
            (root / "remote-server/package.json").write_text(
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
        self.verify_package(remote_only=True)

    def test_local_standalone_keeps_independent_media_delivery(self) -> None:
        self.verify_package(remote_only=False)

    def verify_package(self, *, remote_only: bool) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            sources = create_package_sources(root / "sources")

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
                    "ash-git-extension",
                    "ash-markdown-math",
                    "ash-markdown-language-features",
                    "ash-github-authentication",
                    "ash-github-extension",
                    "ash-remote-ssh-extension",
                    "ash-dev-container-provider",
                    "ash-debug-lldb",
                    "ash-voice-host",
                    "ash-livekit-client",
                    "ash-realtime-voice",
                    "ash-collab-server",
                )
            }
            node = executable("node")
            license_file = root / "node-license"
            license_file.write_text("Node test license")
            output = root / "package"
            target = "aarch64-apple-darwin"
            with (
                patch.object(app_server, "REPOSITORY_ROOT", sources),
                patch.object(app_server, "generate_protocol", return_value=False),
                patch.object(app_server, "_prepare_builtin_extensions"),
                patch(
                    "build.lib.package_binaries.cargo_command_packages",
                    return_value=set(),
                ),
                patch.object(
                    app_server,
                    "build_binaries",
                    side_effect=lambda _root, _spec, inputs, **_: {
                        key: binaries[key] for key in inputs
                    },
                ),
                patch.object(
                    media_package,
                    "build_binaries",
                    side_effect=lambda _root, _spec, inputs, **_: {
                        key: binaries[key] for key in inputs
                    },
                ) as media_build,
                patch.object(
                    media_package,
                    "resolve_livekit",
                    return_value=executable("livekit-server"),
                ) as hosting_build,
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
            ):
                entrypoint = remote.main if remote_only else app_server.main
                self.assertEqual(
                    0, entrypoint(["--target", target, "--package-dir", str(output)])
                )
                if remote_only:
                    media_build.assert_not_called()
                    hosting_build.assert_not_called()
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
            self.assertFalse((output / "bin/ash-voice-host").exists())
            self.assertFalse((output / "bin/livekit-server").exists())
            self.assertFalse((output / "bin/ash-livekit-client").exists())
            if remote_only:
                self.assertFalse((output / "bin/ash-realtime-voice").exists())
                self.assertFalse((output / "ash-resources/capabilities").exists())
                self.assertFalse(output.with_name(output.name + "-media").exists())
                self.assertFalse(output.with_name(output.name + "-livekit").exists())
                return
            optional = output.with_name(output.name + "-media")
            for name in ("ash-voice-host", "ash-livekit-client", "ash-realtime-voice"):
                self.assertTrue((optional / "bin" / name).is_file())
            self.assertFalse((optional / "bin/livekit-server").exists())
            hosting = output.with_name(output.name + "-livekit")
            self.assertTrue((hosting / "bin/livekit-server").is_file())
            self.assertFalse((hosting / "bin/ash-livekit-client").exists())
            release = json.loads(
                (output / "ash-resources/capabilities/livekit.json").read_text()
            )
            self.assertEqual("archive", release["source"]["kind"])
            self.assertTrue(
                release["source"]["url"].startswith(
                    "https://github.com/chogng/ash/releases/download/"
                )
            )
            media_release = json.loads(
                (output / "ash-resources/capabilities/media.json").read_text()
            )
            self.assertEqual("archive", media_release["source"]["kind"])
            archive_name = media_release["source"]["url"].rsplit("/", 1)[1]
            archive = output.parent / archive_name
            self.assertTrue(archive_name.startswith("ash-media-"))
            self.assertEqual(archive.stat().st_size, media_release["source"]["size"])
            self.assertEqual(
                hashlib.sha256(archive.read_bytes()).hexdigest(),
                media_release["source"]["sha256"],
            )
            # A separate extension repository/CDN may host exact bytes bound by the product.
            custom = media_package.capability_release(
                optional,
                TARGETS[target],
                "release",
                "media",
                "https://extensions.example.test/media.tar.gz",
            )
            self.assertEqual(
                "https://extensions.example.test/media.tar.gz", custom["source"]["url"]
            )
            self.assertEqual(media_release["buildId"], custom["buildId"])
            self.assertEqual(
                media_release["source"]["sha256"], custom["source"]["sha256"]
            )
            with self.assertRaises(ValueError):
                media_package.capability_release(
                    optional,
                    TARGETS[target],
                    "release",
                    "media",
                    "http://extensions.example.test/media.tar.gz",
                )
            media_package.validate_capability_package(
                hosting, TARGETS[target], "livekit"
            )
            metadata = json.loads((optional / "ash-package.json").read_text())
            self.assertEqual("media", metadata["javascriptRuntime"]["kind"])
            self.assertEqual(1, metadata["protocol"]["major"])

            media_package.validate_media_package(optional, TARGETS[target])
            artifacts = system_signing_artifacts(optional, TARGETS[target])
            self.assertEqual(
                {"livekitClient", "recognizer", "voiceHost"}, set(artifacts)
            )
            records = {}
            for name, binary in artifacts.items():
                unsigned = hashlib.sha256(binary.read_bytes()).hexdigest()
                binary.write_bytes(binary.read_bytes() + b"-signed")
                records[name] = {
                    "unsignedSha256": unsigned,
                    "signedSha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
                }
            record_system_signing(optional, TARGETS[target], records)
            require_verified_system_signing(optional, TARGETS[target])
            media_package.validate_media_package(optional, TARGETS[target])
            (optional / "bin/ash-livekit-client").write_bytes(b"tampered")
            with self.assertRaisesRegex(
                RuntimeError, "Invalid media package executable"
            ):
                media_package.validate_media_package(optional, TARGETS[target])
