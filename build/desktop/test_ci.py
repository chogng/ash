"""Electron CI build transfer through the real archive and runtime selection path."""

import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path

from build.desktop.ci import archive, backend_cache_key
from build.desktop.develop import build_development_server
from build.desktop.test_develop import prepared_package
from build.lib.targets import default_target
from build.prepare import current_package, development_root


class CiTests(unittest.TestCase):
    def test_backend_cache_restores_without_frontend_outputs_or_cargo(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "builder"
            root.mkdir()
            store = development_root(root, default_target(), "host-provided-node")
            relative = "packages/0.1.0/" + "a" * 64
            selected = store / relative
            selected.parent.mkdir(parents=True)
            shutil.move(prepared_package(root), selected)
            (store / "manifests").mkdir()
            (store / "manifests/00000000000000000001.json").write_text(
                json.dumps({"formatVersion": 1, "sequence": 1, "directory": relative})
            )
            output = Path(temporary) / "backend.tar.gz"
            archive(root, output, backend_only=True)
            with tarfile.open(output) as bundle:
                self.assertTrue(
                    all(
                        name.startswith(".build/runtime/") for name in bundle.getnames()
                    )
                )
            consumer = Path(temporary) / "consumer"
            consumer.mkdir()
            subprocess.run(
                ["tar", "-xzf", str(output), "-C", str(consumer)], check=True
            )
            shutil.rmtree(root)
            build_development_server(root=consumer, select_prepared=True)
            pointer = json.loads(
                (consumer / ".build/desktop/dev/app-server/current.json").read_text()
            )
            runtime = consumer / ".build/desktop/dev/app-server" / pointer["runtime"]
            self.assertEqual("old", (runtime / "bin/ash-app-server").read_text())
            self.assertFalse((consumer / ".build/cargo").exists())

    def test_archive_restores_only_current_outputs_and_rebases_runtime_resources(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "builder"
            if os.name == "nt":
                root = Path("\\\\?\\" + str(root))
            root.mkdir()
            for name in ("main", "preload", "renderer", "localization"):
                directory = root / ".build/desktop" / name
                directory.mkdir(parents=True)
                (directory / "output.js").write_text(name)
            (root / ".build/desktop/package.json").write_text('{"type":"module"}')
            for name in (
                ".build/protocol/metadata.json",
                ".build/protocol-sources.json",
                "src/ash/platform/extensions/common/generated/browser.json",
                "node_modules/native-keymap/build/Release/keymapping.node",
                ".build/cargo/should-not-transfer",
                ".build/desktop/playwright/should-not-transfer",
                "node_modules/should-not-transfer",
            ):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("{}")
            store = development_root(root, default_target(), "host-provided-node")
            (store / "manifests").mkdir(parents=True)
            package = prepared_package(root)
            package_relative = "packages/0.1.0/" + "a" * 64
            selected = store / package_relative
            selected.parent.mkdir(parents=True)
            shutil.move(package, selected)
            resource_relative = (
                Path("ash-resources")
                / ("long-resource-" * 8)
                / ("long-resource-" * 8)
                / "grammar.json"
            )
            long_resource = selected / resource_relative
            long_resource.parent.mkdir(parents=True)
            long_resource.write_text('{"grammar":"long path"}')
            (selected / "bin/ash-app-server").chmod(0o755)
            for sequence, directory in (
                (1, "packages/0.1.0/" + "b" * 64),
                (2, package_relative),
            ):
                (store / "manifests" / f"{sequence:020}.json").write_text(
                    json.dumps(
                        {
                            "formatVersion": 1,
                            "sequence": sequence,
                            "directory": directory,
                        }
                    )
                )
            (store / "prepare-inputs.json").write_text(str(root))
            build_development_server(root=root, select_prepared=True)

            output = Path(temporary) / "electron.tar.gz"
            archive(root, output)
            with tarfile.open(output) as bundle:
                names = bundle.getnames()
                self.assertFalse(
                    any(
                        "should-not-transfer" in name
                        or "prepare-inputs" in name
                        or "/dev/app-server" in name
                        for name in names
                    )
                )
                self.assertEqual(
                    1,
                    sum(
                        name.endswith(".json") and "/manifests/" in name
                        for name in names
                    ),
                )
                self.assertTrue(
                    all(
                        member.isfile() or member.isdir()
                        for member in bundle.getmembers()
                    )
                )

            consumer = Path(temporary) / "consumer"
            if os.name == "nt":
                consumer = Path("\\\\?\\" + str(consumer))
            consumer.mkdir()
            subprocess.run(
                ["tar", "-xzf", str(output), "-C", str(consumer)], check=True
            )
            shutil.rmtree(root)
            build_development_server(root=consumer, select_prepared=True)
            pointer = json.loads(
                (consumer / ".build/desktop/dev/app-server/current.json").read_text()
            )
            runtime = consumer / ".build/desktop/dev/app-server" / pointer["runtime"]
            identity = json.loads((runtime / "ash-development.json").read_text())
            restored_package = current_package(
                development_root(consumer, default_target(), "host-provided-node")
            )
            self.assertEqual(
                restored_package.resolve(), Path(identity["resources"]).resolve()
            )
            self.assertEqual("old", (runtime / "bin/ash-app-server").read_text())
            resource = runtime / "ash-resources/extensions/rust/package.json"
            self.assertEqual('{"name":"rust"}', resource.read_text())
            self.assertEqual(1, resource.stat().st_nlink)
            self.assertEqual(
                '{"grammar":"long path"}', (runtime / resource_relative).read_text()
            )
            self.assertEqual(
                "renderer", (consumer / ".build/desktop/renderer/output.js").read_text()
            )
            self.assertEqual(
                "{}",
                (consumer / ".build/ci/keymapping.node").read_text(),
            )
            if os.name != "nt":
                self.assertTrue((runtime / "bin/ash-app-server").stat().st_mode & 0o111)
            shutil.rmtree(consumer)

    def test_missing_outputs_fail_before_publishing_an_archive(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "electron.tar.gz"
            with self.assertRaises(FileNotFoundError):
                archive(root, output)
            self.assertFalse(output.exists())


class BackendCacheKeyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / "builder"
        self.environment = {"ImageOS": "test", "ImageVersion": "1"}
        sources = {
            ".gitignore": ".build/\nnode_modules/\n__pycache__/\n",
            "Cargo.toml": "workspace",
            "Cargo.lock": "lock",
            "rust-toolchain.toml": "toolchain",
            ".cargo/config.toml": "flags",
            "cli/Cargo.toml": "cli manifest",
            "crates/app-server/src/lib.rs": "backend",
            "resources/product-services/services.json": "services",
            "third_party/ripgrep/LICENSE-MIT": "license",
            "third_party/tgrep/lock.json": "download lock",
            "extensions/rust/package.json": "extension",
            "build/prepare.py": "prepare",
            "build/lib/package-layout.json": "layout",
            "build/protocol/generate.py": "export",
            "build/desktop/ci.py": "cache key",
            ".github/actions/setup-frontend/action.yml": "toolchain setup",
            ".github/workflows/frontend-tests.yml": "build command",
            ".nvmrc": "node version",
            "scripts/requirements.txt": "python tools",
            "src/frontend.ts": "frontend",
        }
        for name, content in sources.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        subprocess.run(["git", "init", "--quiet", str(self.root)], check=True)
        subprocess.run(
            ["git", "add", "."], cwd=self.root, check=True, capture_output=True
        )

    def test_frontend_edits_timestamps_outputs_and_checkout_paths_keep_the_cache_key(
        self,
    ):
        key = backend_cache_key(self.root, self.environment)
        (self.root / "src/frontend.ts").write_text("new frontend")
        os.utime(self.root / "crates/app-server/src/lib.rs", (1, 1))
        for name in (".build/cargo/output", "extensions/rust/node_modules/output"):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("generated")
        other = self.root.parent / "consumer"
        shutil.copytree(self.root, other)
        self.assertEqual(key, backend_cache_key(other, self.environment))

    def test_backend_sources_resources_locks_and_toolchains_invalidate_the_cache(self):
        key = backend_cache_key(self.root, self.environment)
        for name in (
            "crates/app-server/src/lib.rs",
            "resources/product-services/services.json",
            "third_party/ripgrep/LICENSE-MIT",
            "third_party/tgrep/lock.json",
            "extensions/rust/package.json",
            "Cargo.lock",
            "cli/Cargo.toml",
            "rust-toolchain.toml",
            ".cargo/config.toml",
            ".nvmrc",
            "build/lib/package-layout.json",
            "build/protocol/generate.py",
            ".github/actions/setup-frontend/action.yml",
            "scripts/requirements.txt",
        ):
            with self.subTest(source=name):
                path = self.root / name
                content = path.read_text()
                path.write_text(content + " changed")
                self.assertNotEqual(key, backend_cache_key(self.root, self.environment))
                path.write_text(content)
        source = self.root / "crates/app-server/src/lib.rs"
        renamed = source.with_name("renamed.rs")
        source.rename(renamed)
        subprocess.run(
            ["git", "add", "-A"], cwd=self.root, check=True, capture_output=True
        )
        renamed_key = backend_cache_key(self.root, self.environment)
        self.assertNotEqual(key, renamed_key)
        renamed.unlink()
        subprocess.run(
            ["git", "add", "-A"], cwd=self.root, check=True, capture_output=True
        )
        self.assertNotEqual(renamed_key, backend_cache_key(self.root, self.environment))

    def test_runner_images_and_compiler_flags_invalidate_and_missing_image_fails(self):
        key = backend_cache_key(self.root, self.environment)
        for changed in ({"ImageVersion": "2"}, {"RUSTFLAGS": "-C opt-level=1"}):
            self.assertNotEqual(
                key, backend_cache_key(self.root, self.environment | changed)
            )
        with self.assertRaisesRegex(ValueError, "ImageVersion"):
            backend_cache_key(self.root, {})
