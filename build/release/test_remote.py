"""Remote publication binds exact, complete archives to a matching Desktop protocol."""

import json
import tempfile
import unittest
from pathlib import Path

from build.lib.package_test_support import create_runtime_package
from build.lib.package import package_build_id, package_files
from build.release.remote import (
    archive_package,
    archive_record,
    read_binding,
    write_catalog,
)


class RemoteReleaseTests(unittest.TestCase):
    def test_windows_runtime_archives_bind_exe_payloads_to_the_catalog(self):
        for target in ("x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"):
            with (
                self.subTest(target=target),
                tempfile.TemporaryDirectory() as temporary,
            ):
                root = Path(temporary)
                (root / "source").mkdir()
                package = create_runtime_package(
                    root / "source", target, media_distribution="none"
                )
                self.assertTrue((package / "bin/ash-remote-server.exe").is_file())
                archive = root / f"ash-remote-{target}.tar.gz"
                archive_package(package, archive, unsigned=True)
                self.assertEqual(archive_record(archive)[0]["target"], target)

    def test_publication_rejects_local_media_download_descriptors(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "source").mkdir()
            package = create_runtime_package(
                root / "source", "aarch64-apple-darwin", media_distribution="none"
            )
            descriptor = package / "ash-resources/capabilities/livekit.json"
            descriptor.parent.mkdir()
            descriptor.write_text("{}")
            path = package / "ash-package.json"
            metadata = json.loads(path.read_text())
            identity = {
                key: value
                for key, value in metadata.items()
                if key not in ("files", "buildId")
            }
            files = package_files(package)
            metadata.update(files=files, buildId=package_build_id(identity, files))
            path.write_text(json.dumps(metadata))
            with self.assertRaisesRegex(ValueError, "media-free"):
                archive_package(
                    package,
                    root / "ash-remote-aarch64-apple-darwin.tar.gz",
                    unsigned=True,
                )

    def test_release_catalog_and_client_binding_preserve_exact_archive_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "source").mkdir()
            package = create_runtime_package(
                root / "source", "aarch64-apple-darwin", media_distribution="optional"
            )
            assets = root / "assets"
            archive = assets / "ash-remote-aarch64-apple-darwin.tar.gz"
            archive_package(package, archive, unsigned=True)
            catalog = assets / "catalog.json"
            binding = root / "remote-release.json"
            write_catalog(
                assets,
                catalog,
                binding,
                "chogng/ash",
                "remote-fixture",
                ["aarch64-apple-darwin"],
            )
            record, metadata = archive_record(archive)
            self.assertEqual(json.loads(catalog.read_text())["artifacts"], [record])
            self.assertEqual(record["archiveSize"], archive.stat().st_size)
            self.assertEqual(
                record["unpackedSize"],
                sum(
                    path.stat().st_size for path in package.rglob("*") if path.is_file()
                ),
            )
            release = read_binding(binding, metadata)
            self.assertEqual(release["trustBinding"], "signedProductPackage")
            self.assertEqual(
                release["url"],
                "https://github.com/chogng/ash/releases/download/remote-fixture/catalog.json",
            )
            with self.assertRaisesRegex(ValueError, "every selected target"):
                write_catalog(
                    assets,
                    catalog,
                    binding,
                    "chogng/ash",
                    "remote-fixture",
                    ["aarch64-apple-darwin", "x86_64-unknown-linux-gnu"],
                )
            with self.assertRaisesRegex(ValueError, "protocol/version"):
                read_binding(binding, {**metadata, "protocol": {"major": 999}})
            document = json.loads(binding.read_text())
            document["catalog"]["url"] = "https://user@downloads.test/catalog.json"
            binding.write_text(json.dumps(document))
            with self.assertRaisesRegex(ValueError, "URL or digest"):
                read_binding(binding, metadata)

    def test_publication_rejects_media_and_tampered_package_payloads(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "bundled").mkdir()
            (root / "plain").mkdir()
            bundled = create_runtime_package(
                root / "bundled", "aarch64-apple-darwin", media_distribution="bundled"
            )
            output = root / "ash-remote-aarch64-apple-darwin.tar.gz"
            with self.assertRaisesRegex(ValueError, "media-free"):
                archive_package(bundled, output, unsigned=True)
            package = create_runtime_package(
                root / "plain", "aarch64-apple-darwin", media_distribution="optional"
            )
            (package / "bin/ash-app-server").write_bytes(b"modified")
            with self.assertRaisesRegex(RuntimeError, "digest"):
                archive_package(package, output, unsigned=True)
