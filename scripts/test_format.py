from __future__ import annotations

import json
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
            root = Path(directory).resolve()

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
            git("commit", "-m", "baseline")
            base = git("rev-parse", "HEAD")
            (root / "first.py").write_text("committed\n")
            git("add", "--", "first.py")
            git("commit", "-m", "change")
            (root / "deleted.py").unlink()
            (root / "new [with spaces].py").write_text("untracked\n")
            with patch.object(formatting, "REPOSITORY_ROOT", root):
                self.assertEqual(
                    formatting.select_files([], base),
                    {"first.py", "new [with spaces].py"},
                )
                self.assertEqual(
                    formatting.select_files(["new [with spaces].py"], None),
                    {"new [with spaces].py"},
                )
                with self.assertRaisesRegex(
                    ValueError, "must belong to the repository"
                ):
                    formatting.select_files(["../outside.py"], None)


@unittest.skipUnless(
    (formatting.REPOSITORY_ROOT / "node_modules/bun/package.json").is_file(),
    "Scoped integration tests run in Frontend CI after installing frontend tools",
)
class ScopedFormattingTests(unittest.TestCase):
    """Exercise scoped commands with real formatters and isolated source files."""

    def setUp(self) -> None:
        self.root = formatting.REPOSITORY_ROOT
        directory = tempfile.TemporaryDirectory(
            prefix=".formatter-test-", dir=self.root / "build"
        )
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)

    def write(self, name: str, contents: str) -> Path:
        path = self.directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(contents, encoding="utf-8", newline="\n")
        return path

    def invoke(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-B", str(self.root / "scripts/format.py"), *args],
            cwd=self.root,
            encoding="utf-8",
            capture_output=True,
            check=False,
        )

    def test_frontend_checks_do_not_need_package_manager_discovery(self) -> None:
        source = self.write("example.ts", "const value = 1;\n")
        config = self.write("example.json", "[1, 2]\n")
        with patch.object(
            formatting,
            "package_manager",
            side_effect=AssertionError("Prepared checks must not start pnpm"),
        ):
            self.assertEqual(
                formatting.scoped(True, [str(self.directory)], None, None), 0
            )
        self.assertEqual(source.read_text(), "const value = 1;\n")
        self.assertEqual(config.read_text(), "[1, 2]\n")

    def test_scoped_checks_are_read_only_and_fix_each_selected_language(self) -> None:
        cases = {
            "file [with spaces].ts": (
                "function example() {\n\treturn 1;\n}\n",
                "function example(){\n  return 1\n}\n",
            ),
            "file.py": ("value = [1, 2]\n", "value=[1,2]\n"),
            "file.json": ("[1, 2]\n", "[1,2]\n"),
        }
        for name, (_, bad) in cases.items():
            self.write(name, bad)
        result = self.invoke("--check", str(self.directory))
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        for name, (_, bad) in cases.items():
            self.assertIn(name, result.stderr)
            self.assertEqual((self.directory / name).read_text(), bad)
        result = self.invoke(str(self.directory))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for name, (good, _) in cases.items():
            self.assertEqual((self.directory / name).read_text(), good)
        result = self.invoke("--check", str(self.directory))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_excluded_sources_keep_the_full_repository_ownership_rules(self) -> None:
        for name in ("fixtures/example.ts", "fixtures/example.json", "example.d.ts"):
            self.write(name, "unformatted contents\n")
        result = self.invoke("--check", str(self.directory))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_config_snapshots_match_direct_bun_output_and_preserve_unselected_files(
        self,
    ) -> None:
        cases = {
            "config [with spaces].json": '{"value":1}\n',
            "config.jsonc": '{\n// retained\n"value":1,\n}\n',
            "workflow.yaml": "name:   example\non: [push,pull_request]\n",
            "notes.md": "#   Heading\n\n```ts\nconst value=1\n```\n",
            "style.css": ".example{color:red;padding:0  1px}\n",
            "index.html": "<main><p>example</p><p>text</p></main>\n",
        }
        paths = {
            self.write(name, contents): contents for name, contents in cases.items()
        }
        workspace_config = self.root / ".vscode" / f"{self.directory.name}.jsonc"
        workspace_config.write_text(cases["config.jsonc"], encoding="utf-8")
        self.addCleanup(workspace_config.unlink)
        paths[workspace_config] = cases["config.jsonc"]
        neighbor = self.write("neighbor.json", '{"untouched":true}\n')
        ignored = self.write("fixtures/invalid.json", "invalid fixture\n")
        selected = [str(path) for path in paths] + [str(ignored)]
        expected = {}
        for path, original in paths.items():
            direct = subprocess.run(
                [
                    str(
                        self.root
                        / "node_modules/bun"
                        / ("bun.exe" if sys.platform == "win32" else "bun")
                    ),
                    "fmt",
                    "--ignore-path",
                    ".gitignore",
                    "--ignore-path",
                    ".prettierignore",
                    "--stdin-filepath",
                    str(path),
                ],
                cwd=self.root,
                input=original,
                encoding="utf-8",
                capture_output=True,
                check=True,
            )
            expected[path] = direct.stdout
            self.assertNotEqual(direct.stdout, original, str(path))
        result = self.invoke("--language", "config", "--check", *selected)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        for path, original in paths.items():
            self.assertEqual(path.read_text(), original)
        result = self.invoke("--language", "config", *selected)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for path, formatted in expected.items():
            self.assertEqual(path.read_text(), formatted, str(path))
        self.assertEqual(neighbor.read_text(), '{"untouched":true}\n')
        self.assertEqual(ignored.read_text(), "invalid fixture\n")
        result = self.invoke("--language", "config", "--check", *selected)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_config_snapshot_applies_git_ignores_to_explicit_files(self) -> None:
        source = self.write("output/generated.json", "invalid generated JSON\n")
        selected = {source.relative_to(self.root).as_posix()}
        with tempfile.TemporaryDirectory(prefix="ash format snapshot ") as directory:
            snapshot = Path(directory)
            formatting.snapshot_files(snapshot, selected)
            commands = formatting.scoped_commands(False, snapshot, selected, "config")
            for command in commands:
                _, code, diagnostic = formatting.run(command)
                self.assertEqual(code, 0, diagnostic)
            self.assertEqual(
                (snapshot / source.relative_to(self.root)).read_text(),
                "invalid generated JSON\n",
            )

    def test_rust_formats_only_the_selected_file_without_traversing_children(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(
            prefix=".formatter-test-", dir=self.root / "crates/tui"
        ) as directory:
            root = Path(directory)
            source = root / "example.rs"
            child = root / "child.rs"
            good = "mod child;\n\nfn example() {}\n"
            source.write_text(good, encoding="utf-8", newline="\n")
            child.write_text("invalid Rust input\n", encoding="utf-8", newline="\n")
            result = self.invoke("--check", "--language", "rust", str(source))
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            source.write_text(
                "mod child;\n\nfn example(){}\n", encoding="utf-8", newline="\n"
            )
            result = self.invoke("--check", "--language", "rust", str(source))
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            result = self.invoke("--language", "rust", str(source))
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(source.read_text(), good)
            self.assertEqual(child.read_text(), "invalid Rust input\n")

    def test_scoped_write_formats_only_selected_files(self) -> None:
        path = self.write("selected.py", "value=[1,2]\n")
        neighbor = self.write("neighbor.py", "value=[1,2]\n")
        result = self.invoke(str(path))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(path.read_text(), "value = [1, 2]\n")
        self.assertEqual(neighbor.read_text(), "value=[1,2]\n")


if __name__ == "__main__":
    unittest.main()
