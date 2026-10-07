"""Protocol watch inputs follow Cargo's selected export dependency graph."""

import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from build.protocol.generate import protocol_source_directories


class ProtocolWatchInputTests(unittest.TestCase):
    def test_path_contracts_and_macros_are_included_without_registry_or_git_sources(
        self,
    ):
        with tempfile.TemporaryDirectory(prefix="ash (protocol) ") as temporary:
            root = Path(temporary).resolve()
            protocol = root / "crates/app-server-protocol"
            contract = root / "crates/queue-contract"
            macros = root / "crates/app-server-protocol-noop-macros"
            tree = "\n".join(
                [
                    f"ash-app-server-protocol v0.1.0 ({protocol})",
                    f"ash-queue-contract v0.1.0 ({contract})",
                    f"ash-queue-contract v0.1.0 ({contract}) (*)",
                    f"noop v0.1.0 ({macros}) (proc-macro)",
                    f"noop v0.1.0 ({macros}) (proc-macro) (*)",
                    "serde v1.0.0",
                    "serde_derive v1.0.0 (proc-macro)",
                    "matcher v0.3.0 (https://example.com/matcher#1234)",
                ]
            )
            with patch(
                "build.protocol.generate.subprocess.check_output", return_value=tree
            ) as cargo:
                self.assertEqual(
                    sorted(map(str, [protocol, contract, macros])),
                    protocol_source_directories(root=root),
                )
            arguments = cargo.call_args.args[0]
            self.assertEqual(root, cargo.call_args.kwargs["cwd"])
            self.assertIn("--locked", arguments)
            self.assertEqual("export", arguments[arguments.index("--features") + 1])
            self.assertEqual("normal,build", arguments[arguments.index("--edges") + 1])

    def test_an_invalid_dependency_graph_stops_discovery(self):
        error = subprocess.CalledProcessError(101, ["cargo", "tree"])
        with patch(
            "build.protocol.generate.subprocess.check_output", side_effect=error
        ):
            with self.assertRaises(subprocess.CalledProcessError):
                protocol_source_directories()


class ProtocolPreparationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="ash protocol cache ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.protocol = self.root / "crates/app-server-protocol"
        self.contract = self.root / "crates/queue-contract"
        for directory in [self.protocol, self.contract]:
            (directory / "src").mkdir(parents=True)
            (directory / "Cargo.toml").write_text("[package]\n")
            (directory / "src/lib.rs").write_text("contract")
        for name in ["Cargo.toml", "Cargo.lock"]:
            (self.root / name).write_text("workspace")
        self.tree = patch(
            "build.protocol.generate.protocol_source_directories",
            return_value=[str(self.protocol), str(self.contract)],
        )
        self.discovery = self.tree.start()
        self.addCleanup(self.tree.stop)
        self.run = patch(
            "build.protocol.generate.subprocess.run", side_effect=self.export
        )
        self.exporter = self.run.start()
        self.addCleanup(self.run.stop)

    def export(self, command, **options):
        output = Path(command[-1])
        contents = {
            "metadata.json": '{"major":1,"schemaHash":"sha256:' + "a" * 64 + '"}',
            "json/schema.json": "{}",
            "typescript/index.ts": "export type Contract = string;",
            "typescript/protocol.ts": "export const APP_SERVER_PROTOCOL_MAJOR = 1;",
        }
        for name, value in contents.items():
            path = output / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(value)
        return subprocess.CompletedProcess(command, 0)

    def prepare(self):
        from build.protocol.generate import generate_protocol

        generate_protocol(root=self.root)

    def test_cold_preparation_and_cache_hits_do_not_write_source_or_run_cargo(self):
        self.prepare()
        output = self.root / ".build/protocol/typescript/index.ts"
        modified = output.stat().st_mtime_ns
        self.prepare()
        self.discovery.assert_called_once()
        self.exporter.assert_called_once()
        self.assertEqual(output.stat().st_mtime_ns, modified)
        self.assertFalse((self.protocol / "schema").exists())
        self.assertIn("--locked", self.exporter.call_args.args[0])

    def test_transitive_changes_added_sources_and_tampered_or_missing_outputs_refresh_the_contract(
        self,
    ):
        self.prepare()
        changes = [
            lambda: (self.contract / "src/lib.rs").write_text("changed"),
            lambda: (self.contract / "src/new.rs").write_text("new contract"),
            lambda: (self.root / ".build/protocol/typescript/index.ts").write_text(
                "tampered"
            ),
            lambda: (self.root / ".build/protocol/json/schema.json").unlink(),
        ]
        for change in changes:
            with self.subTest(change=change):
                self.exporter.reset_mock()
                change()
                self.prepare()
                self.exporter.assert_called_once()
        self.discovery.assert_called_once()
        (self.contract / "Cargo.toml").write_text("[package]\nversion='2'\n")
        self.prepare()
        self.assertEqual(self.discovery.call_count, 2)

    def test_failed_or_partial_exports_preserve_the_previous_complete_contract_and_retry(
        self,
    ):
        self.prepare()
        output = self.root / ".build/protocol/typescript/index.ts"
        cache = self.root / ".build/protocol-inputs.json"
        original = cache.read_bytes()
        (self.contract / "src/lib.rs").write_text("changed")
        self.exporter.side_effect = subprocess.CalledProcessError(101, ["cargo"])
        with self.assertRaises(subprocess.CalledProcessError):
            self.prepare()
        self.assertEqual(cache.read_bytes(), original)
        self.assertEqual(output.read_text(), "export type Contract = string;")
        self.exporter.side_effect = lambda *args, **kwargs: None
        with self.assertRaisesRegex(RuntimeError, "complete contract"):
            self.prepare()
        self.assertEqual(cache.read_bytes(), original)
        self.exporter.side_effect = self.export
        self.prepare()
        self.assertNotEqual(cache.read_bytes(), original)

    def test_concurrent_consumers_share_one_export(self):
        from concurrent.futures import ThreadPoolExecutor

        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(lambda _: self.prepare(), range(2)))
        self.exporter.assert_called_once()

    def test_saves_during_export_cannot_publish_a_stale_cache(self):
        def changing_export(command, **options):
            self.export(command, **options)
            (self.contract / "src/new.rs").write_text("saved during export")

        self.exporter.side_effect = changing_export
        with self.assertRaisesRegex(RuntimeError, "changed during export"):
            self.prepare()
        self.assertFalse((self.root / ".build/protocol-inputs.json").exists())
        self.assertFalse((self.root / ".build/protocol/metadata.json").exists())
