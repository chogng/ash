import subprocess
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from contextlib import nullcontext

from build.desktop import live
from build.lib import package_binaries
from build.lib.targets import TARGETS


class LiveBuildTests(unittest.TestCase):
    def test_opt_in_requires_an_absolute_directory(self):
        self.assertIsNone(live.live_directory({}))
        with self.assertRaisesRegex(ValueError, "absolute"):
            live.live_directory({"ASH_RUST_LIVE_DIRECTORY": "relative"})
        with tempfile.TemporaryDirectory() as temporary:
            self.assertEqual(
                live.live_directory({"ASH_RUST_LIVE_DIRECTORY": temporary}),
                Path(temporary),
            )

    def test_feature_only_enters_development_app_server_build(self):
        with patch.object(live, "live_directory", return_value=Path.cwd()):
            for profile, names, enabled in [
                ("dev-small", ["ash-app-server"], True),
                ("release", ["ash-app-server"], False),
                ("dev-small", ["ash-livekit-client"], False),
            ]:
                command = package_binaries._build_command(
                    Path.cwd(),
                    TARGETS["x86_64-pc-windows-msvc"],
                    names,
                    "cargo",
                    profile,
                    True,
                )
                self.assertEqual("ash-app-server/rust-live" in command, enabled)

    def test_failed_tool_build_never_invokes_publisher(self):
        failure = subprocess.CalledProcessError(101, ["cargo"])
        with (
            patch.object(live, "live_directory", return_value=Path.cwd()),
            patch.object(live.subprocess, "run", side_effect=failure) as run,
        ):
            with self.assertRaises(subprocess.CalledProcessError):
                live.build_live(protocol_prepared=True)
            self.assertEqual(run.call_count, 1)

    def test_failed_tool_build_prints_compiler_diagnostics(self):
        message = json.dumps(
            {
                "reason": "compiler-message",
                "message": {"rendered": "compiler failure\n"},
            }
        )
        errors = io.StringIO()
        with (
            patch.object(live, "live_directory", return_value=Path.cwd()),
            patch.object(
                live.subprocess,
                "run",
                return_value=subprocess.CompletedProcess([], 101, message),
            ) as run,
            patch.object(live.sys, "stderr", errors),
        ):
            with self.assertRaises(subprocess.CalledProcessError):
                live.build_live(protocol_prepared=True)
            self.assertEqual(run.call_count, 1)
        self.assertEqual(errors.getvalue(), "compiler failure\n")

    def test_function_request_reaches_the_bridge_worker_under_both_cache_leases(self):
        artifact = json.dumps(
            {
                "reason": "compiler-artifact",
                "target": {"name": "ash-build", "kind": ["bin"]},
                "executable": "ash-build.exe",
            }
        )
        with (
            patch.object(live, "live_directory", return_value=Path.cwd()),
            patch.object(live, "build_bridge", return_value="analysis.exe"),
            patch.object(live, "leased_cache", return_value=nullcontext()) as lease,
            patch.object(
                live.subprocess,
                "run",
                side_effect=[
                    subprocess.CompletedProcess([], 0, artifact),
                    subprocess.CompletedProcess(
                        [],
                        0,
                        "\n".join(
                            [
                                json.dumps(
                                    {
                                        "protocol_version": 1,
                                        "id": None,
                                        "result": {"event": "ready"},
                                    }
                                ),
                                json.dumps(
                                    {
                                        "protocol_version": 1,
                                        "id": 1,
                                        "result": {"kind": "function"},
                                    }
                                ),
                            ]
                        ),
                    ),
                ],
            ) as run,
        ):
            live.build_live(protocol_prepared=True, functions_only=True)
            self.assertIn("compiler", run.call_args_list[0].args[0])
            self.assertEqual(
                run.call_args_list[1].args[0][-2:], ["--serve", "analysis.exe"]
            )
            self.assertEqual(
                json.loads(run.call_args_list[1].kwargs["input"])["mode"], "functions"
            )
            self.assertEqual(lease.call_count, 2)
            self.assertEqual(
                [call.kwargs["profile"] for call in lease.call_args_list],
                ["dev-small", live.ANALYSIS_PROFILE],
            )

    def test_function_failure_and_invalid_worker_envelopes_are_not_success(self):
        ready = {"protocol_version": 1, "id": None, "result": {"event": "ready"}}
        for response in [
            {"protocol_version": 1, "id": 1, "error": "E0308"},
            {"protocol_version": 2, "id": 1, "result": {"kind": "function"}},
            {"protocol_version": 1, "id": 7, "result": {"kind": "function"}},
            {"protocol_version": 1, "id": 1, "result": {"kind": "unknown"}},
        ]:
            with (
                self.subTest(response=response),
                patch.object(live, "live_directory", return_value=Path.cwd()),
                patch.object(live, "build_tool", return_value="ash-build.exe"),
                patch.object(live, "build_bridge", return_value="analysis.exe"),
                patch.object(live, "leased_cache", return_value=nullcontext()),
                patch.object(
                    live.subprocess,
                    "run",
                    return_value=subprocess.CompletedProcess(
                        [], 0, json.dumps(ready) + "\n" + json.dumps(response)
                    ),
                ),
            ):
                with self.assertRaisesRegex(RuntimeError, "Function build failed"):
                    live.build_live(protocol_prepared=True, functions_only=True)


if __name__ == "__main__":
    unittest.main()
