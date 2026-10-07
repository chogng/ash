"""Exercise build commands through their public script paths."""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


BUILD_ROOT = Path(__file__).resolve().parent


class BuildCommandTests(unittest.TestCase):
    def test_commands_load_outside_the_repository_without_pythonpath(self) -> None:
        commands = {
            "code/archive.py": "--output",
            "code/package.py": "--runtime-package",
            "runtime/build.py": "--javascript-runtime",
            "runtime/prepare.py": "--javascript-runtime",
            "runtime/sign.py": "--verify-only",
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


if __name__ == "__main__":
    unittest.main()
