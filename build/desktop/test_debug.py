import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from build.desktop import debug
from build.desktop.test_develop import prepared_package
from build.lib.development_store import publish_generation


class DebugBackendTests(unittest.TestCase):
    def test_debug_build_publishes_a_separate_immutable_generation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = prepared_package(root)
            binary = root / "ash-app-server"
            binary.write_text("debug symbols")
            symbols = root / "ash_app_server.pdb"
            symbols.write_text("separate symbols")
            dsym = root / (
                "ash-app-server.dSYM" if os.name == "nt" else "deps/ash-app-server.dSYM"
            )
            dwarf = dsym / "Contents/Resources/DWARF/ash-app-server"
            dwarf.parent.mkdir(parents=True)
            dwarf.write_text("indexed debug symbols")
            if os.name != "nt":
                Path(str(binary) + ".dSYM").symlink_to(dsym, target_is_directory=True)
            artifact = {
                "reason": "compiler-artifact",
                "target": {"name": "ash-app-server", "kind": ["bin"]},
                "executable": str(binary),
                "filenames": [str(binary), str(symbols)],
            }
            with (
                patch.object(debug, "ROOT", root),
                patch.object(
                    debug, "default_target", return_value="aarch64-apple-darwin"
                ),
                patch.object(debug, "current_package", return_value=package),
                patch.object(
                    debug.subprocess,
                    "run",
                    return_value=subprocess.CompletedProcess(
                        [], 0, json.dumps(artifact)
                    ),
                ),
            ):
                debug.prepare_debug_backend()
            directory = root / ".build/desktop/debug/app-server"
            pointer = json.loads((directory / "current.json").read_text())
            runtime = directory / pointer["runtime"]
            binary.write_text("later Cargo build")
            self.assertEqual(
                "debug symbols", (runtime / "bin/ash-app-server").read_text()
            )
            self.assertEqual(
                "separate symbols", (runtime / "bin/ash_app_server.pdb").read_text()
            )
            symbol_path = (
                "bin/ash-app-server.dSYM/Contents/Resources/DWARF/ash-app-server"
            )
            dwarf.write_text("later symbols")
            self.assertEqual(
                "indexed debug symbols", (runtime / symbol_path).read_text()
            )
            self.assertTrue((runtime / "ash-resources").is_dir())

            _, next_generation = publish_generation(
                package,
                {"ash-app-server": runtime / "bin/ash-app-server", "pdb": symbols},
                directory,
                symbol_directories={"ash-app-server.dSYM": dsym},
            )
            self.assertNotEqual(pointer["runtime"], f"generations/{next_generation}")
            self.assertEqual(
                "later symbols",
                (directory / "generations" / next_generation / symbol_path).read_text(),
            )
            self.assertFalse(
                (root / ".build/desktop/dev/app-server/current.json").exists()
            )

    def test_debug_build_rejects_missing_packed_symbols_before_publication(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / "ash-app-server"
            binary.write_text("executable")
            artifact = {
                "reason": "compiler-artifact",
                "target": {"name": "ash-app-server", "kind": ["bin"]},
                "executable": str(binary),
                "filenames": [str(binary)],
            }
            with (
                patch.object(debug, "ROOT", root),
                patch.object(
                    debug, "default_target", return_value="aarch64-apple-darwin"
                ),
                patch.object(
                    debug, "current_package", return_value=prepared_package(root)
                ),
                patch.object(
                    debug.subprocess,
                    "run",
                    return_value=subprocess.CompletedProcess(
                        [], 0, json.dumps(artifact)
                    ),
                ),
            ):
                with self.assertRaisesRegex(ValueError, "packed dSYM"):
                    debug.prepare_debug_backend()
            self.assertFalse(
                (root / ".build/desktop/debug/app-server/current.json").exists()
            )

    def test_failed_build_preserves_the_debug_generation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            pointer = root / ".build/desktop/debug/app-server/current.json"
            pointer.parent.mkdir(parents=True)
            pointer.write_text("previous generation")
            with (
                patch.object(debug, "ROOT", root),
                patch.object(
                    debug, "current_package", return_value=prepared_package(root)
                ),
                patch.object(
                    debug.subprocess,
                    "run",
                    return_value=subprocess.CompletedProcess([], 101, ""),
                ),
            ):
                with self.assertRaises(subprocess.CalledProcessError):
                    debug.prepare_debug_backend()
            self.assertEqual("previous generation", pointer.read_text())


if __name__ == "__main__":
    unittest.main()
