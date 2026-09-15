"""Regression tests for the repository dependency gate."""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import dependencies


class DependencyTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "Cargo.toml").write_text('[workspace.dependencies]\nserde = "1"\n')

    def package(self, name, directory, manifest="", deps=()):
        path = self.root / directory / "Cargo.toml"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(manifest)
        return {
            "id": name,
            "name": name,
            "manifest_path": str(path),
            "dependencies": list(deps),
        }

    def metadata(self, *packages):
        return {
            "workspace_members": [p["id"] for p in packages],
            "packages": list(packages),
        }

    def test_all_dependency_sections_require_inheritance(self):
        for section in (
            "dependencies",
            "build-dependencies",
            "dev-dependencies",
            "target.'cfg(windows)'.dependencies",
        ):
            with self.subTest(section=section):
                p = self.package("test", "ash-rs/test", f'[{section}]\nserde = "1"\n')
                self.assertIn(
                    "must inherit",
                    dependencies.declaration_errors(self.root, self.metadata(p))[0],
                )

    def test_member_paths_are_allowed_but_vendored_sources_are_centralized(self):
        p = self.package(
            "a",
            "ash-rs/a",
            '[dependencies]\nb = { path = "../b" }\nforeign = { path = "../vendor/foreign" }\n',
        )
        b = self.package("b", "ash-rs/b")
        errors = dependencies.declaration_errors(self.root, self.metadata(p, b))
        self.assertEqual(len(errors), 1)
        self.assertIn("foreign", errors[0])

    def test_unmanaged_manifests_are_not_checked(self):
        p = self.package(
            "a",
            "ash-rs/a",
            '[dependencies]\nserde = { workspace = true, features = ["derive"] }\n',
        )
        vendor = self.package(
            "foreign", "vendor/foreign", '[dependencies]\nserde = "1"\n'
        )
        metadata = self.metadata(p)
        metadata["packages"].append(vendor)
        self.assertEqual(dependencies.declaration_errors(self.root, metadata), [])

    def test_inherited_source_overrides_are_rejected(self):
        p = self.package(
            "a",
            "ash-rs/a",
            '[dependencies]\nserde = { workspace = true, version = "2" }\n',
        )
        self.assertIn(
            "overrides", dependencies.declaration_errors(self.root, self.metadata(p))[0]
        )

    def test_workspace_wide_shear_suppression_is_rejected(self):
        (self.root / "Cargo.toml").write_text(
            '[workspace.metadata.cargo-shear]\nignored = ["serde"]\n'
        )
        errors = dependencies.declaration_errors(self.root, self.metadata())
        self.assertIn("owning package", errors[0])

    def test_git_revision_must_be_a_commit(self):
        (self.root / "Cargo.toml").write_text(
            '[workspace.dependencies]\nfoo = { git = "https://example.com/foo", rev = "main" }\n'
        )
        self.assertTrue(dependencies.declaration_errors(self.root, self.metadata()))

    def test_unused_third_party_path_is_not_a_workspace_catalog_entry(self):
        (self.root / "Cargo.toml").write_text(
            '[workspace.dependencies]\nfoo = { path = "vendor/foo" }\n'
        )
        report = {
            "findings": [
                {
                    "code": "shear/unused_workspace_dependency",
                    "file": "Cargo.toml",
                    "message": "unused workspace dependency `foo`",
                }
            ]
        }
        with (
            patch(
                "dependencies.subprocess.check_output",
                return_value=f"Version: {dependencies.SHEAR_VERSION}",
            ),
            patch(
                "dependencies.subprocess.run",
                return_value=subprocess.CompletedProcess([], 1, json.dumps(report), ""),
            ),
        ):
            self.assertTrue(dependencies.shear_errors("cargo-shear", self.root, set()))
            self.assertEqual(
                dependencies.shear_errors(
                    "cargo-shear", self.root, {(self.root / "vendor/foo").resolve()}
                ),
                [],
            )

    def test_indirect_boundary_includes_build_dependencies_and_aliases(self):
        app = self.package(
            "app", "app", deps=[{"name": "bridge", "kind": None, "rename": "helper"}]
        )
        bridge = self.package(
            "bridge", "ash-rs/bridge", deps=[{"name": "ash-tui", "kind": "build"}]
        )
        tui = self.package("ash-tui", "ash-code/tui")
        errors = dependencies.boundary_errors(
            self.root, self.metadata(app, bridge, tui)
        )
        self.assertIn("forbidden dependency path: app -> bridge -> ash-tui", errors)

    def test_dev_edges_do_not_become_product_edges(self):
        app = self.package("app", "app", deps=[{"name": "ash-tui", "kind": "dev"}])
        tui = self.package("ash-tui", "ash-code/tui")
        self.assertEqual(
            dependencies.boundary_errors(self.root, self.metadata(app, tui)), []
        )

    def test_core_contract_consumers_cannot_reach_execution_through_an_adapter(self):
        for name in ("ash-core-api", "ash-hooks"):
            for target in ("ash-core", "ash-app-server"):
                with self.subTest(consumer=name, target=target):
                    consumer = self.package(
                        name,
                        f"ash-rs/{name.removeprefix('ash-')}",
                        deps=[{"name": "adapter", "kind": None, "rename": "host"}],
                    )
                    adapter = self.package(
                        "adapter",
                        "ash-rs/adapter",
                        deps=[{"name": target, "kind": "build"}],
                    )
                    runtime = self.package(target, f"ash-rs/{target}")
                    self.assertIn(
                        f"forbidden dependency path: {name} -> adapter -> {target}",
                        dependencies.boundary_errors(
                            self.root, self.metadata(consumer, adapter, runtime)
                        ),
                    )

    def test_core_and_hooks_share_contracts_without_reverse_execution_dependency(self):
        api = self.package("ash-core-api", "ash-rs/core-api")
        core = self.package(
            "ash-core", "ash-rs/core", deps=[{"name": "ash-core-api", "kind": None}]
        )
        hooks = self.package(
            "ash-hooks", "ash-rs/hooks", deps=[{"name": "ash-core-api", "kind": None}]
        )
        self.assertEqual(
            dependencies.boundary_errors(self.root, self.metadata(api, core, hooks)), []
        )

    def test_daemon_cannot_reach_server_through_client(self):
        daemon = self.package(
            "ash-app-server-daemon",
            "ash-rs/app-server-daemon",
            deps=[{"name": "client", "kind": None}],
        )
        client = self.package(
            "client", "ash-rs/client", deps=[{"name": "ash-app-server", "kind": None}]
        )
        server = self.package("ash-app-server", "ash-rs/app-server")
        self.assertIn(
            "ash-app-server-daemon -> client -> ash-app-server",
            dependencies.boundary_errors(
                self.root, self.metadata(daemon, client, server)
            )[0],
        )

    def test_version_policy_rejects_growth_changes_and_stale_entries(self):
        policy = {
            "multiple_versions": [
                {
                    "name": "foo",
                    "versions": ["1", "2"],
                    "reason": "different upstream APIs",
                }
            ]
        }
        self.assertEqual(dependencies.version_errors({"foo": {"1", "2"}}, policy), [])
        for actual in (
            {"foo": {"1", "2", "3"}},
            {"foo": {"1", "3"}},
            {},
            {"bar": {"1", "2"}},
        ):
            self.assertTrue(dependencies.version_errors(actual, policy))

    def test_duplicate_identity_includes_source(self):
        lock = {
            "package": [
                {"name": "foo", "version": "1", "source": source}
                for source in (
                    "git+https://example.com/a#1",
                    "git+https://example.com/a#2",
                )
            ]
        }
        self.assertEqual(len(dependencies.duplicate_versions(lock)["foo"]), 2)

    def test_policy_requires_reasons_and_unique_entries(self):
        self.assertTrue(
            dependencies.version_errors(
                {},
                {
                    "multiple_versions": [
                        {"name": "foo", "versions": ["1", "1"], "reason": ""}
                    ]
                },
            )
        )

    def test_shear_fails_on_dependency_warnings_but_reports_file_notes(self):
        report = {
            "findings": [
                {"code": "shear/unlinked_files", "message": "orphan.rs"},
                {
                    "code": "shear/unused_dependency",
                    "file": "ash-rs/a/Cargo.toml",
                    "message": "unused optional dependency `serde`",
                },
            ]
        }
        result = subprocess.CompletedProcess([], 1, json.dumps(report), "")
        with (
            patch(
                "dependencies.subprocess.check_output",
                return_value=f"Version: {dependencies.SHEAR_VERSION}",
            ),
            patch("dependencies.subprocess.run", return_value=result),
        ):
            errors = dependencies.shear_errors("cargo-shear", self.root)
        self.assertEqual(
            errors, ["ash-rs/a/Cargo.toml: unused optional dependency `serde`"]
        )

    def test_shear_tool_failure_is_not_a_pass(self):
        with (
            patch(
                "dependencies.subprocess.check_output",
                return_value=f"Version: {dependencies.SHEAR_VERSION}",
            ),
            patch(
                "dependencies.subprocess.run",
                return_value=subprocess.CompletedProcess([], 2, "", "metadata failed"),
            ),
        ):
            self.assertIn(
                "metadata failed",
                dependencies.shear_errors("cargo-shear", self.root)[0],
            )


if __name__ == "__main__":
    unittest.main()
