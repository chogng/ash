"""Incremental development runtime publication contracts."""

import json
import multiprocessing
import os
import shutil
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch
from build.desktop import develop
from build.lib import development_store


def hold_process_lease(path, connection):
    with Path(path).open("r+b") as file:
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(file, fcntl.LOCK_SH)
        connection.send("ready")
        connection.recv()


@contextmanager
def process_lease(path):
    context = multiprocessing.get_context("spawn")
    parent, child = context.Pipe()
    process = context.Process(target=hold_process_lease, args=(str(path), child))
    process.start()
    child.close()
    try:
        if not parent.poll(10) or parent.recv() != "ready":
            raise AssertionError("lease process did not become ready")
        yield
        parent.send("release")
        process.join(10)
        if process.exitcode != 0:
            raise AssertionError(f"lease process failed: {process.exitcode}")
    finally:
        if process.is_alive():
            process.terminate()
            process.join(10)
        parent.close()


def publish_in_process(package, binary, directory, start, connection):
    start.wait(10)
    try:
        connection.send(
            development_store.publish_generation(
                Path(package), {"ash-app-server": Path(binary)}, Path(directory)
            )
        )
    except Exception as error:
        connection.send(repr(error))
    finally:
        connection.close()


def prepared_package(root: Path) -> Path:
    package = root / "package"
    for directory in (
        "bin",
        "ash-path",
        "ash-resources/tgrep",
        "ash-resources/extensions/rust",
    ):
        (package / directory).mkdir(parents=True)
    for name, contents in {
        "bin/ash-app-server": "old",
        "bin/ash-app-server-daemon": "daemon",
        "bin/ash-code-mode-host": "host",
        "ash-path/rg": "rg",
        "ash-resources/tgrep/tgrep": "tgrep",
        "ash-resources/extensions/rust/package.json": '{"name":"rust"}',
    }.items():
        (package / name).write_text(contents)
    return package


