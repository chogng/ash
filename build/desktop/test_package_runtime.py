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
    def test_desktop_omits_node_and_its_license_without_changing_standalone_packages(
        self,
    ):
        for target in ("x86_64-pc-windows-msvc", "aarch64-apple-darwin"):
            with (
                self.subTest(target=target),
                tempfile.TemporaryDirectory() as temporary,
            ):
                root = Path(temporary)
                source = create_runtime_package(root, target)
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
                self.assertNotIn("node", system_signing_artifacts(output, spec))
                self.assertFalse((output / "ash-resources/node").exists())
                self.assertFalse((output / "ash-resources/licenses/node").exists())
                self.assertTrue((output / "bin" / spec.code_mode_host_name).is_file())
                for name in ("node.mjs", "host.mjs", "vscode.mjs", "scm.js"):
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
            source = create_runtime_package(root, spec.target)
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
            validate_package_directory(output, spec)

    def test_invalid_versions_reuse_and_overlapping_outputs_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = create_runtime_package(root, "x86_64-pc-windows-msvc")
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
