"""Test runtime executable preparation for Cargo library tests."""

import json
from pathlib import Path
import subprocess
import unittest
from contextlib import nullcontext
from unittest.mock import patch

from scripts.cargo import main, prepare_test_executable, run_process_tests


class CodeModeHostTests(unittest.TestCase):
    def setUp(self) -> None:
        protocol = patch("scripts.cargo.generate_protocol")
        self.protocol = protocol.start()
        self.addCleanup(protocol.stop)
        cache = patch(
            "scripts.cargo.leased_cache",
            side_effect=lambda _root, **_options: nullcontext(),
        )
        cache.start()
        self.addCleanup(cache.stop)
        # These tests replace subprocess.run, including platform.py's Windows
        # version probe. Keep host detection outside the mocked process boundary.
        target = patch(
            "scripts.cargo.default_target", return_value="x86_64-pc-windows-msvc"
        )
        target.start()
        self.addCleanup(target.stop)

    @patch.dict("scripts.cargo.os.environ", {}, clear=True)
    @patch(
        "scripts.cargo.resolve_v8_cargo_env", return_value={"RUSTY_V8_ARCHIVE": "v8"}
    )
    @patch(
        "scripts.cargo.resolve_sherpa_cargo_env",
        return_value={"SHERPA_ONNX_LIB_DIR": "speech"},
    )
    @patch("scripts.cargo.subprocess.run")
    def test_one_graph_query_prepares_all_selected_inputs(self, run, speech, v8):
        run.side_effect = [
            subprocess.CompletedProcess(
                [],
                0,
                "app v1\nash-app-server-protocol v1\nv8 v152.2.0\nsherpa-onnx-sys v1\n",
            ),
            subprocess.CompletedProcess([], 0),
        ]
        self.assertEqual(main(["check", "-p", "app"]), 0)
        self.assertEqual(2, run.call_count)
        query, compile = run.call_args_list
        self.assertEqual(["cargo", "tree"], query.args[0][:2])
        self.assertEqual(["cargo", "check", "-p", "app"], compile.args[0])
        self.assertEqual(
            {"RUSTY_V8_ARCHIVE": "v8", "SHERPA_ONNX_LIB_DIR": "speech"},
            compile.kwargs["env"],
        )
        self.protocol.assert_called_once()
        v8.assert_called_once()
        speech.assert_called_once()

    @patch.dict("scripts.cargo.os.environ", {}, clear=True)
    @patch("scripts.cargo.cargo_command_packages", return_value={"v8"})
    @patch("scripts.cargo.subprocess.run")
    @patch("build.lib.v8.load_v8_lock", side_effect=AssertionError)
    def test_explicit_v8_inputs_reach_cargo_without_default_pair_preparation(
        self, lock, run, packages
    ):
        run.return_value = subprocess.CompletedProcess([], 0)
        for environment in (
            {"RUSTY_V8_ARCHIVE": "/artifact-directory"},
            {
                "RUSTY_V8_ARCHIVE": "/archive",
                "RUSTY_V8_ARCHIVE_SHA256": "a" * 64,
                "RUSTY_V8_SRC_BINDING_URL": "/binding",
            },
            {
                "RUSTY_V8_MIRROR": "https://example.invalid/{tag}/{file}",
                "RUSTY_V8_MIRROR_TAG": "custom-tag",
                "RUSTY_V8_MIRROR_FALLBACK": "1",
            },
        ):
            with (
                self.subTest(environment=environment),
                patch.dict("scripts.cargo.os.environ", environment, clear=True),
            ):
                self.assertEqual(main(["check", "-p", "ash-v8-poc"]), 0)
                self.assertEqual(run.call_args.kwargs["env"], environment)
        lock.assert_not_called()

    @patch("scripts.cargo.subprocess.run")
    @patch("scripts.cargo.cargo_command_packages")
    def test_protocol_preparation_precedes_compilation_and_failures_stop_cargo(
        self, packages, run
    ):
        packages.return_value = {"ash-app-server-protocol"}
        run.return_value = subprocess.CompletedProcess([], 0)
        self.assertEqual(main(["check", "-p", "ash-app-server-protocol"]), 0)
        self.protocol.assert_called_once()
        run.reset_mock()
        self.protocol.side_effect = RuntimeError("export failed")
        with self.assertRaisesRegex(RuntimeError, "export failed"):
            main(["check", "-p", "ash-app-server-protocol"])
        run.assert_not_called()

    @patch.dict(
        "scripts.cargo.os.environ",
        {"RUSTFLAGS": "--cfg probe", "CARGO_ENCODED_RUSTFLAGS": "--cfg\x1fprobe"},
        clear=True,
    )
    @patch("scripts.cargo.subprocess.run")
    @patch("scripts.cargo.cargo_command_packages", return_value=set())
    def test_warning_gate_preserves_the_compiler_artifact_identity(self, packages, run):
        run.return_value = subprocess.CompletedProcess([], 0)
        self.assertEqual(
            main(["--deny-warnings", "check", "-p", "ash-package-store"]), 0
        )
        environment = run.call_args.kwargs["env"]
        self.assertEqual(environment["CARGO_BUILD_WARNINGS"], "deny")
        self.assertEqual(environment["RUSTFLAGS"], "--cfg probe")
        self.assertEqual(environment["CARGO_ENCODED_RUSTFLAGS"], "--cfg\x1fprobe")

    @patch.dict("scripts.cargo.os.environ", {}, clear=True)
    @patch("scripts.cargo.subprocess.run")
    @patch(
        "scripts.cargo.resolve_sherpa_cargo_env",
        return_value={"SHERPA_ONNX_LIB_DIR": "/locked/libs"},
    )
    @patch("scripts.cargo.cargo_command_packages")
    def test_speech_resources_are_prepared_only_for_the_selected_graph(
        self, packages, speech, run
    ) -> None:
        run.return_value = subprocess.CompletedProcess([], 0)
        packages.return_value = {"sherpa-onnx-sys"}
        self.assertEqual(main(["check", "-p", "ash-tui"]), 0)
        self.assertEqual(
            run.call_args.kwargs["env"]["SHERPA_ONNX_LIB_DIR"], "/locked/libs"
        )
        speech.assert_called_once()
        speech.reset_mock()
        packages.return_value = set()
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
    @patch("scripts.cargo.cargo_command_packages")
    def test_remote_tests_prepare_the_shared_backend(
        self, packages, resolve_v8, prepare, run
    ) -> None:
        packages.return_value = {"ash-remote-server", "v8"}
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
    @patch("scripts.cargo.cargo_command_packages")
    def test_remote_compile_only_and_explicit_backend_do_not_prepare(
        self, packages, resolve_v8, prepare, run
    ) -> None:
        packages.return_value = {"ash-remote-server"}
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
    @patch("scripts.cargo.cargo_command_packages")
    def test_library_tests_prepare_the_separate_host_with_locked_v8(
        self, packages, resolve_v8, prepare, run
    ) -> None:
        packages.return_value = {"ash-code-mode"}
        run.return_value = subprocess.CompletedProcess([], 0)
        arguments = ["test", "-p", "ash-app-server", "--lib"]
        self.assertEqual(main(arguments), 0)
        resolve_v8.assert_called_once()
        packages.assert_called_once_with(
            "cargo", arguments, Path(__file__).resolve().parents[1]
        )
        self.assertEqual(prepare.call_args.args[1], arguments)
        self.assertEqual(prepare.call_args.args[2]["RUSTY_V8_ARCHIVE"], "locked")
        self.assertEqual(
            run.call_args.kwargs["env"]["ASH_CODE_MODE_HOST_BIN"], "/runtime/host"
        )

    @patch("scripts.cargo.subprocess.run")
    @patch("scripts.cargo.prepare_test_executable")
    @patch("scripts.cargo.resolve_v8_cargo_env")
    @patch("scripts.cargo.cargo_command_packages", return_value=set())
    def test_compile_only_and_explicit_host_do_not_prepare_a_host(
        self, packages, resolve_v8, prepare, run
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


class ProcessTestRunnerTests(unittest.TestCase):
    def setUp(self) -> None:
        cache = patch(
            "scripts.cargo.leased_cache",
            side_effect=lambda _root, **_options: nullcontext(),
        )
        cache.start()
        self.addCleanup(cache.stop)

    def artifact(self, name: str, kind: str = "test") -> dict:
        return {
            "reason": "compiler-artifact",
            "package_id": "app-server",
            "manifest_path": str(Path("crates/app-server/Cargo.toml").resolve()),
            "target": {"name": name, "kind": [kind]},
            "profile": {"test": kind == "test"},
            "executable": str(Path("test-output", name).resolve()),
        }

    @patch("scripts.cargo.subprocess.run")
    def test_runs_only_reported_tests_with_filters_runtime_and_package_directory(
        self, run
    ):
        test = self.artifact("managed_lifecycle")
        binary = self.artifact("ash-app-server", "bin")
        run.side_effect = [
            subprocess.CompletedProcess(
                [], 0, "\n".join(map(json.dumps, [binary, test]))
            ),
            subprocess.CompletedProcess([], 0),
        ]
        environment = {"PATH": "tools", "ASH_CODE_MODE_HOST_BIN": "host"}
        arguments = [
            "test",
            "-p",
            "ash-app-server",
            "--test=managed_lifecycle",
            "--profile",
            "ci-test",
            "stop_",
            "--",
            "--exact",
        ]
        self.assertEqual(run_process_tests("cargo", arguments, environment), 0)
        build, execute = run.call_args_list
        self.assertEqual(
            build.args[0],
            [
                "cargo",
                *arguments[: arguments.index("--")],
                "--no-run",
                "--message-format=json",
            ],
        )
        self.assertEqual(execute.args[0], [test["executable"], "stop_", "--exact"])
        self.assertEqual(execute.kwargs["cwd"], Path(test["manifest_path"]).parent)
        self.assertEqual(
            execute.kwargs["env"]["CARGO_BIN_EXE_ash-app-server"], binary["executable"]
        )
        self.assertEqual(execute.kwargs["env"]["ASH_CODE_MODE_HOST_BIN"], "host")
        self.assertEqual(
            environment, {"PATH": "tools", "ASH_CODE_MODE_HOST_BIN": "host"}
        )

    @patch("scripts.cargo.subprocess.run")
    def test_compile_failure_never_executes_partial_artifacts(self, run):
        run.return_value = subprocess.CompletedProcess(
            [], 23, json.dumps(self.artifact("partial"))
        )
        self.assertEqual(
            run_process_tests("cargo", ["test", "--test", "partial"], {}), 23
        )
        self.assertEqual(run.call_count, 1)

    @patch("scripts.cargo.subprocess.run")
    def test_no_selected_test_artifact_is_an_error(self, run):
        run.return_value = subprocess.CompletedProcess(
            [], 0, json.dumps(self.artifact("server", "bin"))
        )
        with self.assertRaisesRegex(RuntimeError, "integration test executables"):
            run_process_tests("cargo", ["test", "--test", "missing"], {})

    @patch("scripts.cargo.subprocess.run")
    def test_failure_is_preserved_and_no_fail_fast_runs_remaining_targets(self, run):
        artifacts = "\n".join(
            json.dumps(self.artifact(name)) for name in ["first", "second"]
        )
        for options, calls in [([], 2), (["--no-fail-fast"], 3)]:
            with self.subTest(options=options):
                run.reset_mock()
                run.side_effect = [
                    subprocess.CompletedProcess([], 0, artifacts),
                    subprocess.CompletedProcess([], 17),
                    subprocess.CompletedProcess([], 0),
                ]
                self.assertEqual(
                    run_process_tests("cargo", ["test", "--test", "*", *options], {}),
                    17,
                )
                self.assertEqual(run.call_count, calls)

    @patch("scripts.cargo.cargo_command_packages")
    @patch("scripts.cargo.sys.stderr")
    def test_rejects_target_selection_that_would_omit_unit_or_documentation_tests(
        self, stderr, packages
    ):
        for options in [
            [],
            ["--lib"],
            ["--doc"],
            ["--no-run"],
            ["--message-format=json"],
        ]:
            with self.subTest(options=options), self.assertRaises(SystemExit) as error:
                main(
                    [
                        "--process-tests",
                        "test",
                        "-p",
                        "ash-app-server",
                        *(["--test", "managed_lifecycle"] if options else []),
                        *options,
                    ]
                )
            self.assertEqual(error.exception.code, 2)
        packages.assert_not_called()


if __name__ == "__main__":
    unittest.main()
