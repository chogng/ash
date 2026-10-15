from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import format as formatting


class FormatterTests(unittest.TestCase):
    def metadata(self) -> str:
        packages = [
            {
                "id": "ash-code",
                "name": "ash-code",
                "manifest_path": str(
                    formatting.REPOSITORY_ROOT / "crates/tui/Cargo.toml"
                ),
            },
            {
                "id": "vendored",
                "name": "vendored",
                "manifest_path": str(
                    formatting.REPOSITORY_ROOT / "crates/vendor/example/Cargo.toml"
                ),
            },
            {
                "id": "third-party",
                "name": "third-party",
                "manifest_path": str(
                    formatting.REPOSITORY_ROOT / "third_party/example/Cargo.toml"
                ),
            },
            {
                "id": "external",
                "name": "external",
                "manifest_path": "/outside/Cargo.toml",
            },
        ]
        return json.dumps(
            {
                "workspace_members": ["ash-code", "vendored", "third-party"],
                "packages": packages,
            }
        )

    def test_each_language_uses_its_own_check_and_write_entrypoint(self) -> None:
        with (
            patch.object(formatting.shutil, "which", return_value="/tools/pnpm"),
            patch.object(
                formatting.subprocess, "check_output", return_value=self.metadata()
            ),
        ):
            checks = {
                command.name: command.args for command in formatting.commands(True)
            }
            writes = {
                command.name: command.args for command in formatting.commands(False)
            }

        self.assertEqual(
            {
                name: checks[name]
                for name in ("TypeScript/JavaScript", "Configuration/documentation")
            },
            {
                "TypeScript/JavaScript": ("/tools/pnpm", "format:ts"),
                "Configuration/documentation": ("/tools/pnpm", "format:config"),
            },
        )
        self.assertEqual(
            writes["TypeScript/JavaScript"], ("/tools/pnpm", "format:ts:fix")
        )
        self.assertEqual(
            writes["Configuration/documentation"], ("/tools/pnpm", "format:config:fix")
        )
        self.assertEqual(
            checks["Rust"],
            (
                "cargo",
                "fmt",
                "--manifest-path",
                "Cargo.toml",
                "--package",
                "ash-code",
                "--",
                "--check",
            ),
        )
        self.assertNotIn("--check", writes["Rust"])

    def test_rust_only_formatting_needs_no_frontend_package_manager(self) -> None:
        with (
            patch.object(
                formatting.shutil,
                "which",
                side_effect=AssertionError("Rust must not look up pnpm"),
            ),
            patch.object(
                formatting.subprocess, "check_output", return_value=self.metadata()
            ),
        ):
            commands = formatting.commands(True, "rust")
        self.assertEqual(
            commands,
            (
                formatting.Command(
                    "Rust",
                    (
                        "cargo",
                        "fmt",
                        "--manifest-path",
                        "Cargo.toml",
                        "--package",
                        "ash-code",
                        "--",
                        "--check",
                    ),
                ),
            ),
        )

    def test_utf8_diagnostics_preserve_the_formatter_failure(self) -> None:
        diagnostic = "格式检查：未对齐 → 请修复\n"
        command = formatting.Command(
            "Example",
            (
                sys.executable,
                "-c",
                f"import sys; sys.stdout.buffer.write({diagnostic.encode('utf-8')!r}); sys.exit(2)",
            ),
        )

        self.assertEqual(formatting.run(command), ("Example", 2, diagnostic))

    def test_just_only_checks_need_neither_cargo_nor_frontend_dependencies(
        self,
    ) -> None:
        with patch.object(
            formatting.subprocess,
            "check_output",
            side_effect=AssertionError("No Cargo metadata needed"),
        ):
            self.assertEqual(
                [command.name for command in formatting.commands(True, "just")],
                ["Just"],
            )


