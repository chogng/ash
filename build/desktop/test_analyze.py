import io
import json
import subprocess
import unittest
from contextlib import nullcontext
from unittest.mock import MagicMock
from unittest.mock import patch

from build.desktop import analyze


class AnalysisBridgeTests(unittest.TestCase):
    def test_failed_build_preserves_compiler_diagnostics(self):
        message = json.dumps(
            {"reason": "compiler-message", "message": {"rendered": "build failed\n"}}
        )
        errors = io.StringIO()
        with (
            patch.object(
                analyze.subprocess,
                "run",
                return_value=subprocess.CompletedProcess([], 101, message),
            ),
            patch.object(analyze.sys, "stderr", errors),
        ):
            with self.assertRaises(subprocess.CalledProcessError):
                analyze.build_bridge()
        self.assertEqual(errors.getvalue(), "build failed\n")

    def test_response_requires_supported_protocol_and_bounded_json(self):
        for data in [
            b"",
            b"x" * (analyze.MAX_RESPONSE_BYTES + 1),
            b'{"protocol_version":2}\n',
            b'{"protocol_version":1}\n',
            b'{"protocol_version":1,"error":{"code":"not_found"}}\n',
        ]:
            with self.assertRaises(RuntimeError):
                analyze.read_response(io.BytesIO(data))
        response = {"protocol_version": 1, "id": 1, "revision": 0, "result": {}}
        self.assertEqual(
            analyze.read_response(io.BytesIO(json.dumps(response).encode())), response
        )

    def test_invalid_offset_is_rejected_before_build_or_process_start(self):
        with patch.object(analyze, "build_bridge") as build:
            for offset in [-1, 2**32]:
                with self.assertRaises(ValueError):
                    analyze.analyze(analyze.ROOT, "lib.rs", offset)
            build.assert_not_called()

    def test_build_script_mode_retains_both_tool_and_artifact_cache_leases(self):
        child = MagicMock()
        child.returncode = 0
        child.stdin = io.BytesIO()
        child.stdout = io.BytesIO(
            b'{"protocol_version":1,"id":null,"revision":0,"result":{"event":"ready"}}\n'
            b'{"protocol_version":1,"id":1,"revision":0,"result":{"function":{}}}\n'
        )
        with (
            patch.object(analyze, "build_bridge", return_value="bridge.exe"),
            patch.object(analyze.subprocess, "Popen", return_value=child) as spawn,
            patch.object(
                analyze,
                "leased_cache",
                side_effect=lambda *_args, **_kwargs: nullcontext(),
            ) as lease,
        ):
            result = analyze.analyze(analyze.ROOT, "lib.rs", 0, build_scripts=True)
            self.assertEqual(result["analysis"], {"function": {}})
            self.assertIn("--build-scripts", spawn.call_args.args[0])
            self.assertEqual(
                [call.kwargs["profile"] for call in lease.call_args_list],
                ["ci-test", "dev-small"],
            )
