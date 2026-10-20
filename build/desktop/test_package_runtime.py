"""Desktop variants preserve standalone packages, signatures and runtime contracts."""

import json
import tempfile
import unittest
from pathlib import Path

from build.desktop.package_runtime import build_desktop_runtime
from build.lib.package import (
    file_sha256,
    record_system_signing,
    system_signing_artifacts,
    validate_package_directory,
)
from build.lib.package_test_support import create_runtime_package
from build.lib.targets import target_spec


class DesktopRuntimeTests(unittest.TestCase):
    def test_network_remote_binding_is_verified_and_kept_without_remote_payload(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = create_runtime_package(
                root, "aarch64-apple-darwin", media_distribution="bundled"
            )
            metadata = json.loads((source / "ash-package.json").read_text())
            binding = root / "remote-release.json"
            binding.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "version": metadata["version"],
                        "protocol": metadata["protocol"],
                        "catalog": {
                            "url": "https://github.com/chogng/ash/releases/download/remote-test/catalog.json",
                            "sha256": "a" * 64,
                        },
                    }
                )
            )
            output = build_desktop_runtime(source, root / "desktop", "44.4.5", binding)
            result = json.loads((output / "ash-package.json").read_text())
            self.assertEqual(result["remoteRuntimeCatalog"]["sha256"], "a" * 64)
            self.assertNotIn("remoteServer", result["components"])
            self.assertTrue((output / "bin/ash-app-server").is_file())
            self.assertFalse((output / "bin/ash-remote-server").exists())
            self.assertFalse((output / "ash-remote-runtimes").exists())
            validate_package_directory(output, target_spec("aarch64-apple-darwin"))
            document = json.loads(binding.read_text())
            document["protocol"]["major"] = 999
            binding.write_text(json.dumps(document))
            with self.assertRaisesRegex(ValueError, "protocol/version"):
                build_desktop_runtime(
                    source, root / "wrong-protocol", "44.4.5", binding
                )

    def test_desktop_omits_node_and_its_license_without_changing_standalone_packages(
        self,
    ):
        for target in ("x86_64-pc-windows-msvc", "aarch64-apple-darwin"):
            with (
                self.subTest(target=target),
                tempfile.TemporaryDirectory() as temporary,
            ):
                root = Path(temporary)
                source = create_runtime_package(
                    root, target, media_distribution="bundled"
                )
                before = (source / "ash-package.json").read_bytes()
                output = build_desktop_runtime(source, root / "desktop", "44.4.5")
                spec = target_spec(target)
                metadata = json.loads(
                    (output / "ash-package.json").read_text(encoding="utf-8")
                )
                self.assertEqual(
                    metadata["javascriptRuntime"],
                    {"kind": "hostProvidedNode", "electronVersion": "44.4.5"},
                )
                self.assertNotIn("node", metadata["components"])
                self.assertNotIn("remoteServer", metadata["components"])
                self.assertFalse((output / "bin" / spec.remote_server_name).exists())
                self.assertTrue((source / "bin" / spec.remote_server_name).is_file())
                self.assertTrue(
                    {"livekitClient", "recognizer", "voiceHost"}.issubset(
                        metadata["components"]
                    )
                )
                self.assertNotIn("livekit", metadata["components"])
                self.assertFalse(
                    (output / "ash-resources/capabilities/media.json").exists()
                )
                self.assertNotIn("node", system_signing_artifacts(output, spec))
                self.assertFalse((output / "ash-resources/node").exists())
                self.assertFalse((output / "ash-resources/licenses/node").exists())
                self.assertTrue((output / "bin" / spec.code_mode_host_name).is_file())
                for name in ("node.mjs", "ash.mjs", "host.mjs", "scm.js"):
                    self.assertTrue(
                        (output / "ash-resources/extension-host" / name).is_file()
                    )
                self.assertEqual((source / "ash-package.json").read_bytes(), before)
                self.assertTrue(
                    (source / "ash-resources/node/bin" / spec.node_name).is_file()
                )
                validate_package_directory(source, spec)
                validate_package_directory(output, spec)

    def test_existing_signatures_remain_complete_after_node_is_removed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            spec = target_spec("x86_64-pc-windows-msvc")
            source = create_runtime_package(
                root, spec.target, media_distribution="bundled"
            )
            records = {
                name: {
                    "unsignedSha256": file_sha256(path),
                    "signedSha256": file_sha256(path),
                }
                for name, path in system_signing_artifacts(source, spec).items()
            }
            record_system_signing(source, spec, records)
            output = build_desktop_runtime(source, root / "desktop", "44.4.5")
            metadata = json.loads(
                (output / "ash-package.json").read_text(encoding="utf-8")
            )
            self.assertNotIn(
                "node",
                [record["name"] for record in metadata["systemSigning"]["artifacts"]],
            )
            self.assertNotIn("remoteServer", system_signing_artifacts(output, spec))
            validate_package_directory(output, spec)

    def test_invalid_versions_reuse_and_overlapping_outputs_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = create_runtime_package(
                root, "x86_64-pc-windows-msvc", media_distribution="bundled"
            )
            for version in ("", "44", "044.4.5", "44.4.5\n", "../44.4.5"):
                with self.subTest(version=version), self.assertRaises(ValueError):
                    build_desktop_runtime(source, root / "invalid", version)
            with self.assertRaisesRegex(ValueError, "separate"):
                build_desktop_runtime(source, source / "nested", "44.4.5")
            first = build_desktop_runtime(source, root / "first", "44.4.5")
            with self.assertRaisesRegex(ValueError, "contract"):
                build_desktop_runtime(first, root / "second", "45.0.0")
            with self.assertRaisesRegex(ValueError, "replace"):
                build_desktop_runtime(source, first, "44.4.5")

    def test_optional_or_legacy_hosting_backend_cannot_silently_create_a_desktop(self):
        for distribution in ("optional", "legacy"):
            with (
                self.subTest(distribution=distribution),
                tempfile.TemporaryDirectory() as temporary,
            ):
                root = Path(temporary)
                source = create_runtime_package(
                    root, "aarch64-apple-darwin", media_distribution=distribution
                )
                with self.assertRaisesRegex(
                    ValueError, "Desktop requires bundled media"
                ):
                    build_desktop_runtime(source, root / "desktop", "44.4.5")
                self.assertFalse((root / "desktop").exists())
