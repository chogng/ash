import json
import os
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from build.remote.bundle import build_remote_runtime_bundle
from build.remote.bundle import MAX_RUNTIME_ARCHIVE_BYTES
from build.remote.bundle import validate_remote_runtime_bundle


class RemoteRuntimeBundleTests(unittest.TestCase):
    def test_builds_deterministic_archives_and_catalog(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = create_package(root / "package")
            first = build_remote_runtime_bundle(root / "first", [package])
            for path in package.rglob("*"):
                os.utime(path, (86400, 86400))
            second = build_remote_runtime_bundle(root / "second", [package])

            first_catalog = json.loads((first.root / "catalog.json").read_text())
            second_catalog = json.loads((second.root / "catalog.json").read_text())
            self.assertEqual(first_catalog, second_catalog)
            self.assertEqual(first.catalog_sha256, second.catalog_sha256)
            artifact = first_catalog["artifacts"][0]
            self.assertEqual("x86_64-unknown-linux-gnu", artifact["target"])
            self.assertGreater(artifact["archiveSize"], 0)
            self.assertGreater(artifact["unpackedSize"], 0)
            with tarfile.open(first.root / artifact["archive"], "r:gz") as archive:
                self.assertEqual(
                    archive.extractfile("bin/ash-app-server").read(), b"ash"
                )
                self.assertEqual(archive.getmember("bin/ash-app-server").mode, 0o755)
                self.assertEqual(archive.getmember("ash-package.json").mode, 0o644)
                for member in archive.getmembers():
                    self.assertEqual((member.uid, member.gid, member.mtime), (0, 0, 0))
                    self.assertEqual((member.uname, member.gname), ("", ""))

    def test_validation_rejects_a_tampered_runtime_archive(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bundle = build_remote_runtime_bundle(
                root / "bundle", [create_package(root / "package")]
            )
            catalog = json.loads((bundle.root / "catalog.json").read_text())
            artifact = bundle.root / catalog["artifacts"][0]["archive"]
            artifact.write_bytes(artifact.read_bytes() + b"tampered")

            with self.assertRaisesRegex(RuntimeError, "size mismatch"):
                validate_remote_runtime_bundle(bundle.root)

    def test_validation_rejects_catalog_sizes_above_the_runtime_limits(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bundle = build_remote_runtime_bundle(
                root / "bundle", [create_package(root / "package")]
            )
            catalog_path = bundle.root / "catalog.json"
            catalog = json.loads(catalog_path.read_text())
            catalog["artifacts"][0]["archiveSize"] = MAX_RUNTIME_ARCHIVE_BYTES + 1
            catalog_path.write_text(json.dumps(catalog))

            with self.assertRaisesRegex(RuntimeError, "archive size exceeds"):
                validate_remote_runtime_bundle(bundle.root)


def create_package(path: Path) -> Path:
    files = {
        "bin/ash-app-server-daemon": b"daemon",
        "bin/ash-app-server": b"ash",
        "bin/ash-remote-server": b"remote",
        "bin/ash-exec-server": b"remote",
        "ash-path/rg": b"ripgrep",
        "ash-resources/node/bin/node": b"node",
    }
    metadata = {
        "layoutVersion": 2,
        "version": "0.1.0",
        "target": "x86_64-unknown-linux-gnu",
        "entrypoint": "bin/ash-app-server",
        "pathDir": "ash-path",
        "resourcesDir": "ash-resources",
        "javascriptRuntime": {"kind": "packagedNode"},
        "components": {},
    }
    path.mkdir()
    (path / "ash-package.json").write_text(json.dumps(metadata) + "\n")
    for relative, content in files.items():
        destination = path / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)
        destination.chmod(0o755)
    return path


if __name__ == "__main__":
    unittest.main()
