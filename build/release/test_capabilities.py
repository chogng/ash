"""Independent capabilities must remain available after product staging is removed."""

import hashlib
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from build.lib.media_package import assemble_capability_package
from build.lib.media_package import capability_release
from build.lib.package import package_build_id
from build.lib.targets import TARGETS
from build.release.capabilities import main
from build.release.capabilities import stage_packages

ROOT = Path(__file__).resolve().parents[2]
SPEC = TARGETS["aarch64-apple-darwin"]


class CapabilityReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.assets = self.root / "assets"
        self.product = self.root / "product"
        self.product.mkdir()
        self.releases = {}
        for kind, binaries in [
            ("media", ["ash-livekit-client", "ash-realtime-voice", "ash-voice-host"]),
            ("livekit", ["livekit-server"]),
        ]:
            inputs = {}
            for name in binaries:
                executable = self.root / name
                executable.write_bytes(name.encode())
                inputs[name] = executable
            package = assemble_capability_package(
                self.root / "temporary-stage" / kind,
                ROOT,
                SPEC,
                inputs,
                "ci-test",
                kind,
            )
            self.releases[kind] = capability_release(
                package, SPEC, "release", kind, archive_dir=self.assets
            )
        self.write_product()
        shutil.rmtree(self.root / "temporary-stage")

    def write_product(self):
        files = {}
        for kind, release in self.releases.items():
            if kind == "media" and getattr(self, "bundled", False):
                (self.product / "ash-resources/capabilities/media.json").unlink(
                    missing_ok=True
                )
                continue
            name = f"ash-resources/capabilities/{kind}.json"
            path = self.product / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(release))
            files[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        metadata = {"layoutVersion": 2, "target": SPEC.target, "version": "0.1.0"}
        if getattr(self, "bundled", False):
            metadata["components"] = {}
            (self.product / "bin").mkdir(exist_ok=True)
            for component, name in (
                ("livekitClient", "ash-livekit-client"),
                ("recognizer", "ash-realtime-voice"),
                ("voiceHost", "ash-voice-host"),
            ):
                relative = f"bin/{name}"
                (self.product / relative).write_bytes(name.encode())
                digest = hashlib.sha256(name.encode()).hexdigest()
                files[relative] = digest
                metadata["components"][component] = {"binarySha256": digest}
        (self.product / "ash-package.json").write_text(
            json.dumps(
                {
                    **metadata,
                    "files": files,
                    "buildId": package_build_id(metadata, files),
                }
            )
        )

    def test_exact_assets_survive_temporary_packaging_and_deduplicate_products(self):
        unrelated = self.assets / "ash-media-stale.tar.gz"
        unrelated.write_bytes(b"do not publish by glob")
        desktop = self.root / "desktop"
        shutil.copytree(self.product, desktop)
        output = self.root / "published"
        names = stage_packages([self.product, desktop], [self.assets], output)
        self.assertEqual(2, len(names))
        self.assertEqual(set(names), {path.name for path in output.iterdir()})
        self.assertNotIn(unrelated.name, names)
        self.assertEqual(
            0,
            main(
                [
                    "stage",
                    "--package-dir",
                    str(desktop),
                    "--archives-dir",
                    str(self.assets),
                    "--output",
                    str(output),
                ]
            ),
        )

    def test_missing_or_modified_asset_fails_before_staging_anything(self):
        archive = (
            self.assets / self.releases["media"]["source"]["url"].rsplit("/", 1)[1]
        )
        original = archive.read_bytes()
        archive.unlink()
        output = self.root / "published"
        with self.assertRaisesRegex(RuntimeError, "Missing product-bound"):
            stage_packages([self.product], [self.assets], output)
        self.assertFalse(output.exists())
        archive.write_bytes(original + b"tampered")
        with self.assertRaisesRegex(RuntimeError, "differs from product binding"):
            stage_packages([self.product], [self.assets], output)
        self.assertFalse(output.exists())

    def test_descriptor_tampering_and_offline_bindings_are_not_publishable(self):
        descriptor = self.product / "ash-resources/capabilities/media.json"
        descriptor.write_text("{}")
        with self.assertRaisesRegex(RuntimeError, "Unbound capability descriptor"):
            stage_packages([self.product], [self.assets], self.root / "published")
        self.releases["media"]["source"] = {
            "kind": "directory",
            "path": "/developer/cache",
        }
        self.write_product()
        with self.assertRaisesRegex(RuntimeError, "Invalid release capability"):
            stage_packages([self.product], [self.assets], self.root / "published")

    def test_transport_hash_cannot_substitute_a_different_capability(self):
        source = self.releases["livekit"]["source"]
        self.releases["media"]["source"] = dict(source)
        self.write_product()
        with self.assertRaisesRegex(RuntimeError, "identity differs"):
            stage_packages([self.product], [self.assets], self.root / "published")

    def test_existing_output_cannot_be_replaced_by_other_bytes(self):
        output = self.root / "published"
        names = stage_packages([self.product], [self.assets], output)
        (output / names[0]).write_bytes(b"other asset")
        with self.assertRaisesRegex(RuntimeError, "Refusing to replace"):
            stage_packages([self.product], [self.assets], output)

    def test_custom_download_filename_stages_the_verified_canonical_archive(self):
        self.releases["media"]["source"]["url"] = (
            "https://cdn.example.test/media.tar.gz"
        )
        self.write_product()
        output = self.root / "published"
        names = stage_packages([self.product], [self.assets], output)
        self.assertIn("media.tar.gz", names)
        self.assertEqual(
            self.releases["media"]["source"]["sha256"],
            hashlib.sha256((output / "media.tar.gz").read_bytes()).hexdigest(),
        )

    def test_bundled_desktop_stages_only_hosting_and_validates_embedded_media(self):
        self.bundled = True
        self.write_product()
        media_archive = (
            self.assets / self.releases["media"]["source"]["url"].rsplit("/", 1)[1]
        )
        media_archive.unlink()
        names = stage_packages([self.product], [self.assets], self.root / "published")
        self.assertEqual(1, len(names))
        self.assertTrue(names[0].startswith("ash-livekit-"))
        (self.product / "bin/ash-voice-host").write_bytes(b"tampered")
        with self.assertRaisesRegex(RuntimeError, "Invalid bundled media executable"):
            stage_packages([self.product], [self.assets], self.root / "next")
        self.assertFalse((self.root / "next").exists())
