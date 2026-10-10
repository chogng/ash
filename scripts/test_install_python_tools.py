"""Exercise uv setup and stale-lock rejection without downloading dependencies."""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
UV = shutil.which("uv")


@unittest.skipUnless(UV, "uv is required for Python tool installation tests")
class PythonToolInstallationTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="ash python tools ")
        self.addCleanup(temporary.cleanup)
        self.project = Path(temporary.name) / "scripts"
        self.project.mkdir()
        shutil.copyfile(
            ROOT / "scripts/install_python_tools.py",
            self.project / "install_python_tools.py",
        )
        self.metadata = '[project]\nname = "setup-test"\nversion = "0.0.0"\nrequires-python = ">=3.11"\n'
        (self.project / "pyproject.toml").write_text(self.metadata, encoding="utf-8")
        self.environment = {
            **os.environ,
            "UV_OFFLINE": "true",
            "UV_PROJECT_ENVIRONMENT": str(self.project.parent / "other-environment"),
        }
        subprocess.run(
            [
                UV,
                "lock",
                "--project",
                str(self.project),
                "--python",
                sys.executable,
                "--no-python-downloads",
            ],
            env=self.environment,
            check=True,
            capture_output=True,
        )
        self.lock = (self.project / "uv.lock").read_bytes()

    def install(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-B", str(self.project / "install_python_tools.py")],
            cwd=self.project.parent,
            env=self.environment,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_sync_preserves_selected_interpreter_and_repository_environment(
        self,
    ) -> None:
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        environment = self.project / ".venv"
        python = environment / (
            "Scripts/python.exe" if os.name == "nt" else "bin/python"
        )
        probe = subprocess.check_output(
            [
                str(python),
                "-c",
                "import json, sys; print(json.dumps([sys.prefix, list(sys.version_info[:3])]))",
            ],
            text=True,
        )
        prefix, version = json.loads(probe)
        self.assertEqual(Path(prefix).resolve(), environment.resolve())
        self.assertEqual(version, list(sys.version_info[:3]))
        self.assertFalse((self.project.parent / "other-environment").exists())
        self.assertEqual((self.project / "uv.lock").read_bytes(), self.lock)

    def test_stale_lock_fails_without_updating_lock(self) -> None:
        tool = self.project.parent / "tool"
        tool.mkdir()
        (tool / "pyproject.toml").write_text(
            '[project]\nname = "setup-extra"\nversion = "0.0.0"\n'
            "[tool.uv]\npackage = false\n",
            encoding="utf-8",
        )
        (self.project / "pyproject.toml").write_text(
            self.metadata
            + 'dependencies = ["setup-extra"]\n'
            + '[tool.uv.sources]\nsetup-extra = { path = "../tool" }\n',
            encoding="utf-8",
        )
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--locked", result.stderr)
        self.assertEqual((self.project / "uv.lock").read_bytes(), self.lock)


if __name__ == "__main__":
    unittest.main()
