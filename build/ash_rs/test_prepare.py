"""Development package selection and publication contracts."""

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from build.ash_rs import prepare
from build.lib.targets import TARGETS


class PrepareTests(unittest.TestCase):
    def test_development_modes_and_remote_catalog_are_explicit(self) -> None:
        self.assertEqual(
            "host-provided-node", prepare.parse_arguments([]).javascript_runtime
        )
        options = prepare.parse_arguments(
            [
                "--javascript-runtime",
                "packaged-node",
                "--remote-runtime-catalog-url",
                "https://example.com/catalog.json",
                "--remote-runtime-catalog-sha256",
                "a" * 64,
            ]
        )
        self.assertEqual("packaged-node", options.javascript_runtime)
        self.assertEqual(
            "https://example.com/catalog.json", options.remote_runtime_catalog_url
        )
        for url in (
            "http://example.com/catalog.json",
            "https://user@example.com/catalog.json",
            "https://example.com/catalog.json?token=1",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                prepare.validate_catalog_url(url)
        with self.assertRaises(SystemExit):
            prepare.parse_arguments(
                ["--remote-runtime-catalog-url", "https://example.com/catalog.json"]
            )

    def test_input_digest_changes_with_source_and_settings(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            (source / "file").write_text("first")
            original = prepare.package_input_digest(
                [source], {"runtime": "host-provided-node"}
            )
            self.assertEqual(
                original,
                prepare.package_input_digest(
                    [source, source], {"runtime": "host-provided-node"}
                ),
            )
            self.assertNotEqual(
                original,
                prepare.package_input_digest([source], {"runtime": "packaged-node"}),
            )
            (source / "file").write_text("second content")
            self.assertNotEqual(
                original,
                prepare.package_input_digest(
                    [source], {"runtime": "host-provided-node"}
                ),
            )

    def test_development_source_digest_tracks_packaged_backend_and_resource_changes(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for directory in (
                "ash-rs",
                "app-rs",
                "ash-cli",
                "code",
                "app-ts/src/ash/workbench",
                "build/code/update-sign",
                ".cargo",
                "extensions",
                "resources",
                "third_party",
            ):
                (root / directory).mkdir(parents=True)
            (root / "Cargo.lock").write_text("lock")
            (root / "rust-toolchain.toml").write_text("toolchain")
            backend = root / "ash-rs/server.rs"
            backend.write_text("first")
            editor_backend = root / "app-rs/editor.rs"
            editor_backend.write_text("first")
            cli_source = root / "ash-cli/cli.rs"
            cli_source.write_text("first")
            code_backend = root / "code/mermaid.rs"
            code_backend.write_text("first")
            code_signer = root / "build/code/update-sign/sign.py"
            code_signer.write_text("first")
            frontend = root / "app-ts/src/ash/workbench/view.ts"
            frontend.write_text("first")
            resource = root / "resources/icon.svg"
            resource.write_text("first")
            args = prepare.parse_arguments([])
            with patch.object(prepare, "package_sources", return_value=[]):
                original = prepare.development_source_digest(root, args, "target", {})
                frontend.write_text("second content")
                self.assertEqual(
                    original,
                    prepare.development_source_digest(root, args, "target", {}),
                )
                for unrelated in (editor_backend, code_backend, cli_source, code_signer):
                    unrelated.write_text("second content")
                    self.assertEqual(
                        original,
                        prepare.development_source_digest(root, args, "target", {}),
                    )
                backend.write_text("second content")
                after_backend = prepare.development_source_digest(
                    root, args, "target", {}
                )
                resource.write_text("second content")
                after_resource = prepare.development_source_digest(
                    root, args, "target", {}
                )
                (root / "Cargo.lock").write_text("updated lock")
                after_lock = prepare.development_source_digest(root, args, "target", {})
            self.assertNotEqual(original, after_backend)
            self.assertNotEqual(after_backend, after_resource)
            self.assertNotEqual(after_resource, after_lock)

    def test_development_source_digest_ignores_unrelated_git_commit_and_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for directory in (
                "ash-rs",
                "app-rs",
                "ash-cli",
                "code",
                "build/code/update-sign",
                ".cargo",
                "extensions",
                "resources",
                "third_party",
            ):
                (root / directory).mkdir(parents=True)
            (root / "Cargo.lock").write_text("lock")
            (root / "rust-toolchain.toml").write_text("toolchain")
            (root / ".git").mkdir()
            args = prepare.parse_arguments([])
            with (
                patch.object(prepare, "package_sources", return_value=[]),
                patch.object(prepare.shutil, "which", return_value="tool"),
            ):
                with (
                    patch.dict(prepare.os.environ, {"PATH": "first"}),
                    patch.object(
                        prepare.subprocess,
                        "run",
                        return_value=SimpleNamespace(returncode=0, stdout="a" * 40),
                    ),
                ):
                    first = prepare.development_source_digest(root, args, "target", {})
                with (
                    patch.dict(prepare.os.environ, {"PATH": "second"}),
                    patch.object(
                        prepare.subprocess,
                        "run",
                        return_value=SimpleNamespace(returncode=0, stdout="b" * 40),
                    ),
                ):
                    second = prepare.development_source_digest(root, args, "target", {})
            self.assertEqual(first, second)

    def test_reuse_requires_the_current_published_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store = Path(temporary)
            manifests = store / "manifests"
            manifests.mkdir()
            package = store / "packages/0.1.0" / ("a" * 64)
            package.mkdir(parents=True)
            (package / "ash-package.json").write_text("{}")
            (manifests / "00000000000000000001.json").write_text(
                json.dumps(
                    {
                        "formatVersion": 1,
                        "sequence": 1,
                        "directory": f"packages/0.1.0/{'a' * 64}",
                    }
                )
            )
            cache = store / "prepare-inputs.json"
            prepare.record_package_inputs(cache, "digest", "source", package)
            self.assertEqual(package, prepare.reusable_package(cache, "digest", store))
            self.assertEqual(
                package,
                prepare.reusable_package(
                    cache, "source", store, digest_key="sourceDigest"
                ),
            )
            self.assertIsNone(prepare.reusable_package(cache, "changed", store))
            self.assertIsNone(
                prepare.reusable_package(
                    cache, "changed", store, digest_key="sourceDigest"
                )
            )
            (manifests / "00000000000000000002.json").write_text(
                json.dumps(
                    {
                        "formatVersion": 1,
                        "sequence": 2,
                        "directory": f"packages/0.1.0/{'b' * 64}",
                    }
                )
            )
            self.assertIsNone(prepare.reusable_package(cache, "digest", store))
            (manifests / "00000000000000000002.json").write_text("[]")
            with self.assertRaisesRegex(
                RuntimeError, "Invalid Ash development package"
            ):
                prepare.current_package(store)

    def test_unchanged_development_sources_skip_cargo(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = root / "published"
            with (
                patch.object(
                    prepare, "default_target", return_value="x86_64-pc-windows-msvc"
                ),
                patch.object(prepare, "load_protocol_metadata", return_value={}),
                patch.object(
                    prepare, "development_source_digest", return_value="source"
                ),
                patch.object(
                    prepare, "reusable_package", return_value=package
                ) as reuse,
                patch.object(prepare, "build_binaries") as build,
            ):
                result = prepare.prepare_development_package(
                    prepare.parse_arguments([]), root=root
                )
            self.assertEqual(package, result)
            self.assertEqual("sourceDigest", reuse.call_args.kwargs["digest_key"])
            build.assert_not_called()

    def test_preparation_builds_one_backend_set_and_delegates_assembly(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binaries = {}
            for name in (
                "ash-package-store",
                "ash-app-server",
                "ash-remote",
                "ash-remote-server",
                "ash-exec-server",
                "ash-app-server-daemon",
                "ash-code-mode-host",
                "ash-voice-host",
                "ash-collaboration-server",
                "ash-windows-sandbox",
            ):
                path = root / name
                path.write_text(name)
                binaries[name] = path
            runtime = SimpleNamespace(
                executable=root / "rg",
                version="test",
                source="upstream-release",
                binary_sha256="a" * 64,
                archive="rg.zip",
                archive_sha256="b" * 64,
            )
            runtime.executable.write_text("rg")
            args = prepare.parse_arguments([])
            spec = TARGETS["x86_64-pc-windows-msvc"]
            with (
                patch.object(prepare, "default_target", return_value=spec.target),
                patch.object(
                    prepare, "development_source_digest", return_value="source"
                ),
                patch.object(
                    prepare,
                    "load_protocol_metadata",
                    return_value={
                        "major": 1,
                        "revision": 1,
                        "schemaHash": "sha256:" + "c" * 64,
                    },
                ),
                patch.object(prepare, "build_binaries", return_value=binaries) as build,
                patch.object(
                    prepare, "resolve_livekit", return_value=binaries["ash-app-server"]
                ),
                patch.object(prepare, "resolve_ripgrep", return_value=runtime),
                patch.object(prepare, "resolve_tgrep", return_value=runtime),
                patch.object(prepare, "package_input_digest", return_value="digest"),
                patch.object(prepare, "reusable_package", return_value=None),
                patch.object(
                    prepare, "publish_package", return_value=root / "published"
                ) as publish,
                patch.object(prepare, "record_package_inputs"),
            ):
                result = prepare.prepare_development_package(args, root=root)
            self.assertEqual(root / "published", result)
            self.assertEqual(1, build.call_count)
            self.assertEqual(set(binaries), set(build.call_args.args[2]))
            self.assertEqual(binaries["ash-package-store"], publish.call_args.args[1])