class SelectionTests(unittest.TestCase):
    def test_just_version_drift_fails_with_the_required_version(self) -> None:
        expected = (formatting.REPOSITORY_ROOT / ".just-version").read_text().strip()
        with patch.object(
            formatting.subprocess, "check_output", return_value="just 0.0.0\n"
        ):
            with self.assertRaisesRegex(ValueError, f"Install Just {expected}"):
                formatting.check_just_version(formatting.REPOSITORY_ROOT)

    def test_changed_scope_covers_commits_worktree_and_untracked_files(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ash format selection ") as directory:
            root = Path(directory)

            def git(*args: str) -> str:
                return subprocess.check_output(
                    [
                        "git",
                        "-c",
                        f"core.hooksPath={root / 'no-hooks'}",
                        "-c",
                        "commit.gpgsign=false",
                        "-c",
                        "user.name=Formatter",
                        "-c",
                        "user.email=formatter@example.test",
                        *args,
                    ],
                    cwd=root,
                    encoding="utf-8",
                    stderr=subprocess.PIPE,
                ).strip()

            git("init")
            (root / "first.py").write_text("original\n")
            (root / "deleted.py").write_text("original\n")
            git("add", "--", "first.py", "deleted.py")
            with patch.object(formatting, "REPOSITORY_ROOT", root):
                self.assertEqual(
                    formatting.select_files([], None, True), {"first.py", "deleted.py"}
                )
            git("commit", "-m", "baseline")
            base = git("rev-parse", "HEAD")
            (root / "first.py").write_text("committed\n")
            git("add", "--", "first.py")
            git("commit", "-m", "change")
            (root / "deleted.py").unlink()
            (root / "new [with spaces].py").write_text("untracked\n")
            with patch.object(formatting, "REPOSITORY_ROOT", root):
                self.assertEqual(
                    formatting.select_files([], base, False),
                    {"first.py", "new [with spaces].py"},
                )
                self.assertEqual(
                    formatting.select_files(["new [with spaces].py"], None, False),
                    {"new [with spaces].py"},
                )
                with self.assertRaisesRegex(
                    ValueError, "must belong to the repository"
                ):
                    formatting.select_files(["../outside.py"], None, False)


@unittest.skipUnless(
    (formatting.REPOSITORY_ROOT / "node_modules/bun/package.json").is_file(),
    "Staged integration tests run in Formatting CI after installing frontend tools",
)
class StagedFormattingTests(unittest.TestCase):
    """Exercise real formatters and the hook with an isolated Git index."""

    def setUp(self) -> None:
        self.root = formatting.REPOSITORY_ROOT
        directory = tempfile.TemporaryDirectory(
            prefix=".formatter-test-", dir=self.root / "build"
        )
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)
        self.relative = self.directory.relative_to(self.root).as_posix()
        self.environment = {
            **os.environ,
            "GIT_INDEX_FILE": str(self.directory / "index"),
            "GIT_OPTIONAL_LOCKS": "0",
        }
        self.git("read-tree", "HEAD")
        index = Path(
            subprocess.check_output(
                ["git", "rev-parse", "--git-path", "index"], cwd=self.root, text=True
            ).strip()
        )
        self.index = self.root / index
        self.original_index = self.index.read_bytes()
        self.addCleanup(self.assert_real_index_unchanged)

    def assert_real_index_unchanged(self) -> None:
        self.assertEqual(self.index.read_bytes(), self.original_index)

    def git(self, *args: str, contents: str | None = None) -> str:
        return (
            subprocess.check_output(
                ["git", *args],
                cwd=self.root,
                env=self.environment,
                input=contents.encode("utf-8") if contents is not None else None,
            )
            .decode("utf-8")
            .strip()
        )

    def stage(self, name: str, contents: str) -> None:
        blob = self.git("hash-object", "-w", "--stdin", contents=contents)
        self.git("update-index", "--add", "--cacheinfo", "100644", blob, name)

    def invoke(
        self, *args: str, hook: bool = False
    ) -> subprocess.CompletedProcess[str]:
        command = (
            [
                "git",
                "-c",
                f"core.hooksPath={self.root / '.githooks'}",
                "hook",
                "run",
                "pre-commit",
            ]
            if hook
            else [sys.executable, "-B", str(self.root / "scripts/format.py"), *args]
        )
        before = (self.directory / "index").read_bytes()
        result = subprocess.run(
            command,
            cwd=self.root,
            env=self.environment,
            encoding="utf-8",
            capture_output=True,
            check=False,
        )
        self.assertEqual((self.directory / "index").read_bytes(), before)
        return result

    def test_hook_checks_partial_staging_in_both_directions_without_writing(
        self,
    ) -> None:
        cases = {
            "file [with spaces].ts": (
                "function example() {\n\treturn 1;\n}\n",
                "function example(){return 1}\n",
            ),
            "file.py": ("value = [1, 2]\n", "value=[1,2]\n"),
            "file.json": ("[1, 2]\n", "[1,2]\n"),
        }
        for staged_good in (True, False):
            with self.subTest(staged_good=staged_good):
                expected = {}
                for name, (good, bad) in cases.items():
                    self.stage(f"{self.relative}/{name}", good if staged_good else bad)
                    path = self.directory / name
                    path.write_text(
                        bad if staged_good else good, encoding="utf-8", newline="\n"
                    )
                    expected[path] = path.read_bytes()
                result = self.invoke(hook=True)
                self.assertEqual(
                    result.returncode,
                    0 if staged_good else 1,
                    result.stdout + result.stderr,
                )
                if not staged_good:
                    for name in cases:
                        self.assertIn(name, result.stderr)
                for path, contents in expected.items():
                    self.assertEqual(path.read_bytes(), contents)

    def test_staged_typescript_configuration_overrides_worktree_configuration(
        self,
    ) -> None:
        options = json.loads((self.root / "tsfmt.json").read_text())
        options.update(convertTabsToSpaces=True, indentSize=2, tabSize=2)
        self.stage("tsfmt.json", json.dumps(options))
        self.stage(
            f"{self.relative}/example.ts", "function example() {\n  return 1;\n}\n"
        )
        result = self.invoke("--check", "--staged", "--language", "typescript")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_deleted_files_are_skipped_and_renamed_destinations_are_checked(
        self,
    ) -> None:
        self.git("update-index", "--force-remove", "docs/build.md")
        result = self.invoke("--check", "--staged")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.stage(f"{self.relative}/renamed.json", "[1,2]\n")
        result = self.invoke("--check", "--staged")
        self.assertEqual(result.returncode, 1)
        self.assertIn("renamed.json", result.stderr)

    def test_excluded_sources_keep_the_full_repository_ownership_rules(self) -> None:
        for name in ("fixtures/example.ts", "fixtures/example.json", "example.d.ts"):
            self.stage(f"{self.relative}/{name}", "unformatted contents\n")
        self.stage("crates/vendor/formatter-test/example.rs", "unformatted Rust\n")
        result = self.invoke("--check", "--staged")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_rust_stdin_does_not_traverse_unstaged_child_modules(self) -> None:
        name = f"crates/tui/{self.directory.name}/example.rs"
        self.stage(name, "mod child;\n\nfn example() {}\n")
        result = self.invoke("--check", "--staged", "--language", "rust")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.stage(name, "mod child;\nfn example(){let value=1;}\n")
        result = self.invoke("--check", "--staged", "--language", "rust")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(name, result.stderr)

    def test_scoped_write_formats_only_selected_files(self) -> None:
        path = self.directory / "selected.py"
        neighbor = self.directory / "neighbor.py"
        path.write_text("value=[1,2]\n", encoding="utf-8", newline="\n")
        neighbor.write_text("value=[1,2]\n", encoding="utf-8", newline="\n")
        result = self.invoke(str(path))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(path.read_text(), "value = [1, 2]\n")
        self.assertEqual(neighbor.read_text(), "value=[1,2]\n")


if __name__ == "__main__":
    unittest.main()
