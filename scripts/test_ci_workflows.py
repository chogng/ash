"""Test workflow selection, required-result handling, and reusable CI wiring."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import ci_workflows


ROOT = Path(__file__).resolve().parents[1]


class CiWorkflowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.policy = ci_workflows.load_policy(ci_workflows.POLICY)

    def results(self, selection: dict) -> dict:
        return {
            "select": {"result": "success"},
            **{
                name: {"result": "success" if selected else "skipped"}
                for name, selected in selection.items()
            },
        }

    def test_documentation_only_keeps_cheap_and_security_checks(self) -> None:
        selected = ci_workflows.select(["docs/example.md"], self.policy)
        self.assertEqual(
            {name for name, value in selected.items() if value},
            {
                "blob-size-policy",
                "cargo-deny",
                "codespell",
                "format",
            },
        )
        self.assertEqual(
            ci_workflows.require_results(self.results(selected), selected, self.policy),
            [],
        )

    def test_owned_sources_select_their_real_checks(self) -> None:
        cases = {
            "src/ash/editor/browser/view.ts": {"frontend"},
            "sdk/rust/src/lib.rs": {"bazel", "frontend"},
            "sdk/typescript/src/index.ts": {"bazel", "frontend"},
            "crates/tui/src/app.rs": {
                "bazel",
                "frontend",
                "rust-build-health",
                "rust-warnings",
            },
            "build/lib/package.py": {
                "bazel",
                "frontend",
                "rust-build-health",
                "rust-warnings",
                "tooling",
            },
            "crates/livekit-client/src/lib.rs": {
                "bazel",
                "frontend",
                "rust-build-health",
                "rust-warnings",
                "media",
            },
        }
        for path, required in cases.items():
            with self.subTest(path=path):
                selected = ci_workflows.select([path], self.policy)
                self.assertTrue(all(selected[name] for name in required))
        for path in (
            "cli/tests/snapshots/cli.snap",
            "crates/tui/src/snapshots/app.snap",
        ):
            with self.subTest(path=path):
                self.assertTrue(
                    ci_workflows.select([path], self.policy)["rust-warnings"]
                )

    def test_root_files_globs_and_control_changes(self) -> None:
        self.assertTrue(ci_workflows.matches("**/Cargo.toml", "Cargo.toml"))
        self.assertTrue(ci_workflows.matches("**/Cargo.toml", "crates/tui/Cargo.toml"))
        self.assertTrue(ci_workflows.matches("**/*.rs", "new.rs"))
        self.assertFalse(ci_workflows.matches("scripts/*.py", "scripts/nested/test.py"))
        self.assertTrue(
            ci_workflows.matches(
                "crates/app-server/src/server/call*",
                "crates/app-server/src/server/call.rs",
            )
        )
        for path in ci_workflows.CONTROL_PATHS:
            with self.subTest(path=path):
                self.assertTrue(all(ci_workflows.select([path], self.policy).values()))
        self.assertTrue(
            all(ci_workflows.select([], self.policy, force_all=True).values())
        )

    def test_failures_cancellation_and_unexpected_skips_block_required(self) -> None:
        selected = ci_workflows.select(["docs/example.md"], self.policy)
        for name, active in {"select": True, **selected}.items():
            states = (
                ("failure", "cancelled", "skipped", None)
                if active
                else ("failure", "cancelled", "success", None)
            )
            for state in states:
                with self.subTest(name=name, state=state):
                    needs = self.results(selected)
                    needs[name]["result"] = state
                    self.assertTrue(
                        ci_workflows.require_results(needs, selected, self.policy)
                    )

    def test_missing_jobs_malformed_results_and_forged_exclusions_fail(self) -> None:
        selected = ci_workflows.select([], self.policy)
        needs = self.results(selected)
        for bad_selection in (
            {},
            {**selected, "format": "true"},
            {**selected, "unknown": True},
        ):
            with self.subTest(selection=bad_selection), self.assertRaises(ValueError):
                ci_workflows.require_results(needs, bad_selection, self.policy)
        for bad_needs in ({}, {**needs, "unknown": {"result": "success"}}):
            with self.subTest(needs=bad_needs), self.assertRaises(ValueError):
                ci_workflows.require_results(bad_needs, selected, self.policy)
        selected["format"] = False
        needs["format"]["result"] = "skipped"
        self.assertTrue(ci_workflows.require_results(needs, selected, self.policy))

    def test_parent_calls_and_fan_in_cover_exactly_the_policy(self) -> None:
        workflow = (ROOT / ".github/workflows/blocking-ci.yml").read_text()
        calls = set(re.findall(r"uses: \./\.github/workflows/([a-z-]+)\.yml", workflow))
        self.assertEqual(calls, set(self.policy))
        required = workflow.split("\n  required:\n", 1)[1]
        self.assertIn("if: ${{ always() }}", required)
        self.assertEqual(
            set(re.findall(r"^      - ([a-z-]+)$", required, re.MULTILINE)),
            {"select", *self.policy},
        )
        for name in self.policy:
            child = (ROOT / f".github/workflows/{name}.yml").read_text()
            triggers = child.split("\non:\n", 1)[1].split("\npermissions:", 1)[0]
            self.assertIn("  workflow_call:", triggers, name)
            self.assertIn("  workflow_dispatch:", triggers, name)
            self.assertNotRegex(triggers, r"(?m)^  (push|pull_request):", name)
            if self.policy[name] is not None:
                self.assertIn(f".github/workflows/{name}.yml", self.policy[name])

    def test_cli_selection_and_failure_exit_codes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "github-output"
            with (
                patch("ci_workflows.changed_paths", return_value=["docs/example.md"]),
                patch.dict(
                    os.environ,
                    {"GITHUB_OUTPUT": str(output)},
                ),
            ):
                self.assertEqual(ci_workflows.main(["select"]), 0)
            selected = json.loads(output.read_text().removeprefix("selection="))
        environment = {
            **os.environ,
            "NEEDS_JSON": json.dumps(self.results(selected)),
            "CI_SELECTION_JSON": json.dumps(selected),
        }
        command = [
            sys.executable,
            "-B",
            str(ROOT / "scripts/ci_workflows.py"),
            "require",
        ]
        self.assertEqual(
            subprocess.run(command, env=environment, capture_output=True).returncode, 0
        )
        needs = self.results(selected)
        needs["cargo-deny"]["result"] = "failure"
        environment["NEEDS_JSON"] = json.dumps(needs)
        self.assertEqual(
            subprocess.run(command, env=environment, capture_output=True).returncode, 1
        )
        environment["CI_SELECTION_JSON"] = ""
        self.assertEqual(
            subprocess.run(command, env=environment, capture_output=True).returncode, 1
        )

    def test_unix_lifecycle_runs_in_the_required_rust_workflow(self) -> None:
        for path in (
            "cli/tests/stdio.rs",
            "cli/tests/support/ssh.rs",
            "crates/app-server-client/src/session_stdio.rs",
            "crates/remote-connections/src/ssh.rs",
            ".github/workflows/rust-warnings.yml",
        ):
            with self.subTest(path=path):
                self.assertTrue(
                    ci_workflows.select([path], self.policy)["rust-warnings"]
                )
        workflow = (ROOT / ".github/workflows/rust-warnings.yml").read_text()
        lifecycle = workflow.split("\n  stdio-lifecycle:\n", 1)[1].split(
            "\n  tui:\n", 1
        )[0]
        self.assertIn("runner: [ubuntu-24.04, macos-15]", lifecycle)
        self.assertNotRegex(lifecycle, r"(?m)^    if:")
        self.assertNotIn("continue-on-error", lifecycle)
        self.assertNotIn("--skip", lifecycle)
        self.assertIn("TARGETS[default_target()]", lifecycle)
        self.assertIn('root / "third_party/ripgrep/runtime-lock.json"', lifecycle)
        self.assertIn("ASH_RG_PATH={ripgrep}", lifecycle)
        self.assertIn("-p ash-cli --test stdio --profile ci-test --locked", lifecycle)
        self.assertIn("-p ash-app-server-client -p ash-remote-connections", lifecycle)
        self.assertIn("--lib --profile ci-test --locked", lifecycle)
        stdio_run = lifecycle.split(
            "- name: Test real stdio, reconnect and OpenSSH process cleanup", 1
        )[1].split("- name:", 1)[0]
        library_run = lifecycle.split(
            "- name: Test client EOF cleanup and SSH compatibility rejection", 1
        )[1]
        self.assertNotIn("--no-run", stdio_run)
        self.assertNotIn("--no-run", library_run)
        for package, executable in (
            ("ash-cli", "ash"),
            ("ash-app-server", "ash-app-server"),
            ("ash-remote-server", "ash-remote-server"),
            ("ash-js-extension-host", "ash-js-extension-host"),
        ):
            self.assertIn(f"-p {package} --bin {executable}", lifecycle)


if __name__ == "__main__":
    unittest.main()
