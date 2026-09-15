"""Tests for shared Cargo output paths and compiler messages."""

import tempfile
import unittest
from pathlib import Path

from build.lib.cargo import cargo_profile_directory
from build.lib.cargo import cargo_artifact_executable
from build.lib.cargo import cargo_rendered_diagnostic
from build.lib.cargo import parse_cargo_message
from build.lib.cargo import resolve_cargo_target_directory


class CargoTests(unittest.TestCase):
    def test_uses_canonical_build_directory_by_default(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "workspace" / "ash"
            self.assertEqual(
                resolve_cargo_target_directory(root, {}),
                (root / ".build" / "cargo").resolve(),
            )

    def test_resolves_relative_override_from_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "workspace" / "ash"
            self.assertEqual(
                resolve_cargo_target_directory(
                    root, {"CARGO_TARGET_DIR": "build/cargo"}
                ),
                (root / "build" / "cargo").resolve(),
            )

    def test_canonicalizes_absolute_override(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "workspace" / "ash"
            target = Path(temporary) / "cache" / "ash"
            self.assertEqual(
                resolve_cargo_target_directory(root, {"CARGO_TARGET_DIR": str(target)}),
                target.resolve(),
            )

    def test_maps_only_the_builtin_dev_profile_directory(self) -> None:
        self.assertEqual(cargo_profile_directory("dev"), "debug")
        self.assertEqual(cargo_profile_directory("dev-small"), "dev-small")
        self.assertEqual(cargo_profile_directory("release"), "release")

    def test_reads_executables_and_diagnostics_from_cargo_messages(self) -> None:
        artifact = parse_cargo_message(
            '{"reason":"compiler-artifact","target":{"kind":["bin"],'
            '"name":"app"},"executable":"/custom/target/app"}'
        )
        self.assertEqual(
            cargo_artifact_executable(artifact, "app"),
            "/custom/target/app",
        )
        self.assertIsNone(cargo_artifact_executable(artifact, "other"))
        self.assertEqual(
            cargo_rendered_diagnostic(
                {
                    "reason": "compiler-message",
                    "message": {"rendered": "warning\n"},
                }
            ),
            "warning\n",
        )
        self.assertIsNone(parse_cargo_message("not JSON"))


if __name__ == "__main__":
    unittest.main()
