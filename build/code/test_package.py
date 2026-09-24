"""Code package composition preserves its shared-runtime input boundary."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from build.app_rs.build import build_package  # noqa: E402
from build.code.package import build_code_package  # noqa: E402
from build.ash_rs.test_support import create_runtime_package  # noqa: E402


class CodePackageTests(unittest.TestCase):
    def test_rejects_an_app_package_as_shared_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            app = root / "app"
            app.write_bytes(b"app-test-binary")
            app.chmod(0o755)
            cli = root / "ash"
            cli.write_bytes(b"cli-test-binary")
            cli.chmod(0o755)
            runtime = create_runtime_package(root, "aarch64-apple-darwin")
            product = root / "app-package"
            build_package(product, app, "aarch64-apple-darwin", "release", runtime)

            with self.assertRaisesRegex(RuntimeError, "unsigned packaged-Node runtime"):
                build_code_package(product, root / "code-package", cli, "11" * 32)


if __name__ == "__main__":
    unittest.main()
