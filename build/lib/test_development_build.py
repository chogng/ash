"""Regressions for skipping complete Cargo feature groups."""

import json
import os
import subprocess
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from build.lib.development_build import DevelopmentBuildPlan
from build.lib import package_binaries
from build.lib.targets import TARGETS


class DevelopmentBuildTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        self.enterContext(
            patch.dict(
                os.environ,
                {
                    "CARGO_HOME": str(self.root / "cargo-home"),
                    "RUSTUP_HOME": str(self.root / "rustup-home"),
                },
            )
        )
        (self.root / "Cargo.toml").write_text('[workspace]\nmembers = ["crates/*"]\n')
        (self.root / "Cargo.lock").write_text("lock")
        self.directory = self.root / "plan"
        self.command = [
            "cargo",
            "build",
            "--target",
            "test-target",
            "--profile",
            "dev-small",
        ]
        self.messages = {}
        self.outputs = {}
        for name in ["first", "second"]:
            crate = self.root / "crates" / name
            (crate / "src").mkdir(parents=True)
            (crate / "src/lib.rs").write_text("pub fn value() -> u32 { 1 }\n")
            manifest = crate / "Cargo.toml"
            manifest.write_text(f'[package]\nname = "{name}"\nversion = "0.1.0"\n')
            output = self.root / "target" / (name + ".exe")
            output.parent.mkdir(exist_ok=True)
            output.write_bytes(b"artifact")
            output.with_suffix(".d").write_text(f"{output}: crates/{name}/src/lib.rs\n")
            self.outputs[name] = {name: output}
            self.messages[name] = [
                {
                    "reason": "compiler-artifact",
                    "manifest_path": str(manifest),
                    "package_id": name,
                    "filenames": [str(output)],
                    "fresh": True,
                }
            ]

    def plan(self):
        return DevelopmentBuildPlan(self.root, self.command, self.directory)

    def seed(self):
        # These fixtures represent inputs settled before a completed Cargo build.
        with patch(
            "build.lib.development_build.time.time_ns",
            return_value=time.time_ns() + 2_000_000_000,
        ):
            plan = self.plan()
        plan.packages = {"first", "second"}
        for name in self.outputs:
            plan.record([name], self.outputs[name], self.messages[name])
        plan.save()

    def test_no_change_reuses_graph_and_both_groups(self):
        self.seed()
        plan = self.plan()
        self.assertEqual({"first", "second"}, plan.packages)
        for name in self.outputs:
            self.assertEqual(self.outputs[name], plan.reuse([name]))

    def test_binary_builder_reuses_discovery_and_skips_unchanged_feature_groups(self):
        names = {"ash-app-server": "first", "ash-voice-host": "second"}
        calls = []

        def run(command, **kwargs):
            calls.append(command)
            messages = []
            for name, fixture in names.items():
                if name not in command:
                    continue
                artifact = self.messages[fixture][0].copy()
                artifact.update(
                    target={"name": name, "kind": ["bin"]},
                    executable=str(self.outputs[fixture][fixture]),
                )
                messages.append(json.dumps(artifact))
            return subprocess.CompletedProcess(command, 0, "\n".join(messages))

        def build():
            return package_binaries.build_binaries(
                self.root,
                TARGETS["x86_64-pc-windows-msvc"],
                dict.fromkeys(names),
                cargo="cargo",
                cargo_profile="dev-small",
                plan_directory=self.directory,
            )

        with (
            patch(
                "build.lib.development_build.time.time_ns",
                return_value=time.time_ns() + 2_000_000_000,
            ),
            patch.object(
                package_binaries, "cargo_command_packages", return_value=set(names)
            ) as query,
            patch.object(package_binaries, "cargo_environment", return_value={}),
            patch.object(package_binaries, "leased_cache"),
            patch.object(package_binaries.subprocess, "run", side_effect=run),
        ):
            expected = build()
            self.assertEqual(2, len(calls))
            self.assertEqual(expected, build())
            self.assertEqual(2, len(calls))
            query.assert_called_once()
            (self.root / "crates/first/src/lib.rs").write_text(
                "pub fn value() -> u32 { 2 }\n"
            )
            self.assertEqual(expected, build())
            self.assertEqual(3, len(calls))
            self.assertIn("ash-app-server", calls[-1])
            self.assertNotIn("ash-voice-host/host", calls[-1])
            (self.root / "crates/first/src/lib.rs").write_text("broken source")
            with patch.object(
                package_binaries.subprocess,
                "run",
                return_value=subprocess.CompletedProcess([], 101, ""),
            ):
                with self.assertRaises(subprocess.CalledProcessError):
                    build()
            self.assertFalse((self.directory / "build-plan.json").exists())

    def test_content_edit_with_preserved_timestamp_rebuilds_only_owner_group(self):
        self.seed()
        source = self.root / "crates/first/src/lib.rs"
        original = source.stat()
        source.write_text("pub fn value() -> u32 { 2 }\n")
        os.utime(source, ns=(original.st_atime_ns, original.st_mtime_ns))
        plan = self.plan()
        self.assertIsNone(plan.reuse(["first"]))
        self.assertEqual(self.outputs["second"], plan.reuse(["second"]))

    def test_new_and_deleted_source_members_invalidate_the_group(self):
        for deleted in [False, True]:
            with self.subTest(deleted=deleted):
                source = self.root / "crates/first/src/new.rs"
                source.write_text("mod new {}")
                if not deleted:
                    source.unlink()
                self.seed()
                if deleted:
                    source.unlink()
                else:
                    source.write_text("mod new {}")
                self.assertIsNone(self.plan().reuse(["first"]))

    def test_shared_extra_read_invalidates_both_groups(self):
        shared = self.root / "shared input.rs"
        shared.write_text("1")
        for name in self.outputs:
            output = self.outputs[name][name]
            output.with_suffix(".d").write_text(f"{output}: shared\\ input.rs\n")
        self.seed()
        shared.write_text("2")
        plan = self.plan()
        for name in self.outputs:
            self.assertIsNone(plan.reuse([name]))

    def test_configuration_changes_discard_cached_dependency_selection(self):
        for kind in ["lock", "config", "manifest", "target", "environment", "member"]:
            with self.subTest(kind=kind):
                self.seed()
                command = self.command.copy()
                if kind == "lock":
                    (self.root / "Cargo.lock").write_text("new lock")
                elif kind == "config":
                    (self.root / ".cargo").mkdir(exist_ok=True)
                    (self.root / ".cargo/config.toml").write_text("[build]\njobs = 4\n")
                elif kind == "manifest":
                    with (self.root / "crates/first/Cargo.toml").open("a") as stream:
                        stream.write("# changed\n")
                elif kind == "target":
                    command[command.index("test-target")] = "other-target"
                elif kind == "environment":
                    self.enterContext(
                        patch.dict(os.environ, {"RUSTFLAGS": "-Copt-level=1"})
                    )
                else:
                    member = self.root / "crates/new"
                    member.mkdir()
                    (member / "Cargo.toml").write_text('[package]\nname = "new"\n')
                self.assertIsNone(
                    DevelopmentBuildPlan(self.root, command, self.directory).packages
                )

    def test_missing_artifact_and_unsaved_failed_build_require_cargo(self):
        self.seed()
        plan = self.plan()
        self.outputs["first"]["first"].unlink()
        self.assertIsNone(plan.reuse(["first"]))
        self.assertIsNone(self.plan().packages)

    def test_build_script_directory_inputs_are_not_lost(self):
        extra = self.root / "extra"
        extra.mkdir()
        (extra / "input.rs").write_text("1")
        output = self.root / "target/build/first/output"
        output.parent.mkdir(parents=True)
        output.write_text("cargo:rerun-if-changed=../../extra\n")
        self.messages["first"].append(
            {
                "reason": "build-script-executed",
                "package_id": "first",
                "out_dir": str(output.parent / "out"),
            }
        )
        self.seed()
        (extra / "input.rs").write_text("2")
        self.assertIsNone(self.plan().reuse(["first"]))

    def test_corrupt_cache_is_a_miss(self):
        self.seed()
        path = self.directory / "build-plan.json"
        path.write_text("{unfinished")
        self.assertIsNone(self.plan().packages)

    def test_save_during_compilation_does_not_cache_post_save_inputs(self):
        plan = self.plan()
        plan.packages = {"first"}
        (self.root / "crates/first/src/lib.rs").write_text("new edit")
        plan.record(["first"], self.outputs["first"], self.messages["first"])
        plan.save()
        self.assertEqual(
            {}, json.loads((self.directory / "build-plan.json").read_text())["groups"]
        )
