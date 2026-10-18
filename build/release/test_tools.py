"""Host tool discovery and aggregated build-test prerequisite failures."""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from build.release import tools


class BuildToolTests(unittest.TestCase):
    def test_custom_directory_and_path_take_precedence_over_vs_discovery(self):
        with tempfile.TemporaryDirectory() as temporary:
            binary = Path(temporary) / "llvm-pdbutil.exe"
            binary.touch()
            with (
                patch.dict(os.environ, {"ASH_LLVM_BIN": temporary}),
                patch.object(tools, "windows_llvm_directories") as discover,
            ):
                self.assertEqual(tools.tool("llvm-pdbutil"), str(binary))
                discover.assert_not_called()
            with (
                patch.dict(os.environ, {"ASH_LLVM_BIN": temporary + "/missing"}),
                patch.object(Path, "is_file", return_value=False),
                patch.object(tools.shutil, "which", return_value="on-path"),
                patch.object(tools, "windows_llvm_directories") as discover,
            ):
                self.assertEqual(tools.tool("llvm-pdbutil"), "on-path")
                discover.assert_not_called()

    def test_visual_studio_tools_are_found_without_path_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            binary = directory / "llvm-pdbutil.exe"
            binary.touch()
            with (
                patch.dict(os.environ, {"ASH_LLVM_BIN": str(directory / "missing")}),
                patch.object(tools.sys, "platform", "win32"),
                patch.object(
                    Path,
                    "is_file",
                    autospec=True,
                    side_effect=lambda path: path == binary,
                ),
                patch.object(tools.shutil, "which", return_value=None),
                patch.object(
                    tools, "windows_llvm_directories", return_value=(directory,)
                ),
            ):
                self.assertEqual(tools.tool("llvm-pdbutil"), str(binary))

    def test_vs_inventory_uses_host_architecture_and_custom_installation_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            vswhere = root / "Microsoft Visual Studio/Installer/vswhere.exe"
            vswhere.parent.mkdir(parents=True)
            vswhere.touch()
            for machine, host in [("AMD64", "x64"), ("ARM64", "ARM64")]:
                with (
                    self.subTest(machine=machine),
                    patch.dict(os.environ, {"ProgramFiles(x86)": str(root)}),
                    patch.object(tools.platform, "machine", return_value=machine),
                    patch.object(
                        tools.subprocess,
                        "run",
                        return_value=subprocess.CompletedProcess(
                            [], 0, "D:/VS custom\nE:/Other VS\n"
                        ),
                    ) as run,
                ):
                    tools.windows_llvm_directories.cache_clear()
                    self.addCleanup(tools.windows_llvm_directories.cache_clear)
                    directories = tools.windows_llvm_directories()
                    self.assertIn(
                        Path("D:/VS custom/VC/Tools/Llvm") / host / "bin", directories
                    )
                    self.assertIn(
                        Path("E:/Other VS/VC/Tools/Llvm") / host / "bin", directories
                    )
                    self.assertEqual(run.call_args.args[0][0], str(vswhere))

    def test_windows_preflight_reports_all_missing_tools(self):
        with (
            patch.object(tools.sys, "platform", "win32"),
            patch.object(tools, "tool", side_effect=RuntimeError("unavailable")),
            patch.object(tools, "run") as run,
            self.assertRaises(RuntimeError) as failure,
        ):
            tools.check_build_tools()
        for name in ("rustc", "llvm-pdbutil", "llvm-symbolizer", "ASH_LLVM_BIN"):
            self.assertIn(name, str(failure.exception))
        run.assert_not_called()

    def test_unusable_executable_is_reported_during_preflight(self):
        with (
            patch.object(tools.sys, "platform", "win32"),
            patch.object(tools, "tool", side_effect=lambda name: name),
            patch.object(tools, "run", side_effect=OSError("bad executable")) as run,
            self.assertRaisesRegex(RuntimeError, "bad executable"),
        ):
            tools.check_build_tools()
        self.assertEqual(run.call_count, 3)

    def test_linux_checks_dwarf_tools_without_requiring_pdb_tools(self):
        with (
            patch.object(tools.sys, "platform", "linux"),
            patch.object(tools, "tool", side_effect=lambda name: name),
            patch.object(tools, "run"),
        ):
            resolved = tools.check_build_tools()
        self.assertIn("llvm-dwarfdump", resolved)
        self.assertIn("llvm-nm", resolved)
        self.assertNotIn("llvm-pdbutil", resolved)

    def test_macos_preserves_xcode_symbolizer_fallback_and_checks_lldb_python(self):
        def locate(name):
            if name == "llvm-symbolizer":
                raise RuntimeError("not installed")
            return name

        with (
            patch.object(tools.sys, "platform", "darwin"),
            patch.object(tools, "tool", side_effect=locate),
            patch.object(tools, "run", return_value="\nASH_LLDB_PYTHON_OK\n") as run,
        ):
            self.assertIn("atos", tools.check_build_tools())
            run.return_value = "error: Python scripting is disabled"
            with self.assertRaisesRegex(RuntimeError, "Python scripting support"):
                tools.check_build_tools()


if __name__ == "__main__":
    unittest.main()
