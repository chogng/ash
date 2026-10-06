from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
TOOLS_PYTHON = (
    REPOSITORY_ROOT
    / "scripts/.venv"
    / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
)
MISSPELLING = "recieve"  # codespell:ignore recieve


class SpellcheckTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / "repository"
        (self.root / "scripts").mkdir(parents=True)
        for name in (".codespellrc", ".codespellignore", "scripts/spellcheck.py"):
            shutil.copyfile(REPOSITORY_ROOT / name, self.root / name)
        self.write(".gitignore", ".build/\nnode_modules/\n")
        self.git("init", "--quiet")
        self.git("add", ".")

    def write(self, name: str, content: str) -> Path:
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def git(self, *args: str) -> None:
        subprocess.run(["git", *args], cwd=self.root, check=True, capture_output=True)

    def check(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(TOOLS_PYTHON), "-B", str(self.root / "scripts/spellcheck.py")],
            cwd=self.root.parent,
            text=True,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )

    def test_typos_fail_without_rewriting_files_or_treating_names_as_options(
        self,
    ) -> None:
        paths = [
            self.write(name, MISSPELLING)
            for name in ("notes with spaces.md", "--notes.md")
        ]
        self.git("add", "--", "notes with spaces.md")

        result = self.check()

        self.assertEqual(result.returncode, 65, result.stdout)
        for path in paths:
            self.assertIn(path.name, result.stdout)
            self.assertEqual(path.read_text(encoding="utf-8"), MISSPELLING)

    def test_hidden_new_files_are_checked_but_ignored_outputs_and_deleted_files_are_not(
        self,
    ) -> None:
        deleted = self.write("deleted.md", MISSPELLING)
        self.git("add", "deleted.md")
        deleted.unlink()
        self.write(".build/report.md", MISSPELLING)
        self.write("node_modules/package/README.md", MISSPELLING)
        hidden = self.write(".github/guide.md", MISSPELLING)

        result = self.check()
        self.assertEqual(result.returncode, 65, result.stdout)
        self.assertIn(".github/guide.md", result.stdout)
        hidden.write_text("receive", encoding="utf-8")
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_repository_terms_are_allowed_while_ordinary_typos_still_fail(self) -> None:
        self.write("README.md", "Ratatui iTerm IndentAction\n")
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stdout)

        self.write("README.md", f"Ratatui {MISSPELLING}\n")
        result = self.check()
        self.assertEqual(result.returncode, 65, result.stdout)
        self.assertIn("==> receive", result.stdout)

    def test_data_and_translation_exclusions_keep_production_sources_checked(
        self,
    ) -> None:
        for name in (
            "third_party/library/README.md",
            "ash-rs/vendor/library/src/lib.rs",
            "app-ts/src/generated/client.ts",
            "app-ts/src/fixtures/example.ts",
            "ash-rs/example/src/parser_tests.rs",
            "app-ts/src/example.test.ts",
            "extensions/example/syntaxes/example.json",
            "app-ts/localization/fr/strings.json",
            "app-rs/input-classifier/dictionaries/stems.txt",
            "docs/tools/captured-prompt.md",
        ):
            self.write(name, MISSPELLING)
        self.write(
            "ash-rs/example/src/lib.rs",
            'french: "autorisation", english: "Manual"\n',
        )
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stdout)

        self.write("ash-rs/example/src/lib.rs", MISSPELLING)
        result = self.check()
        self.assertEqual(result.returncode, 65, result.stdout)
        self.assertIn("ash-rs/example/src/lib.rs", result.stdout)

        self.write("ash-rs/example/src/lib.rs", "receive")
        self.write(
            "app-ts/localization/en/strings.json", f'{{"message": "{MISSPELLING}"}}'
        )
        result = self.check()
        self.assertEqual(result.returncode, 65, result.stdout)
        self.assertIn("app-ts/localization/en/strings.json", result.stdout)

    def test_mixed_translation_sources_keep_english_checked(self) -> None:
        self.write(
            "code/tui/src/nls.rs",
            'english: "Branch", french: "branche",\n',
        )
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stdout)

        self.write(
            "code/tui/src/nls.rs",
            f'english: "{MISSPELLING}", french: "branche",\n',
        )
        result = self.check()
        self.assertEqual(result.returncode, 65, result.stdout)
        self.assertIn("code/tui/src/nls.rs", result.stdout)

    def test_test_directories_and_spec_files_are_not_excluded_wholesale(self) -> None:
        for name in ("test/README.md", "tests/README.md", "app-ts/test/check.spec.ts"):
            with self.subTest(name=name):
                path = self.write(name, MISSPELLING)
                result = self.check()
                self.assertEqual(result.returncode, 65, result.stdout)
                self.assertIn(name, result.stdout)
                path.unlink()


if __name__ == "__main__":
    unittest.main()
