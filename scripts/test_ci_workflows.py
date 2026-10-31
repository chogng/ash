"""Test workflow selection, required-result handling, and reusable CI wiring."""

from __future__ import annotations

import json
import io
from contextlib import redirect_stdout
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest.mock import patch

import ci_workflows


ROOT = Path(__file__).resolve().parents[1]


class CiWorkflowTests(unittest.TestCase):
    def test_real_windows_ssh_preflight_runs_before_the_full_backend_build(self):
        workflow = (ROOT / ".github/workflows/remote-server.yml").read_text()
        self.assertLess(
            workflow.index(
                "name: Verify large binary install and reuse over real Windows SSH"
            ),
            workflow.index("name: Build standalone Remote package"),
        )
        self.assertIn("build/release/verify_windows_installer.py --target", workflow)
        self.assertNotIn("continue-on-error", workflow)

    def test_remote_release_plans_native_windows_and_gates_the_client_binding(self):
        workflow = (ROOT / ".github/workflows/remote-server.yml").read_text()
        plan = textwrap.dedent(
            workflow.split("python3 - <<'PY'\n", 1)[1].split("\n          PY", 1)[0]
        )
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "output"
            environment = {
                **os.environ,
                "PLATFORMS": "windows",
                "MACOS_SIGNING_READY": "false",
                "GITHUB_OUTPUT": str(output),
            }
            subprocess.run([sys.executable, "-c", plan], env=environment, check=True)
            values = dict(
                line.split("=", 1) for line in output.read_text().splitlines()
            )
            self.assertEqual(
                json.loads(values["matrix"]),
                {
                    "include": [
                        {
                            "runner": "windows-2025",
                            "target": "x86_64-pc-windows-msvc",
                            "python": "python",
                        },
                        {
                            "runner": "windows-11-arm",
                            "target": "aarch64-pc-windows-msvc",
                            "python": "python",
                        },
                    ]
                },
            )
            self.assertEqual(
                set(json.loads(values["targets"])),
                {"x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"},
            )
            output.unlink()
            subprocess.run(
                [sys.executable, "-c", plan],
                env={**environment, "PLATFORMS": "all", "MACOS_SIGNING_READY": "true"},
                check=True,
            )
            values = dict(
                line.split("=", 1) for line in output.read_text().splitlines()
            )
            self.assertEqual(len(json.loads(values["targets"])), 6)
            output.unlink()
            subprocess.run(
                [sys.executable, "-c", plan],
                env={
                    **environment,
                    "PLATFORMS": "linux",
                },
                check=True,
            )
            values = dict(
                line.split("=", 1) for line in output.read_text().splitlines()
            )
            self.assertEqual(
                set(json.loads(values["targets"])),
                {"x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"},
            )
        verify = workflow.split("\n  verify:\n", 1)[1].split("\n  binding:\n", 1)[0]
        self.assertIn("needs: [plan, publish]", verify)
        self.assertIn("fromJSON(needs.plan.outputs.matrix)", verify)
        self.assertIn(
            "--binding-file .build/remote-release/remote-release.json", verify
        )
        self.assertNotIn("continue-on-error", verify)
        binding = workflow.split("\n  binding:\n", 1)[1]
        self.assertIn("needs: verify", binding)
        self.assertIn("name: remote-server-release-binding", binding)
        self.assertNotIn(
            "name: remote-server-release-binding",
            workflow.split("\n  binding:\n", 1)[0],
        )

    def test_component_fixture_sources_select_the_blocking_screenshot_workflow(
        self,
    ) -> None:
        for path in (
            "src/ash/base/browser/ui/selectbox/selectbox.css",
            "test/componentFixtures/blocks-ci-screenshots.md",
            "test/componentFixtures/component-explorer-diff.json",
            "build/lib/screenshotBlocksCi.ts",
            ".github/workflows/component-fixtures.yml",
        ):
            with self.subTest(path=path):
                self.assertTrue(
                    ci_workflows.select([path], self.policy)["component-fixtures"]
                )
        workflow = (ROOT / ".github/workflows/component-fixtures.yml").read_text()
        self.assertIn("pnpm test:component-fixtures:prepared", workflow)
        self.assertIn("pnpm test:component-fixtures:screenshots:prepared", workflow)
        self.assertIn("pnpm test:component-fixtures:compare:prepared", workflow)
        self.assertIn("node build/lib/screenshotBlocksCi.ts", workflow)
        self.assertIn("actions/upload-artifact@", workflow)
        self.assertNotIn("continue-on-error", workflow)
        self.assertNotIn("contents: write", workflow)

    def test_formatter_changes_select_their_behavior_test_owners(self) -> None:
        for path in (
            "build/format.ts",
            ".prettierignore",
            ".prettierrc.toml",
            "tsfmt.json",
            ".editorconfig",
            ".gitignore",
            ".vscode/settings.json",
            ".vscode/extensions.json",
            "package.json",
            "pnpm-lock.yaml",
            "pnpm-workspace.yaml",
        ):
            with self.subTest(path=path):
                selected = ci_workflows.select([path], self.policy)
                self.assertTrue(selected["frontend"])
        for path in (
            "scripts/format.py",
            "scripts/test_format.py",
            ".github/workflows/format.yml",
        ):
            with self.subTest(path=path):
                selected = ci_workflows.select([path], self.policy)
                self.assertTrue(selected["frontend"])
                if path.startswith("scripts/"):
                    self.assertTrue(selected["tooling"])

    def test_formatter_behavior_tests_do_not_block_the_source_format_gate(self) -> None:
        formatting = (ROOT / ".github/workflows/format.yml").read_text()
        self.assertNotIn("pnpm test:format", formatting)
        self.assertNotIn("test_format", formatting)
        frontend = (ROOT / ".github/workflows/frontend.yml").read_text()
        contracts = frontend.split("\n  contracts:\n")[1].split(
            "\n  desktop-runtime:\n"
        )[0]
        self.assertIn("test_format.ScopedFormattingTests", contracts)
        self.assertIn("pnpm install --frozen-lockfile", contracts)
        self.assertIn("scripts/install_python_tools.py", contracts)

    def test_just_version_and_setup_changes_select_all_consumers(self) -> None:
        policy = ci_workflows.load_policy(ci_workflows.POLICY)
        for name in (".just-version", ".github/actions/setup-just/action.yml"):
            with self.subTest(path=name):
                self.assertTrue(all(ci_workflows.select([name], policy).values()))

    def test_main_uses_the_last_successful_ancestor_instead_of_the_previous_push(
        self,
    ) -> None:
        base = "1" * 40
        response = io.BytesIO(
            json.dumps({"workflow_runs": [{"head_sha": base}]}).encode()
        )
        with (
            patch("ci_workflows.urlopen", return_value=response) as request,
            patch(
                "ci_workflows.subprocess.run",
                return_value=subprocess.CompletedProcess([], 0),
            ) as git,
        ):
            self.assertEqual(
                ci_workflows.successful_main_base(
                    ROOT, "HEAD", "chogng/ash", "test-token"
                ),
                base,
            )
        self.assertIn("status=success", request.call_args.args[0].full_url)
        git.assert_called_once_with(
            ["git", "merge-base", "--is-ancestor", base, "HEAD"], cwd=ROOT, check=False
        )

    def test_main_without_a_successful_ancestor_requires_every_check(self) -> None:
        for runs, status in (([], 0), ([{"head_sha": "1" * 40}], 1)):
            with (
                self.subTest(runs=runs),
                patch(
                    "ci_workflows.urlopen",
                    return_value=io.BytesIO(
                        json.dumps({"workflow_runs": runs}).encode()
                    ),
                ),
                patch(
                    "ci_workflows.subprocess.run",
                    return_value=subprocess.CompletedProcess([], status),
                ),
            ):
                self.assertIsNone(
                    ci_workflows.successful_main_base(
                        ROOT, "HEAD", "chogng/ash", "test-token"
                    )
                )

    def test_main_rejects_invalid_api_commit_data(self) -> None:
        with patch(
            "ci_workflows.urlopen",
            return_value=io.BytesIO(b'{"workflow_runs":[{"head_sha":"--all"}]}'),
        ):
            with self.assertRaises(ValueError):
                ci_workflows.successful_main_base(
                    ROOT, "HEAD", "chogng/ash", "test-token"
                )

    def test_no_main_baseline_forces_all_workflows_even_for_a_narrow_diff(self) -> None:
        output = io.StringIO()
        with (
            patch("ci_workflows.successful_main_base", return_value=None),
            patch("ci_workflows.changed_paths", return_value=["docs/example.md"]),
            patch.dict(
                os.environ,
                {"GITHUB_REPOSITORY": "chogng/ash", "GITHUB_TOKEN": "test-token"},
            ),
            redirect_stdout(output),
        ):
            self.assertEqual(
                ci_workflows.main(["select", "--since-successful-main"]), 0
            )
        self.assertTrue(all(json.loads(output.getvalue()).values()))

    def test_windows_desktop_release_prepares_the_locked_python_environment(
        self,
    ) -> None:
        workflow = (ROOT / ".github/workflows/release-windows.yml").read_text()
        steps = re.split(r"\n      - ", workflow)[1:]
        setup = next(
            index for index, step in enumerate(steps) if "actions/setup-python@" in step
        )
        uv = next(
            index for index, step in enumerate(steps) if "astral-sh/setup-uv@" in step
        )
        sync = next(
            index
            for index, step in enumerate(steps)
            if "scripts/install_python_tools.py" in step
        )
        install = next(
            index
            for index, step in enumerate(steps)
            if "pnpm install --frozen-lockfile" in step
        )
        bundle = next(
            index
            for index, step in enumerate(steps)
            if "pnpm package:win32:bundle" in step
        )
        self.assertLess(setup, uv)
        self.assertLess(uv, sync)
        self.assertLess(sync, install)
        self.assertLess(install, bundle)
        for index in (setup, uv, sync):
            self.assertIn("if: matrix.target == 'x86_64-pc-windows-msvc'", steps[index])
        self.assertIn('python-version: "3.11"', steps[setup])
        self.assertIn("version-file: scripts/pyproject.toml", steps[uv])

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

    def test_v8_backport_changes_require_source_builds_even_without_a_version_bump(
        self,
    ) -> None:
        for path in (
            "third_party/v8/patches/v8_array_sort_elements_kind.patch",
            "third_party/v8/patches/future_security_backport.patch",
            "third_party/v8/source-lock.json",
            "third_party/v8/runtime-lock.json",
            "crates/v8-runtime/src/lib.rs",
            "crates/v8-poc/src/array_sort_regression.js",
            "build/v8/release.py",
            ".github/workflows/v8-security.yml",
        ):
            with self.subTest(path=path):
                selected = ci_workflows.select([path], self.policy)
                self.assertTrue(selected["v8-security"])
                needs = self.results(selected)
                needs["v8-security"]["result"] = "skipped"
                self.assertTrue(
                    ci_workflows.require_results(needs, selected, self.policy)
                )
        self.assertFalse(
            ci_workflows.select(["crates/tui/src/app.rs"], self.policy)["v8-security"]
        )

    def test_v8_security_executes_new_source_pairs_without_publishing(self) -> None:
        workflow = (ROOT / ".github/workflows/v8-security.yml").read_text()
        consumers, sources = workflow.split("\n  sources:\n", 1)
        self.assertIn("runner: [ubuntu-24.04, windows-latest, macos-15]", consumers)
        self.assertIn("just verify ash-v8-runtime", consumers)
        self.assertIn("just verify ash-v8-poc --features sandbox", consumers)
        self.assertIn("target: x86_64-unknown-linux-gnu", sources)
        self.assertIn("target: x86_64-pc-windows-msvc", sources)
        self.assertIn("build/v8/release.py bazel-stage", sources)
        self.assertIn("build/v8/release.py upstream-toolchain", sources)
        self.assertIn("git -C upstream-rusty-v8/v8 apply -p3", sources)
        self.assertIn('V8_FROM_SOURCE: "1"', sources)
        self.assertIn("--features v8_enable_sandbox", sources)
        self.assertIn("RUSTY_V8_ARCHIVE: ${{ steps.stage.outputs.archive }}", sources)
        self.assertIn(
            'just test ash-v8-poc --locked --target "$TARGET" --features sandbox',
            sources,
        )
        self.assertIn('just test ash-v8-runtime --locked --target "$TARGET"', sources)
        self.assertIn("build/v8/smoke.py bazel", sources)
        self.assertNotIn("continue-on-error", workflow)
        self.assertNotIn("--no-run", workflow)
        self.assertNotIn("--skip", workflow)
        self.assertNotIn("contents: write", workflow)
        self.assertNotIn("gh release", workflow)

    def test_owned_sources_select_their_real_checks(self) -> None:
        cases = {
            "resources/extension-host/ash.js": {
                "bazel",
                "frontend",
                "rust-warnings",
                "tooling",
            },
            "src/ash/editor/browser/view.ts": {"frontend"},
            "third_party/node/runtime-lock.json": {"frontend", "tooling"},
            "sdk/rust/src/lib.rs": {"bazel", "frontend"},
            "sdk/typescript/package.json": {"bazel", "frontend"},
            "sdk/typescript/index.js": {"bazel", "frontend"},
            "sdk/typescript/index.d.ts": {"bazel", "frontend"},
            "examples/extensions/inspect/extension.ts": {"bazel", "frontend"},
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

    def test_frontend_runs_the_typescript_sdk_author_contract(self) -> None:
        frontend = (ROOT / ".github/workflows/frontend.yml").read_text()
        contracts = frontend.split("\n  contracts:\n")[1].split(
            "\n  desktop-runtime:\n"
        )[0]
        self.assertIn("pnpm --dir build run test:prepared", contracts)
        build = json.loads((ROOT / "build/package.json").read_text())
        self.assertEqual(
            build["scripts"]["test:prepared"], 'node --test "**/*.test.ts"'
        )
        self.assertTrue((ROOT / "build/builtin/typescriptSdk.test.ts").is_file())

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
        calls = set(
            re.findall(r"uses: \./\.github/workflows/([a-z][a-z0-9-]*)\.yml", workflow)
        )
        self.assertEqual(calls, set(self.policy))
        required = workflow.split("\n  required:\n", 1)[1]
        self.assertIn("if: ${{ always() }}", required)
        self.assertEqual(
            set(re.findall(r"^      - ([a-z][a-z0-9-]*)$", required, re.MULTILINE)),
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

    def test_expensive_jobs_wait_for_the_cheap_gates(self) -> None:
        workflow = (ROOT / ".github/workflows/blocking-ci.yml").read_text()
        for name, patterns in self.policy.items():
            if patterns is None:
                continue
            job = re.split(
                r"\n  [a-z][a-z0-9-]*:\n",
                workflow.split(f"\n  {name}:\n", 1)[1],
                maxsplit=1,
            )[0]
            needs = re.search(r"needs: \[([^\]]+)\]", job)
            self.assertIsNotNone(needs, name)
            self.assertEqual(
                {value.strip() for value in needs.group(1).split(",")},
                {"select", "blob-size-policy", "cargo-deny", "codespell", "format"},
                name,
            )
            # Default success gating prevents a rejected source from starting
            # builds; the fan-in still rejects every selected skipped job.
            self.assertNotIn("always()", job, name)

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

    def test_optional_v8_extension_host_has_separate_manual_validation(self) -> None:
        required = (ROOT / ".github/workflows/rust-warnings.yml").read_text()
        self.assertIn(
            "--workspace --exclude ash-external-js-ext --all-targets", required
        )
        optional = (ROOT / ".github/workflows/external-js-ext.yml").read_text()
        self.assertIn("workflow_dispatch:", optional)
        self.assertNotIn("workflow_call:", optional)
        self.assertIn("runner: [macos-15, windows-latest]", optional)
        self.assertIn("just rust-warnings ash-external-js-ext", optional)
        self.assertIn(
            "just test ash-external-js-ext --bin ash-external-js-ext", optional
        )
        self.assertIn("just test-processes ash-external-js-ext --test host", optional)

    def test_unix_lifecycle_runs_in_the_required_rust_workflow(self) -> None:
        for path in (
            "cli/tests/stdio.rs",
            "cli/tests/support/ssh.rs",
            "crates/app-server-client/src/session_stdio.rs",
            "crates/app-server-client-tests/src/session_tests.rs",
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
        self.assertIn(
            "-p ash-app-server-client-tests --lib --profile ci-test --locked", lifecycle
        )
        self.assertIn("--lib --profile ci-test --locked", lifecycle)
        stdio_run = lifecycle.split(
            "- name: Test real stdio, reconnect and OpenSSH process cleanup", 1
        )[1].split("- name:", 1)[0]
        library_run = lifecycle.split(
            "- name: Test client EOF cleanup and SSH compatibility rejection", 1
        )[1]
        self.assertNotIn("--no-run", stdio_run)
        self.assertNotIn("--no-run", library_run)
        self.assertNotIn("ash-external-js-ext", lifecycle)
        for package, executable in (
            ("ash-cli", "ash"),
            ("ash-app-server", "ash-app-server"),
            ("ash-remote-server", "ash-remote-server"),
        ):
            self.assertIn(f"-p {package} --bin {executable}", lifecycle)


if __name__ == "__main__":
    unittest.main()
