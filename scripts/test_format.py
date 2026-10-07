from __future__ import annotations

import json
import sys
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
                    formatting.REPOSITORY_ROOT / "crates/vendor/mxc/Cargo.toml"
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


if __name__ == "__main__":
    unittest.main()
