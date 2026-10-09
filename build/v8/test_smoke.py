"""Check staged pairs enter the real Bazel graph with the matching ABI."""

import tempfile
import tarfile
import unittest
from pathlib import Path
from unittest.mock import patch

from build.download.artifacts import sha256
from build.lib.v8 import load_v8_lock
from build.v8.release import checksum_name, source_lock
from build.v8.smoke import bazel_arguments, pair_environment, prepare_musl_linker


class V8SmokeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="ash v8 smoke ")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.target = "x86_64-unknown-linux-gnu"
        self.pair = load_v8_lock()[self.target]
        self.paths = [
            self.directory / item.name
            for item in (self.pair.archive, self.pair.binding)
        ]
        for path in self.paths:
            path.write_bytes(b"staged " + path.name.encode())
        (self.directory / checksum_name(self.target)).write_text(
            "".join(f"{sha256(path)}  {path.name}\n" for path in self.paths)
        )

    def test_bazel_tests_use_staged_inputs_and_serial_sandbox_execution(self):
        arguments = bazel_arguments(
            self.target, self.directory, self.directory / "repos", run=True
        )
        self.assertEqual("test", arguments[0])
        self.assertIn("//crates/v8-poc:v8-poc-unit-tests", arguments)
        self.assertIn("--test_arg=--test-threads=1", arguments)
        self.assertIn("--//:rusty_v8_from_source=False", arguments)
        overrides = [
            item.split("=", 2)[2]
            for item in arguments
            if item.startswith("--override_repository=")
        ]
        self.assertEqual(2, len(overrides))
        for directory, original in zip(overrides, self.paths, strict=True):
            files = Path(directory) / "file"
            self.assertEqual(
                original.read_bytes(), (files / original.name).read_bytes()
            )
            self.assertIn('name = "file"', (files / "BUILD.bazel").read_text())
        link_arguments = bazel_arguments(
            self.target, self.directory, self.directory / "repos", run=False
        )
        self.assertEqual("build", link_arguments[0])
        self.assertNotIn("--test_arg=--test-threads=1", link_arguments)
        self.assertIn(
            "--@bazel_tools//tools/test:incompatible_use_default_test_toolchain=false",
            link_arguments,
        )

    def test_musl_uses_both_libc_constraints_and_only_x64_runs_on_linux_host(self):
        for target, arch in (
            ("aarch64-unknown-linux-musl", "arm64"),
            ("x86_64-unknown-linux-musl", "amd64"),
        ):
            pair = load_v8_lock()[target]
            paths = [
                self.directory / item.name for item in (pair.archive, pair.binding)
            ]
            for path in paths:
                path.write_bytes(b"staged " + path.name.encode())
            (self.directory / checksum_name(target)).write_text(
                "".join(f"{sha256(path)}  {path.name}\n" for path in paths)
            )
            arguments = bazel_arguments(
                target, self.directory, self.directory / "repos", run=arch == "amd64"
            )
            self.assertIn(f"--platforms=//third_party/v8:linux_{arch}_musl", arguments)
            self.assertEqual(
                arch == "amd64",
                "--extra_toolchains=//third_party/v8:musl_x64_tests_on_linux_host"
                in arguments,
            )

    def test_bazel_rejects_corrupt_pairs_before_creating_overrides(self):
        self.paths[0].write_bytes(b"corrupt")
        output = self.directory / "repos"
        with self.assertRaisesRegex(ValueError, "checksum validation"):
            bazel_arguments(self.target, self.directory, output, run=True)
        self.assertFalse(output.exists())

    def test_downloaded_pair_is_checked_before_exporting_cargo_inputs(self):
        values = pair_environment(self.target, self.directory)
        self.assertEqual(
            {
                "RUSTY_V8_ARCHIVE": str(self.paths[0].resolve()),
                "RUSTY_V8_SRC_BINDING_PATH": str(self.paths[1].resolve()),
            },
            values,
        )
        self.paths[1].write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError, "checksum validation"):
            pair_environment(self.target, self.directory)

    def test_musl_linker_uses_one_crt_provider(self):
        pin, output = self.musl_toolchain_fixture()
        version = pin["muslLinker"]["version"]
        with (
            patch("build.v8.smoke.source_lock", return_value=pin),
            patch(
                "build.v8.smoke.subprocess.check_output", return_value=version + "\n"
            ),
            patch("build.v8.smoke.subprocess.run") as build_runtime,
        ):
            arm_values = prepare_musl_linker("aarch64-unknown-linux-musl", output)
            x64_values = prepare_musl_linker("x86_64-unknown-linux-musl", output)
        prefix = "CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL"
        self.assertEqual(
            "-C linker-flavor=ld -C link-self-contained=yes",
            arm_values[prefix + "_RUSTFLAGS"],
        )
        wrapper = Path(arm_values[prefix + "_LINKER"])
        self.assertIn('ld.lld --fix-cortex-a53-843419 "$@"', wrapper.read_text())
        self.assertIn("aarch64-unknown-linux-musl-clear-cache.a", wrapper.read_text())
        build_runtime.assert_called_once()
        self.assertIn("-fno-compiler-rt", build_runtime.call_args.args[0])
        prefix = "CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL"
        self.assertEqual("-C link-self-contained=no", x64_values[prefix + "_RUSTFLAGS"])
        self.assertIn(
            "cc -target x86_64-linux-musl",
            Path(x64_values[prefix + "_LINKER"]).read_text(),
        )

    def musl_toolchain_fixture(self):
        output = self.directory / "linker"
        output.mkdir()
        pin = source_lock()
        version = pin["muslLinker"]["version"]
        payload = self.directory / "zig"
        payload.write_bytes(b"fixture compiler")
        archive = output / "zig.tar.xz"
        with tarfile.open(archive, "w:xz") as contents:
            contents.add(payload, arcname=f"zig-x86_64-linux-{version}/zig")
            contents.add(
                payload,
                arcname=f"zig-x86_64-linux-{version}/lib/compiler_rt/clear_cache.zig",
            )
        pin["muslLinker"]["sha256"] = sha256(archive)
        return pin, output

    def test_musl_toolchain_reuses_verified_extraction_and_repairs_changed_inputs(self):
        pin, output = self.musl_toolchain_fixture()
        version = pin["muslLinker"]["version"]
        library = (
            output
            / pin["muslLinker"]["sha256"]
            / f"zig-x86_64-linux-{version}/lib/compiler_rt/clear_cache.zig"
        )
        with (
            patch("build.v8.smoke.source_lock", return_value=pin),
            patch(
                "build.v8.smoke.subprocess.check_output", return_value=version + "\n"
            ),
            patch(
                "build.v8.smoke.tarfile.TarFile.extractall",
                autospec=True,
                side_effect=tarfile.TarFile.extractall,
            ) as extract,
        ):
            first = prepare_musl_linker("x86_64-unknown-linux-musl", output)
            original_mtime = library.stat().st_mtime_ns
            second = prepare_musl_linker("x86_64-unknown-linux-musl", output)
            self.assertEqual(first, second)
            self.assertEqual(original_mtime, library.stat().st_mtime_ns)
            self.assertEqual(1, extract.call_count)
            library.write_bytes(b"changed library")
            prepare_musl_linker("x86_64-unknown-linux-musl", output)
            self.assertEqual(b"fixture compiler", library.read_bytes())
            self.assertEqual(2, extract.call_count)
            library.unlink()
            prepare_musl_linker("x86_64-unknown-linux-musl", output)
            self.assertEqual(b"fixture compiler", library.read_bytes())
            self.assertEqual(3, extract.call_count)

    def test_failed_musl_extraction_preserves_previous_toolchain_until_repair(self):
        pin, output = self.musl_toolchain_fixture()
        version = pin["muslLinker"]["version"]
        cache = output / pin["muslLinker"]["sha256"]
        compiler = cache / f"zig-x86_64-linux-{version}/zig"
        stamp = cache / ".zig-extraction.json"
        with (
            patch("build.v8.smoke.source_lock", return_value=pin),
            patch(
                "build.v8.smoke.subprocess.check_output", return_value=version + "\n"
            ),
        ):
            prepare_musl_linker("x86_64-unknown-linux-musl", output)
            original_stamp = stamp.read_bytes()
            stamp.write_bytes(b"incomplete record")
            with (
                patch(
                    "build.v8.smoke.tarfile.TarFile.extractall",
                    side_effect=OSError("interrupted extraction"),
                ),
                self.assertRaisesRegex(OSError, "interrupted extraction"),
            ):
                prepare_musl_linker("x86_64-unknown-linux-musl", output)
            self.assertEqual(b"fixture compiler", compiler.read_bytes())
            self.assertEqual(b"incomplete record", stamp.read_bytes())
            self.assertEqual([], list(cache.glob(".zig-extract-*")))
            prepare_musl_linker("x86_64-unknown-linux-musl", output)
            self.assertEqual(original_stamp, stamp.read_bytes())

    def test_changed_musl_pin_preserves_paths_in_use_by_previous_consumers(self):
        pin, output = self.musl_toolchain_fixture()
        version = pin["muslLinker"]["version"]
        with (
            patch("build.v8.smoke.source_lock", return_value=pin),
            patch(
                "build.v8.smoke.subprocess.check_output", return_value=version + "\n"
            ),
        ):
            original = prepare_musl_linker("x86_64-unknown-linux-musl", output)
            old_wrapper = Path(
                original["CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER"]
            )
            old_compiler = old_wrapper.parent / f"zig-x86_64-linux-{version}/zig"
            payload = self.directory / "zig"
            payload.write_bytes(b"updated compiler")
            archive = output / "zig.tar.xz"
            with tarfile.open(archive, "w:xz") as contents:
                contents.add(payload, arcname=f"zig-x86_64-linux-{version}/zig")
            pin["muslLinker"]["sha256"] = sha256(archive)
            updated = prepare_musl_linker("x86_64-unknown-linux-musl", output)
            wrapper = Path(updated["CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER"])
            compiler = wrapper.parent / f"zig-x86_64-linux-{version}/zig"
            self.assertEqual(b"updated compiler", compiler.read_bytes())
            self.assertFalse((compiler.parent / "lib").exists())
            self.assertNotEqual(old_wrapper, wrapper)
            self.assertEqual(b"fixture compiler", old_compiler.read_bytes())
            self.assertIn(str(old_compiler), old_wrapper.read_text())

    def test_msvc_cannot_enter_the_windows_gnu_toolchain(self):
        with self.assertRaisesRegex(ValueError, "artifact ABI"):
            bazel_arguments(
                "x86_64-pc-windows-msvc",
                self.directory,
                self.directory / "repos",
                run=True,
            )
        with self.assertRaisesRegex(ValueError, "musl target"):
            prepare_musl_linker(self.target, self.directory)


if __name__ == "__main__":
    unittest.main()