class DevelopTests(unittest.TestCase):
    def test_generations_keep_declarative_resources_readable_as_single_link_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = prepared_package(root)
            directory = root / "development"
            first = development_store.publish_generation(package, {}, directory)
            binary = root / "ash-app-server"
            binary.write_text("changed")
            first_runtime = directory / "generations" / first[1]
            resource = Path("ash-resources/extensions/rust/package.json")
            with process_lease(first_runtime / ".lease"):
                second = development_store.publish_generation(
                    package, {"ash-app-server": binary}, directory
                )
                for runtime in (
                    package,
                    first_runtime,
                    directory / "generations" / second[1],
                ):
                    self.assertEqual(1, (runtime / resource).stat().st_nlink)
                    self.assertEqual(
                        '{"name":"rust"}', (runtime / resource).read_text()
                    )

    @unittest.skipUnless(os.name == "nt", "Windows hard-link path boundary")
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
                _, generation = development_store.publish_generation(
                    package, {}, directory
                )
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
            first = development_store.publish_generation(package, {}, directory)
            pointer = directory / "current.json"
            self.assertEqual(
                {"version": 3, "runtime": "generations/" + first[1]},
                json.loads(pointer.read_text()),
            )
            self.assertEqual(
                (False, first[1]),
                development_store.publish_generation(package, {}, directory),
            )
            binary = root / "ash-app-server"
            binary.write_text("new")
            host_inode = (
                (directory / "generations" / first[1] / "bin/ash-code-mode-host")
                .stat()
                .st_ino
            )
            second = development_store.publish_generation(
                package, {"ash-app-server": binary}, directory
            )
            self.assertTrue(second[0])
            binary.write_text("next Cargo output")
            runtime = directory / "generations" / second[1]
            self.assertEqual("new", (runtime / "bin/ash-app-server").read_text())
            self.assertEqual(
                host_inode,
                (runtime / "bin/ash-code-mode-host").stat().st_ino,
            )
            shutil.rmtree(package)
            self.assertEqual("rg", (runtime / "ash-path/rg").read_text())
            self.assertEqual(
                "tgrep", (runtime / "ash-resources/tgrep/tgrep").read_text()
            )
            self.assertFalse((runtime / "ash-package.json").exists())

    def test_publication_collects_old_generations_and_unreferenced_objects(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = prepared_package(root)
            directory = root / "development"
            _, first = development_store.publish_generation(package, {}, directory)
            old_digest = development_store.sha256(package / "bin/ash-app-server")
            binary = root / "ash-app-server"
            binary.write_text("new")
            _, current = development_store.publish_generation(
                package, {"ash-app-server": binary}, directory
            )
            self.assertFalse((directory / "generations" / first).exists())
            self.assertEqual(
                [current], [path.name for path in (directory / "generations").iterdir()]
            )
            self.assertFalse((directory / "objects" / old_digest).exists())
            self.assertEqual(3, len(list((directory / "objects").iterdir())))
            for path in (directory / "objects").iterdir():
                self.assertEqual(2, path.stat().st_nlink)

    def test_leased_generation_survives_until_an_unchanged_publication_after_exit(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = prepared_package(root)
            directory = root / "development"
            _, first = development_store.publish_generation(package, {}, directory)
            runtime = directory / "generations" / first
            old_digest = development_store.sha256(package / "bin/ash-app-server")
            binary = root / "ash-app-server"
            binary.write_text("new")
            with process_lease(runtime / ".lease"):
                _, current = development_store.publish_generation(
                    package, {"ash-app-server": binary}, directory
                )
                self.assertEqual("old", (runtime / "bin/ash-app-server").read_text())
                self.assertTrue((directory / "objects" / old_digest).exists())
                self.assertEqual(2, len(list((directory / "generations").iterdir())))
            orphan = directory / "objects" / ("a" * 64)
            orphan.write_text("unreferenced")
            self.assertEqual(
                (False, current),
                development_store.publish_generation(
                    package, {"ash-app-server": binary}, directory
                ),
            )
            self.assertFalse(runtime.exists())
            self.assertFalse((directory / "objects" / old_digest).exists())
            self.assertFalse(orphan.exists())

    def test_concurrent_publishers_preserve_the_selected_runtime_and_its_objects(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = prepared_package(root)
            directory = root / "development"
            context = multiprocessing.get_context("spawn")
            start = context.Event()
            processes = []
            connections = []
            try:
                for index in range(4):
                    binary = root / f"build-{index}" / "ash-app-server"
                    binary.parent.mkdir()
                    binary.write_text(f"binary-{index}")
                    parent, child = context.Pipe()
                    process = context.Process(
                        target=publish_in_process,
                        args=(str(package), str(binary), str(directory), start, child),
                    )
                    process.start()
                    child.close()
                    processes.append(process)
                    connections.append(parent)
                start.set()
                results = []
                for connection, process in zip(connections, processes):
                    self.assertTrue(connection.poll(15), "publisher did not finish")
                    result = connection.recv()
                    self.assertIsInstance(result, tuple, result)
                    self.assertTrue(result[0])
                    results.append(result[1])
                    process.join(10)
                    self.assertEqual(0, process.exitcode)
                pointer = json.loads((directory / "current.json").read_text())
                runtime = directory / pointer["runtime"]
                self.assertIn(runtime.name, results)
                self.assertEqual([runtime], list((directory / "generations").iterdir()))
                self.assertIn(
                    (runtime / "bin/ash-app-server").read_text(),
                    {f"binary-{index}" for index in range(4)},
                )
                for immutable in (directory / "objects").iterdir():
                    self.assertEqual(2, immutable.stat().st_nlink)
                    self.assertEqual(
                        immutable.name, development_store.sha256(immutable)
                    )
            finally:
                for process in processes:
                    if process.is_alive():
                        process.terminate()
                    process.join(10)
                for connection in connections:
                    connection.close()

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
                    / ".build/desktop/dev/app-server/generations"
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
            pointer = root / ".build/desktop/dev/app-server/current.json"
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
            development_store.publish_generation(package, {}, directory)
            selected = (directory / "current.json").read_text()
            shutil.rmtree(package / "ash-resources")
            binary = root / "ash-app-server"
            binary.write_text("new")
            with self.assertRaises(FileNotFoundError):
                development_store.publish_generation(
                    package, {"ash-app-server": binary}, directory
                )
            self.assertEqual(selected, (directory / "current.json").read_text())
            self.assertEqual([], list(directory.glob(".staging-*")))


if __name__ == "__main__":
    unittest.main()
