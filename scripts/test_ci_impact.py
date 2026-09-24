"""Verify conservative product selection from Cargo dependencies and changed files."""

import unittest
from pathlib import Path

import ci_impact


ROOT = Path("/workspace")


def package(name: str, path: str, *dependencies: str) -> dict:
    return {
        "id": name,
        "name": name,
        "manifest_path": str(ROOT / path / "Cargo.toml"),
        "dependencies": [{"name": dependency} for dependency in dependencies],
    }


class CiImpactTests(unittest.TestCase):
    def setUp(self) -> None:
        packages = [
            package("ash-tui", "code/tui", "shared"),
            package("ash-cli", "ash-cli", "shared"),
            package("ash-app-server", "ash-rs/app-server", "shared"),
            package("ash-app-server-daemon", "ash-rs/app-server-daemon"),
            package("ash-remote-server", "ash-rs/remote-server"),
            package("shared", "ash-rs/shared", "leaf"),
            package("leaf", "ash-rs/leaf"),
            package("app", "app-rs", "unrelated"),
            package("unrelated", "ash-rs/unrelated"),
        ]
        self.metadata = {
            "packages": packages,
            "workspace_members": [entry["id"] for entry in packages],
        }

    def test_product_and_transitive_dependency_changes_run_tui(self) -> None:
        for path in (
            "code/tui/src/lib.rs",
            "ash-rs/leaf/src/lib.rs",
            "ash-rs/app-server/src/lib.rs",
            "code/tui/src/view.snap",
        ):
            with self.subTest(path=path):
                self.assertTrue(ci_impact.tui_affected([path], self.metadata, ROOT))

    def test_unrelated_package_changes_skip_tui(self) -> None:
        self.assertFalse(
            ci_impact.tui_affected(
                ["app-rs/src/main.rs", "ash-rs/unrelated/src/lib.rs"],
                self.metadata,
                ROOT,
            )
        )

    def test_global_and_unowned_changes_run_tui(self) -> None:
        for path in (
            "Cargo.lock",
            ".cargo/config.toml",
            "scripts/cargo.py",
            "build/lib/targets.py",
            "third_party/ripgrep/runtime-lock.json",
            "ash-rs/deleted/src/lib.rs",
            "build/code/run.py",
        ):
            with self.subTest(path=path):
                self.assertTrue(ci_impact.tui_affected([path], self.metadata, ROOT))

    def test_empty_change_list_runs_tui(self) -> None:
        self.assertTrue(ci_impact.tui_affected([], self.metadata, ROOT))

    def test_unknown_product_blocks_selection(self) -> None:
        with self.assertRaisesRegex(ValueError, "unknown Cargo products"):
            ci_impact.dependency_closure(self.metadata, ("missing",))


if __name__ == "__main__":
    unittest.main()
