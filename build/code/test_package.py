"""Code package composition preserves its shared-runtime input boundary."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from build.lib.package import package_build_id
from build.code.package import build_code_package  # noqa: E402
from build.lib.package_test_support import create_runtime_package  # noqa: E402


class CodePackageTests(unittest.TestCase):
    def test_rejects_a_runtime_with_product_signing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cli = root / "ash"
            cli.write_bytes(b"cli-test-binary")
            cli.chmod(0o755)
            runtime = create_runtime_package(root, "aarch64-apple-darwin")
            metadata_path = runtime / "ash-package.json"
            metadata = json.loads(metadata_path.read_text())
            metadata["systemSigning"] = {"status": "signed"}
            identity = {
                key: value
                for key, value in metadata.items()
                if key not in ("files", "buildId")
            }
            metadata["buildId"] = package_build_id(identity, metadata["files"])
            metadata_path.write_text(json.dumps(metadata))

            with self.assertRaisesRegex(RuntimeError, "unsigned packaged-Node runtime"):
                build_code_package(runtime, root / "code-package", cli, "11" * 32)


if __name__ == "__main__":
    unittest.main()
