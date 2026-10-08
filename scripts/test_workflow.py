"""Exercise workflow selection, failures, and scoped snapshot acceptance."""

import contextlib
import io
import os
from pathlib import Path
import subprocess
import shutil
import tempfile
import unittest
from unittest.mock import patch

import workflow


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="ash workflow ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.write("Cargo.toml", '[workspace]\nmembers = ["crates/tui", "crates/*"]\n')
        self.write("crates/tui/Cargo.toml", '[package]\nname = "ash-tui"\n')
        self.write("crates/example/Cargo.toml", '[package]\nname = "example"\n')
        self.write("crates/tui/src/lib.rs", "")
        self.write("crates/example/src/lib.rs", "")
        self.write("AGENTS.md", "Repository instructions\n")
        self.write(".github/copilot-instructions.md", "Ownership rules\n")
        self.write(
            ".github/instructions/testing.md", '---\napplyTo: "**"\n---\nTesting\n'
        )
        self.write(
            ".github/instructions/rust.md",
            '---\napplyTo: "**/*.rs,Cargo.toml"\n---\nRust\n',
        )
        self.write(
            ".github/instructions/tui.md",
            '---\napplyTo: "crates/tui/**"\n---\n[test-tui](../../.agents/skills/test-tui/SKILL.md)\n',
        )
        self.write(
            ".github/instructions/frontend.md",
            '---\napplyTo: "**/src/**/*.ts"\n---\nFrontend\n',
        )
        self.write(".agents/skills/test-tui/SKILL.md", "Skill\n")
        self.write(
            ".github/instructions/unscoped.md", "Reference without an applyTo pattern\n"
        )
        self.source = "crates/tui/src/composer_tests.rs"
        self.write(
            self.source,
            """// fn wrong() { crate::tui_assert_snapshot!("composer_focused", value); }
/* nested /* fn another() {} */ comment */
#[test]
fn input_keeps_its_bottom_rule() {
    let fixture = r##"fn wrong() { tui_assert_snapshot!(\"composer_focused\", value); }"##;
    crate::tui_assert_snapshot!(app = &app; "composer_focused", rendered);
}
""",
        )
        self.baseline = "crates/tui/snapshots/fullscreen/composer/composer_focused.snap"
        self.write(
            self.baseline,
            f"---\nsource: {self.source}\nexpression: text(&buffer)\n---\nold frame\n",
        )
        self.qualified = "app::fullscreen::composer::tests::input_keeps_its_bottom_rule"
        self.commands = []
        self.environments = []
        self.output = io.StringIO()
        self.errors = io.StringIO()

    def write(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def execute(self, arguments, callback=None):
        def external(command, **kwargs):
            self.assertEqual(kwargs["cwd"], self.root)
            self.commands.append(command)
            self.environments.append(kwargs.get("env"))
            if callback:
                return callback(command, kwargs)
            stdout = (
                f"{self.qualified}: test\n"
                if "--list" in command
                else "test result: ok. 1 passed; 0 failed; 0 ignored;\n"
            )
            return subprocess.CompletedProcess(command, 0, stdout, "")

        with (
            contextlib.redirect_stdout(self.output),
            contextlib.redirect_stderr(self.errors),
            patch("workflow.subprocess.run", side_effect=external),
        ):
            return workflow.main(arguments, self.root)

    def test_context_reads_matching_rules_for_snapshot_and_source(self):
        self.assertEqual(self.execute(["context", self.baseline]), 0)
        output = self.output.getvalue()
        # CLI paths use platform separators; snapshot metadata uses forward slashes.
        for expected in (
            "Cargo package: ash-tui",
            str(Path(self.source)),
            "AGENTS.md",
            "testing.md",
            "rust.md",
            "tui.md",
            str(Path(".agents/skills/test-tui/SKILL.md")),
        ):
            self.assertIn(expected, output)
        self.assertNotIn("frontend.md", output)
        self.assertEqual(self.commands, [])

    def test_glob_segments_include_root_files_without_crossing_slashes(self):
        self.assertTrue(workflow.glob_matches("Cargo.toml", "**/Cargo.toml"))
        self.assertTrue(workflow.glob_matches("crates/tui/src/lib.rs", "**/*.rs"))
        self.assertFalse(workflow.glob_matches("crates/tui/src/lib.rs", "code/*.rs"))
        self.assertEqual(
            set(workflow.scope_patterns("**/*.{rs,snap},justfile")),
            {"**/*.rs", "**/*.snap", "justfile"},
        )

    def test_verify_keeps_settings_across_steps_and_filters_only_tests(self):
        self.assertEqual(
            self.execute(
                [
                    "verify",
                    "example",
                    "--filter",
                    "request_",
                    "--features",
                    "one,two",
                    "--profile",
                    "dev-small",
                ]
            ),
            0,
        )
        self.assertEqual(
            [command[1] for command in self.commands],
            ["check", "test", "rust-warnings"],
        )
        for command in self.commands:
            self.assertIn("example", command)
            self.assertEqual(command[command.index("--profile") + 1], "dev-small")
            self.assertEqual(command[command.index("--features") + 1], "one,two")
            self.assertNotIn("--workspace", command)
        self.assertIn("request_", self.commands[1])
        self.assertNotIn("request_", self.commands[0] + self.commands[2])

    def test_verify_stops_on_each_failure_and_preserves_exit_code(self):
        for step in ("check", "test", "rust-warnings"):
            with self.subTest(step=step):
                self.commands.clear()

                def external(command, kwargs):
                    return subprocess.CompletedProcess(
                        command,
                        23 if command[1] == step else 0,
                        "test result: ok. 1 passed;\n",
                        "",
                    )

                self.assertEqual(self.execute(["verify", "example"], external), 23)
                self.assertEqual(self.commands[-1][1], step)

    def test_verify_rejects_unknown_packages_and_zero_passed_tests(self):
        self.assertEqual(self.execute(["verify", "missing"]), 1)
        self.assertEqual(self.commands, [])
        self.assertEqual(
            self.execute(
                ["verify", "example", "--filter", "missing"],
                lambda command, kwargs: subprocess.CompletedProcess(
                    command, 0, "test result: ok. 0 passed; 0 failed;\n", ""
                ),
            ),
            1,
        )
        self.assertEqual(self.commands[-1][1], "test")

    def test_verify_runs_declared_consumer_tests_without_skipping_validation(self):
        self.write(
            "crates/example/Cargo.toml",
            '[package]\nname = "example"\n'
            '[package.metadata.ash.verify]\ntest-package = "ash-tui"\n',
        )
        self.assertEqual(self.execute(["verify", "example", "--filter", "request_"]), 0)
        self.assertEqual(
            [(command[1], command[2]) for command in self.commands],
            [("check", "example"), ("test", "ash-tui"), ("rust-warnings", "example")],
        )
        self.assertIn("request_", self.commands[1])
        self.commands.clear()
        self.assertEqual(
            self.execute(
                ["verify", "example"],
                lambda command, kwargs: subprocess.CompletedProcess(
                    command, 0, "test result: ok. 0 passed; 0 failed;\n", ""
                ),
            ),
            1,
        )
        self.assertEqual(self.commands[-1][1], "test")

    def test_verify_rejects_an_unknown_consumer_before_running_commands(self):
        self.write(
            "crates/example/Cargo.toml",
            '[package]\nname = "example"\n'
            '[package.metadata.ash.verify]\ntest-package = "missing"\n',
        )
        self.assertEqual(self.execute(["verify", "example"]), 1)
        self.assertEqual(self.commands, [])

    def test_snapshot_runs_actual_function_and_neutralizes_insta_settings(self):
        with patch.dict(
            os.environ, {"INSTA_UPDATE": "always", "INSTA_FORCE_PASS": "1"}
        ):
            self.assertEqual(self.execute(["snapshot", self.baseline]), 0)
        command = self.commands[-1]
        self.assertEqual(command[:3], ["just", "test-tui-unit", self.qualified])
        self.assertIn("--exact", command)
        self.assertEqual(self.environments[-1]["INSTA_UPDATE"], "new")
        self.assertNotIn("INSTA_FORCE_PASS", self.environments[-1])
        self.assertNotIn("INSTA_UPDATE", self.environments[0])

    def test_snapshot_rejects_missing_or_ambiguous_compiled_tests(self):
        for stdout in (
            "0 tests\n",
            f"one::{self.qualified}: test\ntwo::{self.qualified}: test\n",
        ):
            with self.subTest(stdout=stdout):
                self.commands.clear()
                self.assertEqual(
                    self.execute(
                        ["snapshot", self.baseline],
                        lambda command, kwargs: subprocess.CompletedProcess(
                            command, 0, stdout, ""
                        ),
                    ),
                    1,
                )
                self.assertEqual(len(self.commands), 1)

    def test_pending_snapshot_is_shown_without_accepting_or_overwriting(self):
        pending = self.write(
            self.baseline + ".new",
            (self.root / self.baseline).read_text().replace("old frame", "new frame"),
        )

        def external(command, kwargs):
            stdout = f"{self.qualified}: test\n" if "--list" in command else ""
            return subprocess.CompletedProcess(
                command, 101 if "--exact" in command else 0, stdout, ""
            )

        self.assertEqual(self.execute(["snapshot", self.baseline], external), 101)
        self.assertTrue(pending.exists())
        self.assertIn("old frame", (self.root / self.baseline).read_text())
        self.assertEqual(self.commands[-1][:3], ["cargo", "insta", "show"])
        self.assertNotIn("accept", sum(self.commands, []))

    def test_accept_only_one_file_then_rerun_without_update_settings(self):
        pending = self.write(
            self.baseline + ".new",
            (self.root / self.baseline).read_text().replace("old frame", "new frame"),
        )
        unrelated = self.write(
            "crates/tui/snapshots/shared/other.snap.new", "unrelated pending frame"
        )

        def external(command, kwargs):
            if "accept" in command:
                self.assertEqual(command[-1], self.baseline)
                pending.replace(self.root / self.baseline)
            stdout = (
                f"{self.qualified}: test\n"
                if "--list" in command
                else "test result: ok. 1 passed;\n"
            )
            return subprocess.CompletedProcess(command, 0, stdout, "")

        with patch.dict(os.environ, {"INSTA_UPDATE": "always"}):
            self.assertEqual(
                self.execute(
                    ["snapshot", self.baseline + ".new", "--accept"], external
                ),
                1,
            )
        self.assertTrue(unrelated.exists())
        self.assertIn("new frame", (self.root / self.baseline).read_text())
        self.assertNotIn("INSTA_UPDATE", self.environments[-1])
        self.assertEqual(self.commands[-1][1], "test-tui-unit")

    def test_accept_failure_prevents_rerun(self):
        self.write(self.baseline + ".new", (self.root / self.baseline).read_text())

        def external(command, kwargs):
            return subprocess.CompletedProcess(
                command,
                17 if "accept" in command else 0,
                f"{self.qualified}: test\n",
                "",
            )

        self.assertEqual(
            self.execute(["snapshot", self.baseline, "--accept"], external), 17
        )
        self.assertEqual(self.commands[-1][2], "accept")

    def inline_baseline(self):
        name = "crates/tui/snapshots/inline/composer/composer_focused.snap"
        self.write(name, (self.root / self.baseline).read_text())
        return name

    def test_batch_groups_modes_and_deduplicates_pending_and_absolute_paths(self):
        inline = self.inline_baseline()
        pending = self.write(inline + ".new", (self.root / inline).read_text())
        self.assertEqual(
            self.execute(
                ["snapshot", self.baseline, inline, str(pending), "--pending"]
            ),
            1,
        )
        self.assertEqual(sum("--list" in command for command in self.commands), 1)
        self.assertEqual(sum("--exact" in command for command in self.commands), 1)
        self.assertEqual(sum("show" in command for command in self.commands), 1)
        self.assertTrue(pending.exists())
        self.assertNotIn("accept", sum(self.commands, []))

    def test_batch_runs_remaining_tests_after_failure_and_shows_new_siblings(self):
        other_source = "crates/tui/src/other_tests.rs"
        self.write(
            other_source,
            'fn second_case() { tui_assert_snapshot!("second", value); }',
        )
        other = "crates/tui/snapshots/shared/second.snap"
        self.write(other, f"---\nsource: {other_source}\n---\nsecond frame\n")
        sibling = "crates/tui/snapshots/inline/composer/composer_focused.snap.new"

        def external(command, kwargs):
            if "--list" in command:
                stdout = f"{self.qualified}: test\nother::second_case: test\n"
                return subprocess.CompletedProcess(command, 0, stdout, "")
            if "--exact" in command and command[2] == self.qualified:
                self.write(sibling, (self.root / self.baseline).read_text())
                return subprocess.CompletedProcess(command, 101, "", "")
            return subprocess.CompletedProcess(
                command, 0, "test result: ok. 1 passed;\n", ""
            )

        self.assertEqual(
            self.execute(["snapshot", self.baseline, other], external), 101
        )
        tests = [command[2] for command in self.commands if "--exact" in command]
        self.assertEqual(tests, [self.qualified, "other::second_case"])
        self.assertEqual(self.commands[-1][-1], str(self.root / sibling))

    def test_pending_discovery_and_explicit_acceptance_are_separate(self):
        self.assertEqual(self.execute(["snapshot", "--pending"]), 0)
        self.assertEqual(self.commands, [])
        self.assertEqual(self.execute(["snapshot"]), 1)
        self.assertEqual(self.execute(["snapshot", "--pending", "--accept"]), 1)
        self.assertEqual(self.commands, [])
        pending = self.write(
            self.baseline + ".new", (self.root / self.baseline).read_text()
        )
        self.assertEqual(self.execute(["snapshot", "--pending"]), 1)
        self.assertEqual(sum("--exact" in command for command in self.commands), 1)
        self.assertTrue(pending.exists())

    def test_accept_prevalidates_all_files_and_compiled_tests_before_mutating(self):
        inline = self.inline_baseline()
        pending = self.write(
            self.baseline + ".new", (self.root / self.baseline).read_text()
        )
        self.assertEqual(
            self.execute(["snapshot", self.baseline, inline, "--accept"]), 1
        )
        self.assertEqual(self.commands, [])
        self.write(inline + ".new", (self.root / inline).read_text())
        self.assertEqual(
            self.execute(
                ["snapshot", self.baseline, inline, "--accept"],
                lambda command, kwargs: subprocess.CompletedProcess(
                    command, 0, "0 tests\n", ""
                ),
            ),
            1,
        )
        self.assertEqual(len(self.commands), 1)
        self.assertTrue(pending.exists())

    @unittest.skipUnless(
        shutil.which("cargo-insta"), "cargo-insta is required for snapshot review"
    )
    def test_real_insta_accepts_explicit_batch_and_preserves_unrelated(self):
        inline = self.inline_baseline()
        for baseline in (self.baseline, inline):
            self.write(
                baseline + ".new",
                (self.root / baseline).read_text().replace("old frame", "new frame"),
            )
        unrelated = self.write(
            "crates/tui/snapshots/shared/other.snap.new",
            (self.root / self.baseline).read_text(),
        )
        real_run = subprocess.run

        def external(command, kwargs):
            if command[0] == "cargo":
                return real_run(
                    command, cwd=self.root, capture_output=True, text=True, check=False
                )
            stdout = (
                f"{self.qualified}: test\n"
                if "--list" in command
                else "test result: ok. 1 passed;\n"
            )
            return subprocess.CompletedProcess(command, 0, stdout, "")

        self.assertEqual(
            self.execute(["snapshot", self.baseline, inline, "--accept"], external),
            1,
        )
        for baseline in (self.baseline, inline):
            self.assertFalse((self.root / (baseline + ".new")).exists())
            self.assertIn("new frame", (self.root / baseline).read_text())
        self.assertTrue(unrelated.exists())
        actions = [command[2] for command in self.commands if command[0] == "cargo"]
        self.assertEqual(actions, ["show", "show", "accept", "accept"])
        self.assertEqual(sum("--exact" in command for command in self.commands), 1)

    def test_frontend_instruction_routing_matches_actual_repository_paths(self):
        instruction_directory = workflow.ROOT / ".github/instructions"
        for extension in ("ts", "css"):
            target = f"src/ash/base/browser/ui/button/button.{extension}"
            rules = ["best-practices", "design-philosophy"]
            if extension == "css":
                rules.append("design-tokens")
            for rule in rules:
                with self.subTest(target=target, rule=rule):
                    header = workflow.frontmatter(
                        instruction_directory / f"{rule}.instructions.md"
                    )
                    self.assertTrue(
                        any(
                            workflow.glob_matches(target, pattern)
                            for pattern in workflow.scope_patterns(
                                workflow.field(header, "applyTo")
                            )
                        )
                    )

    def test_plans_do_not_execute_commands_and_outside_paths_are_rejected(self):
        self.assertEqual(self.execute(["snapshot", self.baseline, "--plan"]), 0)
        self.assertEqual(self.execute(["verify", "example", "--plan"]), 0)
        self.assertEqual(self.commands, [])
        self.assertEqual(self.execute(["context", "../outside.rs"]), 1)

    def test_dynamic_and_duplicate_snapshot_owners_require_manual_resolution(self):
        for source in (
            "fn render() { tui_assert_snapshot!(name, value); }",
            'fn one() { tui_assert_snapshot!("composer_focused", value); } fn two() { tui_assert_snapshot!("composer_focused", value); }',
        ):
            with self.subTest(source=source):
                with self.assertRaisesRegex(ValueError, "expected one function"):
                    workflow.snapshot_function(source, "composer_focused")


if __name__ == "__main__":
    unittest.main()
