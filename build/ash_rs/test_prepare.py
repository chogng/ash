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
            prepare.record_package_inputs(cache, "digest", package)
            self.assertEqual(package, prepare.reusable_package(cache, "digest", store))
            self.assertIsNone(prepare.reusable_package(cache, "changed", store))
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
