import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from build.app.build import build_package
from build.app.build import main as build_app_package
from build.app.build import remote_runtime_network_release
from build.app.build import resolve_binary
from build.remote.bundle import build_remote_runtime_bundle
from build.remote.test_bundle import create_package


class AppPackageTests(unittest.TestCase):
    def test_build_entry_point_uses_the_package_target_on_windows(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / "source-binary"
            binary.write_bytes(b"windows-app")
            package = root / "package"
            self.assertEqual(
                0,
                build_app_package(
                    [
                        "--app-bin",
                        str(binary),
                        "--windows-sandbox-bin",
                        str(binary),
                        "--package-dir",
                        str(package),
                        "--target",
                        "x86_64-pc-windows-msvc",
                    ]
                ),
            )

            metadata = json.loads((package / "app-package.json").read_text())
            self.assertEqual("x86_64-pc-windows-msvc", metadata["target"])
            self.assertEqual("bin/app.exe", metadata["binary"]["path"])
            for name in ("LICENSE-APACHE", "NOTICE"):
                self.assertEqual(
                    (
                        Path(__file__).resolve().parents[2] / "ash-rs" / "uds" / name
                    ).read_bytes(),
                    (package / "licenses" / "uds" / name).read_bytes(),
                )
            self.assertNotIn("mxcUserRuntime", metadata)
            self.assertFalse((package / "bin/mxc-user.exe").exists())
            self.assertEqual(
                (
                    Path(__file__).resolve().parents[2] / "ash-rs/vendor/mxc/LICENSE.md"
                ).read_bytes(),
                (package / "licenses/mxc/LICENSE.md").read_bytes(),
            )
            self.assertEqual("unsigned", metadata["signing"]["status"])

    def test_source_build_uses_locked_v8_inputs_for_selected_target(self) -> None:
        executable = "/custom/cargo-output/release/app"
        cargo_output = json.dumps(
            {
                "reason": "compiler-artifact",
                "target": {"kind": ["bin"], "name": "app"},
                "executable": executable,
            }
        )
        completed = CompletedProcess(["cargo"], 0, cargo_output + "\n", "")
        environment = {
            "RUSTY_V8_ARCHIVE": "/archive",
            "RUSTY_V8_SRC_BINDING_PATH": "/binding",
        }
        with (
            patch(
                "build.app.build.cargo_environment", return_value=environment
            ) as cargo_environment,
            patch("build.app.build.subprocess.run", return_value=completed) as run,
        ):
            resolved = resolve_binary(
                "cargo",
                "release",
                "aarch64-apple-darwin",
                None,
                None,
                None,
            )

        command = run.call_args.args[0]
        self.assertEqual(command[command.index("--target") + 1], "aarch64-apple-darwin")
        self.assertIn("--target-dir", command)
        self.assertEqual(environment, run.call_args.kwargs["env"])
        self.assertEqual(
            "aarch64-apple-darwin", cargo_environment.call_args.args[0].target
        )
        self.assertEqual(Path(executable), resolved)

    def test_stages_binary_digest_and_unsigned_state(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / "app"
            binary.write_bytes(b"app-test-binary")
            binary.chmod(0o755)
            output = root / "package"

            build_package(output, binary, "aarch64-apple-darwin", "release")

            staged = output / "bin" / "app"
            metadata = json.loads((output / "app-package.json").read_text())
            self.assertEqual(binary.read_bytes(), staged.read_bytes())
            self.assertTrue((output / "app-signing-policy.json").is_file())
            self.assertTrue(os.access(staged, os.X_OK))
            self.assertEqual("unsigned", metadata["signing"]["status"])
            self.assertTrue(metadata["signing"]["requiredForRelease"])
            self.assertEqual("bin/app", metadata["binary"]["path"])
            self.assertEqual(64, len(metadata["binary"]["sha256"]))

    def test_windows_target_uses_the_windows_executable_name(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / "source-binary"
            binary.write_bytes(b"windows-app-test-binary")
            output = root / "package"

            build_package(
                output,
                binary,
                "x86_64-pc-windows-msvc",
                "release",
                windows_sandbox_binary=binary,
            )

            metadata = json.loads((output / "app-package.json").read_text())
            self.assertEqual("bin/app.exe", metadata["binary"]["path"])
            self.assertEqual(
                binary.read_bytes(), (output / "bin" / "app.exe").read_bytes()
            )

    def test_rejects_an_unknown_target_before_staging(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / "app"
            binary.write_bytes(b"app-test-binary")

            with self.assertRaisesRegex(RuntimeError, "Unsupported Ash target"):
                build_package(
                    root / "package",
                    binary,
                    "riscv64-unknown-linux-gnu",
                    "release",
                )

    def test_refuses_to_replace_existing_output(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / "app"
            binary.write_bytes(b"app-test-binary")
            output = root / "package"
            output.mkdir()

            with self.assertRaisesRegex(RuntimeError, "refusing to replace"):
                build_package(output, binary, "aarch64-apple-darwin", "release")

    def test_stages_a_catalog_bound_remote_runtime_bundle(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / "app"
            binary.write_bytes(b"app-test-binary")
            binary.chmod(0o755)
            bundle = build_remote_runtime_bundle(
                root / "remote-runtimes", [create_package(root / "runtime-package")]
            )
            binary.write_bytes(b"app-test-binary:" + bundle.catalog_sha256.encode())
            output = root / "package"

            build_package(
                output,
                binary,
                "aarch64-apple-darwin",
                "release",
                bundle,
            )

            metadata = json.loads((output / "app-package.json").read_text())
            binding = metadata["remoteRuntimeCatalog"]
            self.assertEqual(bundle.catalog_sha256, binding["sha256"])
            self.assertEqual("compiledIntoSignedBinary", binding["trustBinding"])
            self.assertTrue((output / binding["path"]).is_file())

    def test_rejects_a_remote_bundle_not_bound_into_the_binary(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / "app"
            binary.write_bytes(b"app-test-binary")
            binary.chmod(0o755)
            bundle = build_remote_runtime_bundle(
                root / "remote-runtimes", [create_package(root / "runtime-package")]
            )

            with self.assertRaisesRegex(RuntimeError, "does not contain"):
                build_package(
                    root / "package",
                    binary,
                    "aarch64-apple-darwin",
                    "release",
                    bundle,
                )

    def test_stages_a_network_catalog_bound_into_the_binary(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            release = remote_runtime_network_release(
                "https://releases.example/ash/catalog.json", "a" * 64
            )
            binary = root / "app"
            binary.write_bytes(
                b"app-test-binary:"
                + release.catalog_sha256.encode()
                + b":"
                + release.url.encode()
            )
            binary.chmod(0o755)
            output = root / "package"

            build_package(
                output,
                binary,
                "aarch64-apple-darwin",
                "release",
                remote_runtime_release=release,
            )

            metadata = json.loads((output / "app-package.json").read_text())
            self.assertEqual(
                {
                    "url": release.url,
                    "sha256": release.catalog_sha256,
                    "trustBinding": "compiledIntoSignedBinary",
                },
                metadata["remoteRuntimeCatalog"],
            )
            self.assertFalse((output / "ash-remote-runtimes").exists())

    def test_rejects_an_invalid_network_catalog_release(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "credential-free HTTPS"):
            remote_runtime_network_release(
                "https://user@releases.example/ash/catalog.json", "a" * 64
            )


if __name__ == "__main__":
    unittest.main()
