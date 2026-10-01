"""Test runtime executable preparation for Cargo library tests."""

import json
import subprocess
import unittest
from unittest.mock import patch

from scripts.cargo import main, prepare_test_executable


class CodeModeHostTests(unittest.TestCase):
    def setUp(self) -> None:
        # Windows platform discovery invokes subprocess.run too; keep the Cargo
        # process mock isolated from host detection, which is tested separately.
        self.enterContext(
            patch("scripts.cargo.default_target", return_value="x86_64-pc-windows-msvc")
        )

    @patch.dict("scripts.cargo.os.environ", {}, clear=True)
    @patch("scripts.cargo.subprocess.run")
    @patch(
        "scripts.cargo.resolve_sherpa_cargo_env",
        return_value={"SHERPA_ONNX_LIB_DIR": "/locked/libs"},
    )
    @patch("scripts.cargo.cargo_command_uses_v8", return_value=False)
    @patch("scripts.cargo.cargo_command_uses_package")
    def test_speech_resources_are_prepared_only_for_the_selected_graph(
        self, uses_package, uses_v8, speech, run
    ) -> None:
        run.return_value = subprocess.CompletedProcess([], 0)
        uses_package.side_effect = lambda _cargo, _args, _root, package: (
            package == "sherpa-onnx-sys"
        )
        self.assertEqual(main(["check", "-p", "ash-tui"]), 0)
        self.assertEqual(
            run.call_args.kwargs["env"]["SHERPA_ONNX_LIB_DIR"], "/locked/libs"
        )
        speech.assert_called_once()
        speech.reset_mock()
        uses_package.side_effect = lambda *_args: False
        self.assertEqual(main(["check", "-p", "ash-build-info"]), 0)
        speech.assert_not_called()
        self.assertNotIn("SHERPA_ONNX_LIB_DIR", run.call_args.kwargs["env"])

    @patch.dict("scripts.cargo.os.environ", {}, clear=True)
    @patch("scripts.cargo.subprocess.run")
    @patch("scripts.cargo.prepare_test_executable", return_value="/runtime/app-server")
    @patch(
        "scripts.cargo.resolve_v8_cargo_env",
        return_value={"RUSTY_V8_ARCHIVE": "locked"},
    )
    @patch("scripts.cargo.cargo_command_uses_v8", return_value=True)
    @patch("scripts.cargo.cargo_command_uses_package")
    def test_remote_tests_prepare_the_shared_backend(
        self, uses_package, uses_v8, resolve_v8, prepare, run
    ) -> None:
        uses_package.side_effect = lambda _cargo, _args, _root, package: (
            package == "ash-remote-server"
        )
        run.return_value = subprocess.CompletedProcess([], 0)
        arguments = ["test", "-p", "ash-remote-server", "--test", "stdio"]
        self.assertEqual(main(arguments), 0)
        prepare.assert_called_once()
        self.assertEqual(prepare.call_args.args[:2], ("cargo", arguments))
        self.assertEqual(prepare.call_args.args[2]["RUSTY_V8_ARCHIVE"], "locked")
        self.assertEqual(prepare.call_args.args[3], "ash-app-server")
        self.assertEqual(
            run.call_args.kwargs["env"]["ASH_APP_SERVER_PATH"], "/runtime/app-server"
        )

    @patch("scripts.cargo.subprocess.run")
    @patch("scripts.cargo.prepare_test_executable")
    @patch("scripts.cargo.resolve_v8_cargo_env", return_value={})
    @patch("scripts.cargo.cargo_command_uses_v8", return_value=False)
    @patch("scripts.cargo.cargo_command_uses_package")
    def test_remote_compile_only_and_explicit_backend_do_not_prepare(
        self, uses_package, uses_v8, resolve_v8, prepare, run
    ) -> None:
        uses_package.side_effect = lambda _cargo, _args, _root, package: (
            package == "ash-remote-server"
        )
        run.return_value = subprocess.CompletedProcess([], 0)
        for environment, extra in [
            ({}, ["--no-run"]),
            ({"ASH_APP_SERVER_PATH": "/custom/backend"}, []),
        ]:
            with (
                self.subTest(extra=extra),
                patch.dict("scripts.cargo.os.environ", environment, clear=True),
            ):
                self.assertEqual(main(["test", "-p", "ash-remote-server", *extra]), 0)
                self.assertEqual(run.call_args.kwargs["env"], environment)
        prepare.assert_not_called()

    @patch("scripts.cargo.subprocess.run")
    def test_uses_reported_executable_with_the_test_build_settings(self, run) -> None:
        run.return_value = subprocess.CompletedProcess(
            [],
            0,
            json.dumps(
                {
                    "reason": "compiler-artifact",
                    "target": {"name": "ash-code-mode-host", "kind": ["bin"]},
                    "executable": "/custom/target/host",
                }
            ),
        )
        environment = {"RUSTFLAGS": "-D warnings"}
        executable = prepare_test_executable(
            "cargo",
            [
                "test",
                "-p",
                "ash-app-server",
                "--lib",
                "--target-dir=/custom/target",
                "--target",
                "aarch64-unknown-linux-gnu",
                "--profile",
                "ci-test",
                "--locked",
                "test_filter",
                "--",
                "--exact",
            ],
            environment,
            "ash-code-mode-host",
        )
        self.assertEqual(executable, "/custom/target/host")
        self.assertEqual(
            run.call_args.args[0],
            [
                "cargo",
                "build",
                "-p",
                "ash-code-mode-host",
                "--bin",
                "ash-code-mode-host",
                "--message-format=json",
                "--target-dir=/custom/target",
                "--target",
                "aarch64-unknown-linux-gnu",
                "--profile",
                "ci-test",
                "--locked",
            ],
        )
        self.assertIs(run.call_args.kwargs["env"], environment)

    @patch("scripts.cargo.subprocess.run")
    def test_forwards_all_cargo_jobs_argument_forms(self, run) -> None:
        run.return_value = subprocess.CompletedProcess(
            [],
            0,
            json.dumps(
                {
                    "reason": "compiler-artifact",
                    "target": {"name": "ash-code-mode-host", "kind": ["bin"]},
                    "executable": "/runtime/host",
                }
            ),
        )
        for options in (["-j1"], ["-j", "1"], ["--jobs=1"], ["--jobs", "1"]):
            with self.subTest(options=options):
                prepare_test_executable(
                    "cargo", ["test", *options, "--", "-j8"], {}, "ash-code-mode-host"
                )
                self.assertEqual(
                    run.call_args.args[0][7:], [*options, "--profile", "test"]
                )

    @patch("scripts.cargo.subprocess.run")
    def test_default_uses_test_profile_and_rejects_missing_artifacts(self, run) -> None:
        run.return_value = subprocess.CompletedProcess([], 0, "")
        with self.assertRaisesRegex(RuntimeError, "did not report"):
            prepare_test_executable(
                "cargo", ["test", "-p", "ash-app-server"], {}, "ash-code-mode-host"
            )
        self.assertEqual(run.call_args.args[0][-2:], ["--profile", "test"])

    @patch("scripts.cargo.subprocess.run")
    def test_host_build_failure_stops_preparation(self, run) -> None:
        run.return_value = subprocess.CompletedProcess(["cargo", "build"], 1, "")
        with self.assertRaises(subprocess.CalledProcessError):
            prepare_test_executable(
                "cargo", ["test", "--release"], {}, "ash-code-mode-host"
            )
        self.assertNotIn("--profile", run.call_args.args[0])

    @patch.dict("scripts.cargo.os.environ", {}, clear=True)
    @patch("scripts.cargo.subprocess.run")
    @patch("scripts.cargo.prepare_test_executable", return_value="/runtime/host")
    @patch(
        "scripts.cargo.resolve_v8_cargo_env",
        return_value={"RUSTY_V8_ARCHIVE": "locked"},
    )
    @patch("scripts.cargo.cargo_command_uses_v8", return_value=False)
    @patch("scripts.cargo.cargo_command_uses_package")
    def test_library_tests_prepare_the_separate_host_with_locked_v8(
        self, uses_package, uses_v8, resolve_v8, prepare, run
    ) -> None:
        uses_package.side_effect = lambda _cargo, _args, _root, package: (
            package == "ash-code-mode"
        )
        run.return_value = subprocess.CompletedProcess([], 0)
        arguments = ["test", "-p", "ash-app-server", "--lib"]
        self.assertEqual(main(arguments), 0)
        resolve_v8.assert_called_once()
        uses_v8.assert_not_called()
        self.assertEqual(prepare.call_args.args[1], arguments)
        self.assertEqual(prepare.call_args.args[2]["RUSTY_V8_ARCHIVE"], "locked")
        self.assertEqual(
            run.call_args.kwargs["env"]["ASH_CODE_MODE_HOST_BIN"], "/runtime/host"
        )

    @patch("scripts.cargo.subprocess.run")
    @patch("scripts.cargo.prepare_test_executable")
    @patch("scripts.cargo.resolve_v8_cargo_env")
    @patch("scripts.cargo.cargo_command_uses_v8", return_value=False)
    @patch("scripts.cargo.cargo_command_uses_package", return_value=False)
    def test_compile_only_and_explicit_host_do_not_prepare_a_host(
        self, uses_package, uses_v8, resolve_v8, prepare, run
    ) -> None:
        run.return_value = subprocess.CompletedProcess([], 0)
        for environment, extra in [
            ({}, ["--no-run"]),
            ({"ASH_CODE_MODE_HOST_BIN": "/custom/host"}, []),
        ]:
            with (
                self.subTest(extra=extra),
                patch.dict("scripts.cargo.os.environ", environment, clear=True),
            ):
                self.assertEqual(main(["test", "-p", "ash-app-server", *extra]), 0)
                self.assertEqual(run.call_args.kwargs["env"], environment)
        prepare.assert_not_called()
        resolve_v8.assert_not_called()


if __name__ == "__main__":
    unittest.main()
