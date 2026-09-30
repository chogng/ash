"""Incremental development runtime publication contracts."""

import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from build.ash_rs import develop


def prepared_package(root: Path) -> Path:
    package = root / "package"
    for directory in ("bin", "ash-path", "ash-resources/tgrep"):
        (package / directory).mkdir(parents=True)
    for name, contents in {
        "bin/ash-app-server": "old",
        "bin/ash-app-server-daemon": "daemon",
        "bin/ash-code-mode-host": "host",
        "ash-path/rg": "rg",
        "ash-resources/tgrep/tgrep": "tgrep",
    }.items():
        (package / name).write_text(contents)
    return package


class DevelopTests(unittest.TestCase):
    @unittest.skipUnless(develop.os.name == "nt", "Windows hard-link path boundary")
    def test_resource_links_support_long_windows_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path("\\\\?\\" + temporary)
            try:
                package = prepared_package(root)
                resource = (
                    package
                    / "ash-resources"
                    / ("a" * 100)
                    / ("b" * 100)
                    / "grammar.json"
                )
                resource.parent.mkdir(parents=True)
                resource.write_text("long grammar")
                directory = root / "development"
                _, generation = develop.publish_generation(package, {}, directory)
                self.assertEqual(
                    "long grammar",
                    (
                        directory
                        / "generations"
                        / generation
                        / resource.relative_to(package)
                    ).read_text(),
                )
            finally:
                shutil.rmtree(root)

    def test_publication_reuses_unchanged_outputs_and_preserves_resources(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = prepared_package(root)
            directory = root / "development"
            first = develop.publish_generation(package, {}, directory)
            pointer = directory / "current.json"
            self.assertEqual(
                {"version": 3, "runtime": "generations/" + first[1]},
                json.loads(pointer.read_text()),
            )
            self.assertEqual(
                (False, first[1]), develop.publish_generation(package, {}, directory)
            )
            binary = root / "ash-app-server"
            binary.write_text("new")
            second = develop.publish_generation(
                package, {"ash-app-server": binary}, directory
            )
            self.assertTrue(second[0])
            binary.write_text("next Cargo output")
            runtime = directory / "generations" / second[1]
            self.assertEqual("new", (runtime / "bin/ash-app-server").read_text())
            self.assertEqual(
                (directory / "generations" / first[1] / "bin/ash-code-mode-host")
                .stat()
                .st_ino,
                (runtime / "bin/ash-code-mode-host").stat().st_ino,
            )
            shutil.rmtree(package)
            self.assertEqual("rg", (runtime / "ash-path/rg").read_text())
            self.assertEqual(
                "tgrep", (runtime / "ash-resources/tgrep/tgrep").read_text()
            )
            self.assertFalse((runtime / "ash-package.json").exists())

    def test_incremental_build_uses_existing_resources_without_package_assembly(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = prepared_package(root)
            binary = root / "ash-app-server"
            binary.write_text("incremental")
            with (
                patch.object(develop, "current_package", return_value=package),
                patch.object(
                    develop, "build_binaries", return_value={"ash-app-server": binary}
                ) as build,
            ):
                changed, generation = develop.build_development_server(root=root)
            self.assertTrue(changed)
            self.assertEqual(
                "incremental",
                (
                    root
                    / ".build/app-ts/dev/app-server/generations"
                    / generation
                    / "bin/ash-app-server"
                ).read_text(),
            )
            self.assertEqual("dev-small", build.call_args.kwargs["cargo_profile"])
            self.assertTrue(build.call_args.kwargs["host_build"])

    def test_selecting_prepared_outputs_does_not_invoke_cargo(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = prepared_package(root)
            with (
                patch.object(develop, "current_package", return_value=package),
                patch.object(develop, "build_binaries") as build,
            ):
                develop.build_development_server(root=root, select_prepared=True)
            build.assert_not_called()

    def test_failed_build_preserves_selected_generation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = prepared_package(root)
            pointer = root / ".build/app-ts/dev/app-server/current.json"
            pointer.parent.mkdir(parents=True)
            pointer.write_text("selected")
            with (
                patch.object(develop, "current_package", return_value=package),
                patch.object(
                    develop, "build_binaries", side_effect=RuntimeError("build failed")
                ),
            ):
                with self.assertRaisesRegex(RuntimeError, "build failed"):
                    develop.build_development_server(root=root)
            self.assertEqual("selected", pointer.read_text())

    def test_incomplete_resources_do_not_publish_or_leave_staging(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = prepared_package(root)
            directory = root / "development"
            develop.publish_generation(package, {}, directory)
            selected = (directory / "current.json").read_text()
            shutil.rmtree(package / "ash-resources")
            binary = root / "ash-app-server"
            binary.write_text("new")
            with self.assertRaises(FileNotFoundError):
                develop.publish_generation(
                    package, {"ash-app-server": binary}, directory
                )
            self.assertEqual(selected, (directory / "current.json").read_text())
            self.assertEqual([], list(directory.glob(".staging-*")))


if __name__ == "__main__":
    unittest.main()
