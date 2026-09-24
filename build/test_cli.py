"""Exercise build commands through their public script paths."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from build.app_rs.remote.bundle import validate_remote_runtime_bundle
from build.app_rs.remote.test_bundle import create_package
from build.ash_rs.test_support import create_runtime_package


BUILD_ROOT = Path(__file__).resolve().parent


class BuildCommandTests(unittest.TestCase):
    def test_commands_load_outside_the_repository_without_pythonpath(self) -> None:
        commands = {
            "app_rs/build.py": "--app-bin",
            "app_rs/signing.py": "{sign,verify,record}",
            "code/archive.py": "--output",
            "code/package.py": "--runtime-package",
            "ash_rs/build.py": "--javascript-runtime",
            "ash_rs/prepare.py": "--javascript-runtime",
            "ash_rs/sign.py": "--verify-only",
            "app_rs/remote/bundle.py": "--bundle-dir",
            "darwin/notarize.py": "--staple",
        }
        with tempfile.TemporaryDirectory() as temporary:
            for script, option in commands.items():
                with self.subTest(script=script):
                    result = subprocess.run(
                        [
                            sys.executable,
                            "-E",
                            "-B",
                            str(BUILD_ROOT / script),
                            "--help",
                        ],
                        cwd=temporary,
                        capture_output=True,
                        text=True,
                        check=False,
                    )
                    self.assertEqual(0, result.returncode, result.stderr)
                    self.assertIn(option, result.stdout)

    def test_bundle_command_creates_a_valid_runtime_catalog(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = create_package(root / "package")
            output = root / "bundle"
            result = subprocess.run(
                [
                    sys.executable,
                    "-E",
                    "-B",
                    str(BUILD_ROOT / "app_rs/remote/bundle.py"),
                    "--bundle-dir",
                    str(output),
                    "--package-dir",
                    str(package),
                ],
                cwd=root,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(0, result.returncode, result.stderr)
            bundle = validate_remote_runtime_bundle(output)
            catalog = json.loads((bundle.root / "catalog.json").read_text())
            self.assertEqual(
                "x86_64-unknown-linux-gnu", catalog["artifacts"][0]["target"]
            )

    def test_app_command_stages_an_unsigned_package(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / "app"
            binary.write_bytes(b"app-command-test")
            output = root / "package"
            runtime = create_runtime_package(root, "x86_64-unknown-linux-gnu")
            result = subprocess.run(
                [
                    sys.executable,
                    "-E",
                    "-B",
                    str(BUILD_ROOT / "app_rs/build.py"),
                    "--app-bin",
                    str(binary),
                    "--runtime-package",
                    str(runtime),
                    "--package-dir",
                    str(output),
                    "--target",
                    "x86_64-unknown-linux-gnu",
                ],
                cwd=root,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(0, result.returncode, result.stderr)
            metadata = json.loads((output / "app-package.json").read_text())
            self.assertEqual("unsigned", metadata["signing"]["status"])
            self.assertEqual(binary.read_bytes(), (output / "bin/app").read_bytes())


if __name__ == "__main__":
    unittest.main()
