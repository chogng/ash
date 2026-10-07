"""Exercise the repository shell and argument forwarding through Just."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import venv


ROOT = Path(__file__).resolve().parents[1]


class JustTests(unittest.TestCase):
    @unittest.skipIf(os.name == "nt", "The desktop shell launcher runs on Unix")
    def test_desktop_launch_modes_use_repository_commands_without_uv(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ash desktop launch ") as directory:
            folder = Path(directory)
            (folder / "scripts").mkdir()
            entry = folder / "scripts/ash.sh"
            entry.write_text((ROOT / "scripts/ash.sh").read_text())
            commands = folder / "bin"
            commands.mkdir()
            for command in ("just", "pnpm"):
                executable = commands / command
                executable.write_text(f"#!/bin/sh\nprintf '%s\\n' '{command}' \"$@\"\n")
                executable.chmod(0o755)
            for arguments, expected in [
                ([], ["just", "ash"]),
                (["--connected"], ["pnpm", "dev:ui:connected"]),
            ]:
                with self.subTest(arguments=arguments):
                    result = subprocess.run(
                        ["bash", str(entry), *arguments],
                        env={**os.environ, "PATH": str(commands) + ":/usr/bin:/bin"},
                        capture_output=True,
                        text=True,
                        check=False,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(result.stdout.splitlines(), expected)

    @unittest.skipIf(os.name == "nt", "The pnpm probe uses a Unix shell")
    def test_product_recipes_route_to_their_hosts_and_forward_terminal_arguments(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(prefix="ash product commands ") as directory:
            folder = Path(directory)
            (folder / "justfile").write_text((ROOT / "justfile").read_text())
            (folder / "build/code").mkdir(parents=True)
            (folder / "build/code/run.py").write_text(
                "import json, sys; print(json.dumps(sys.argv[1:]))"
            )
            commands = folder / "bin"
            commands.mkdir()
            pnpm = commands / "pnpm"
            pnpm.write_text('#!/bin/sh\nprintf "%s\\n" "pnpm" "$@"\n')
            pnpm.chmod(0o755)
            environment = {
                **os.environ,
                "PATH": str(commands) + os.pathsep + os.environ.get("PATH", ""),
            }
            for recipe, expected in [("ash", "dev"), ("build-ash", "build")]:
                with self.subTest(recipe=recipe):
                    result = subprocess.run(
                        ["just", "--justfile", str(folder / "justfile"), recipe],
                        env=environment,
                        capture_output=True,
                        text=True,
                        check=False,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(result.stdout.splitlines(), ["pnpm", expected])
            arguments = ["two words", "", "--flag", "$value", "a'b"]
            result = subprocess.run(
                [
                    "just",
                    "--justfile",
                    str(folder / "justfile"),
                    "--set",
                    "python",
                    sys.executable,
                    "ash-code",
                    *arguments,
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), arguments)

    def test_initialized_repository_python_is_used_without_changing_path(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ash python environment ") as directory:
            folder = Path(directory)
            environment = folder / "scripts/.venv"
            venv.EnvBuilder(with_pip=False, symlinks=os.name != "nt").create(
                environment
            )
            probe = folder / "probe.py"
            probe.write_text("import sys; print(sys.prefix)", encoding="utf-8")
            (folder / "justfile").write_text(
                (ROOT / "justfile").read_text(encoding="utf-8")
                + "\nprobe:\n    {{ python }} probe.py\n",
                encoding="utf-8",
            )
            result = subprocess.run(
                ["just", "--justfile", str(folder / "justfile"), "probe"],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                Path(result.stdout.strip()).resolve(), environment.resolve()
            )

    def run_tui_recipe(
        self, *args: str, build_exit: int = 0
    ) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory(prefix="ash tui recipe ") as directory:
            folder = Path(directory)
            (folder / "justfile").write_text(
                (ROOT / "justfile").read_text(encoding="utf-8"), encoding="utf-8"
            )
            (folder / "scripts").mkdir()
            (folder / "scripts" / "cargo.py").write_text(
                "import json, sys\n"
                "print(json.dumps(sys.argv[1:]), flush=True)\n"
                f"raise SystemExit({build_exit} if sys.argv[1] == 'build' else 0)\n",
                encoding="utf-8",
            )
            environment = os.environ.copy()
            environment["PATH"] = (
                str(Path(sys.executable).parent)
                + os.pathsep
                + environment.get("PATH", "")
            )
            return subprocess.run(
                ["just", "--justfile", str(folder / "justfile"), *args],
                capture_output=True,
                text=True,
                env=environment,
                check=False,
            )

    def test_tui_services_and_tests_use_the_same_profile(self) -> None:
        for settings, profile in [
            ([], "ci-test"),
            (["--set", "tui_profile", "test"], "test"),
        ]:
            with self.subTest(profile=profile):
                result = self.run_tui_recipe(
                    *settings, "test-tui", "actual_tui_", "--", "--test-threads=1"
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                build, test = [json.loads(line) for line in result.stdout.splitlines()]
                self.assertEqual(build[0], "build")
                self.assertEqual(build[-2:], ["--profile", profile])
                self.assertEqual(
                    test,
                    [
                        "test",
                        "-p",
                        "ash-cli",
                        "--test",
                        "tui_real_scenarios",
                        "--profile",
                        profile,
                        "actual_tui_",
                        "--",
                        "--test-threads=1",
                    ],
                )

    def test_tui_unit_filter_and_features_reach_the_library_test(self) -> None:
        result = self.run_tui_recipe(
            "test-tui-unit",
            "session_manager",
            "--features",
            "in-process-tests",
            "--",
            "--exact",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            [json.loads(line) for line in result.stdout.splitlines()],
            [
                [
                    "test",
                    "-p",
                    "ash-tui",
                    "--lib",
                    "--profile",
                    "ci-test",
                    "session_manager",
                    "--features",
                    "in-process-tests",
                    "--",
                    "--exact",
                ]
            ],
        )

    def test_process_test_recipe_preserves_target_and_harness_arguments(self) -> None:
        result = self.run_tui_recipe(
            "test-processes",
            "ash-app-server",
            "--test",
            "managed_lifecycle",
            "stop_",
            "--",
            "--exact",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                "--process-tests",
                "test",
                "-p",
                "ash-app-server",
                "--test",
                "managed_lifecycle",
                "stop_",
                "--",
                "--exact",
            ],
        )

    def test_tui_service_build_failure_stops_before_tests(self) -> None:
        result = self.run_tui_recipe("test-tui", build_exit=23)
        self.assertNotEqual(result.returncode, 0)
        commands = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(len(commands), 1)
        self.assertEqual(commands[0][0], "build")

    def test_workflow_recipes_forward_paths_and_options_literally(self) -> None:
        arguments = ["path with spaces/a'b.snap", "--features", "one,two", "--plan"]
        with tempfile.TemporaryDirectory(prefix="ash workflow recipes ") as directory:
            folder = Path(directory)
            (folder / "justfile").write_text(
                (ROOT / "justfile").read_text(), encoding="utf-8"
            )
            (folder / "scripts").mkdir()
            (folder / "scripts/workflow.py").write_text(
                "import json, sys; print(json.dumps(sys.argv[1:]))", encoding="utf-8"
            )
            environment = os.environ.copy()
            environment["PATH"] = (
                str(Path(sys.executable).parent)
                + os.pathsep
                + environment.get("PATH", "")
            )
            for recipe in ("snapshot", "context", "verify"):
                with self.subTest(recipe=recipe):
                    result = subprocess.run(
                        [
                            "just",
                            "--justfile",
                            str(folder / "justfile"),
                            recipe,
                            *arguments,
                        ],
                        capture_output=True,
                        text=True,
                        env=environment,
                        check=False,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(json.loads(result.stdout), [recipe, *arguments])

    def run_recipe(self, script: str, *args: str) -> subprocess.CompletedProcess[str]:
        environment = os.environ.copy()
        environment["PATH"] = (
            str(Path(sys.executable).parent) + os.pathsep + environment.get("PATH", "")
        )
        with tempfile.TemporaryDirectory(prefix="ash just ") as directory:
            folder = Path(directory)
            probe = folder / "probe.py"
            probe.write_text(script, encoding="utf-8")
            configuration = (ROOT / "justfile").read_text(encoding="utf-8")
            configuration = configuration.split("# Format Just", 1)[0]
            recipe = folder / "justfile"
            recipe.write_text(
                configuration
                + '\nprobe *args:\n    {{ python }} "'
                + probe.as_posix()
                + '" {{ recipe_args }}\n',
                encoding="utf-8",
            )
            return subprocess.run(
                [
                    "just",
                    "--justfile",
                    str(recipe),
                    "--working-directory",
                    str(ROOT),
                    "probe",
                    *args,
                ],
                capture_output=True,
                text=True,
                env=environment,
                check=False,
            )

    def test_arguments_keep_boundaries_and_literal_shell_characters(self) -> None:
        arguments = ["two words", "", "--flag", "a&b", "$value", "a'b", 'a"b']
        result = self.run_recipe(
            "import json, sys; print(json.dumps(sys.argv[1:]))", *arguments
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), arguments)

    def test_no_arguments_does_not_forward_recipe_name(self) -> None:
        result = self.run_recipe("import json, sys; print(json.dumps(sys.argv[1:]))")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [])

    def test_failed_command_fails_recipe(self) -> None:
        result = self.run_recipe("raise SystemExit(23)")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("recipe `probe` failed", result.stderr.lower())


if __name__ == "__main__":
    unittest.main()
