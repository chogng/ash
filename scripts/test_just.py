"""Exercise the repository shell and argument forwarding through Just."""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class JustTests(unittest.TestCase):
    def run_recipe(self, script: str, *args: str) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory(prefix="ash just ") as directory:
            folder = Path(directory)
            probe = folder / "probe.py"
            probe.write_text(script, encoding="utf-8")
            configuration = (ROOT / "justfile").read_text(encoding="utf-8")
            configuration = configuration.split("# Format Just", 1)[0]
            recipe = folder / "justfile"
            recipe.write_text(
                configuration
                + '\nprobe *args:\n    {{ python }} "'
                + probe.as_posix()
                + '" {{ recipe_args }}\n',
                encoding="utf-8",
            )
            return subprocess.run(
                [
                    "just",
                    "--justfile",
                    str(recipe),
                    "--working-directory",
                    str(ROOT),
                    "probe",
                    *args,
                ],
                capture_output=True,
                text=True,
                check=False,
            )

    def test_arguments_keep_boundaries_and_literal_shell_characters(self) -> None:
        arguments = ["two words", "", "--flag", "a&b", "$value", "a'b", 'a"b']
        result = self.run_recipe(
            "import json, sys; print(json.dumps(sys.argv[1:]))", *arguments
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), arguments)

    def test_no_arguments_does_not_forward_recipe_name(self) -> None:
        result = self.run_recipe("import json, sys; print(json.dumps(sys.argv[1:]))")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [])

    def test_failed_command_fails_recipe(self) -> None:
        result = self.run_recipe("raise SystemExit(23)")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("recipe `probe` failed", result.stderr)


if __name__ == "__main__":
    unittest.main()
