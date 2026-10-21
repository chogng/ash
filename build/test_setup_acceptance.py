"""Exercise acceptance isolation and detection of stale generated inputs."""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from build import bun_acceptance
from build import setup_acceptance as setup


class SetupAcceptanceTests(unittest.TestCase):
    def test_acceptance_cannot_inherit_the_source_checkout_configuration_or_modules(
        self,
    ):
        self.assertFalse(
            setup.workspace_parent(setup.ROOT)
            .resolve()
            .is_relative_to(setup.ROOT.resolve())
        )

    def repository(self, root: Path) -> None:
        subprocess.run(
            ["git", "init", "--quiet"], cwd=root, check=True, capture_output=True
        )
        (root / ".gitignore").write_text(".build/\nnode_modules/\n")
        for name in setup.DEPENDENCIES:
            (root / name).write_text("original")
        contract = root / setup.CONTRACT
        contract.parent.mkdir(parents=True)
        contract.write_text(
            "    /// Changes only when repository identity, HEAD, refs or ref metadata changes.\n"
        )

    def test_snapshot_preserves_current_sources_without_copying_installed_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.repository(root)
            (root / "node_modules").mkdir()
            (root / "node_modules/binary").write_text("installed")
            subprocess.run(["git", "add", "--", "package.json"], cwd=root, check=True)
            (root / "package.json").write_text("unstaged change")
            files = setup.source_files(root)
            workspace = root / ".build/copy"
            setup.copy_sources(root, workspace, files)
            self.assertEqual(
                (workspace / "package.json").read_text(), "unstaged change"
            )
            self.assertTrue((workspace / setup.CONTRACT).is_file())
            self.assertFalse((workspace / "node_modules").exists())
            self.assertFalse((workspace / ".git").exists())
            with self.assertRaisesRegex(ValueError, "escapes acceptance workspace"):
                setup.copy_sources(root, workspace, {"../outside": "unused"})

    def test_source_switch_requires_matching_generated_protocol_and_input_digest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.repository(root)
            setup.source_revision(root, "A")
            generated = root / setup.GENERATED
            generated.parent.mkdir(parents=True)
            generated.write_text(f"{setup.MARKER} A.")
            inputs = root / ".build/protocol-inputs.json"
            inputs.write_text(json.dumps({"inputs": "before"}))
            self.assertEqual(setup.check_protocol(root, "A"), "before")
            setup.source_revision(root, "B")
            with self.assertRaisesRegex(
                RuntimeError, "did not generate protocol revision B"
            ):
                setup.check_protocol(root, "B")
            generated.write_text(f"{setup.MARKER} B.")
            inputs.write_text(json.dumps({"inputs": "after"}))
            self.assertEqual(setup.check_protocol(root, "B"), "after")

    def test_resume_updates_a_fix_without_resetting_the_source_switch_or_dependencies(
        self,
    ):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.repository(root)
            (root / "runner.ts").write_text("old runner")
            files = setup.source_files(root)
            workspace = root / ".build/copy"
            setup.copy_sources(root, workspace, files)
            setup.source_revision(workspace, "A")
            modules = workspace / "node_modules"
            modules.mkdir()
            (modules / "keep").write_text("same installation")
            (root / "runner.ts").write_text("fixed runner")
            setup.validate_resume(root, workspace, files)
            self.assertEqual((workspace / "runner.ts").read_text(), "fixed runner")
            self.assertIn(
                f"{setup.MARKER} A.", (workspace / setup.CONTRACT).read_text()
            )
            self.assertEqual((modules / "keep").read_text(), "same installation")
            (root / "pnpm-lock.yaml").write_text("changed dependency graph")
            with self.assertRaisesRegex(RuntimeError, "start a fresh acceptance run"):
                setup.validate_resume(root, workspace, files)

    def test_command_runs_in_the_selected_workspace_without_changing_parent_environment(
        self,
    ):
        import os
        import sys

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            previous = os.environ.get("ASH_SETUP_TEST")
            result = bun_acceptance.run(
                [
                    sys.executable,
                    "-c",
                    "import os; print(os.getcwd()); print(os.environ['ASH_SETUP_TEST'])",
                ],
                root,
                "environment",
                cwd=root,
                environment={"ASH_SETUP_TEST": "isolated"},
            )
            self.assertEqual(result["exitCode"], 0)
            output = (root / "environment.log").read_text().splitlines()
            self.assertEqual(len(output), 2)
            # Windows can return the short-name alias of the selected directory.
            # Verify filesystem identity, not a particular spelling of that path.
            self.assertTrue(Path(output[0]).samefile(root))
            self.assertEqual(output[1], "isolated")
            self.assertEqual(os.environ.get("ASH_SETUP_TEST"), previous)

    def test_windows_frontend_ci_requires_the_setup_lifecycle_and_retains_failure_logs(
        self,
    ):
        workflow = (setup.ROOT / ".github/workflows/frontend.yml").read_text()
        lifecycle = workflow.split("  windows-setup:\n", 1)[1].split(
            "\n  contracts:", 1
        )[0]
        self.assertIn("uses: ./.github/workflows/bun-benchmark.yml", lifecycle)
        self.assertIn("runner: windows-latest", lifecycle)
        self.assertIn("phase: setup", lifecycle)
        job = (setup.ROOT / ".github/workflows/bun-benchmark.yml").read_text()
        self.assertIn('python -B build/setup_acceptance.py --output "$OUTPUT"', job)
        self.assertIn("if: always()", job)
        self.assertNotIn("continue-on-error", lifecycle + job)


if __name__ == "__main__":
    unittest.main()
