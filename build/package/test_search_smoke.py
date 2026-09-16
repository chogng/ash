"""The package smoke must handle stdio framing and report lifecycle failures honestly."""

import os
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest

from build.package.search_smoke import RpcProcess


REPLY = """
import json, sys
request = json.loads(sys.stdin.readline())
sys.stdout.write(json.dumps({"method": "notification"}) + "\\n" +
                 json.dumps({"id": request["id"], "result": {"ready": True}}) + "\\n")
sys.stdout.flush()
"""


class RpcProcessTests(unittest.TestCase):
    def client(self, script):
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        errors = self.enterContext(tempfile.TemporaryFile())
        return RpcProcess(
            [sys.executable, "-u", "-c", script],
            cwd=root,
            env=os.environ.copy(),
            stderr=errors,
        )

    def test_notification_and_reply_in_one_write_do_not_stall_the_reader(self):
        with self.client(REPLY + "sys.stdin.read()") as client:
            self.assertEqual(client.call("initialize", {}), {"ready": True})
        self.assertEqual(client.process.returncode, 0)
        self.assertFalse(client.reader.is_alive())

    def test_abrupt_exit_keeps_the_missing_reply_error_and_stderr(self):
        with self.assertRaisesRegex(RuntimeError, "exited before replying") as raised:
            with self.client(
                "import sys; sys.stdin.readline(); "
                "print('startup failed', file=sys.stderr); sys.exit(3)"
            ) as client:
                client.call("initialize", {})
        notes = "\n".join(raised.exception.__notes__)
        self.assertIn("exited with 3", notes)
        self.assertIn("startup failed", notes)
        self.assertFalse(client.reader.is_alive())

    def test_forced_shutdown_is_a_failure_even_after_a_successful_rpc(self):
        with self.assertRaisesRegex(RuntimeError, "did not exit after stdin closed"):
            with self.client(REPLY + "import time; time.sleep(60)") as client:
                self.assertEqual(client.call("initialize", {}), {"ready": True})
                client.timeout = 0.1
        self.assertIsNotNone(client.process.poll())
        self.assertFalse(client.reader.is_alive())

    def test_failed_shutdown_does_not_replace_the_original_assertion(self):
        failure = AssertionError("search returned the wrong page")
        with self.assertRaises(AssertionError) as raised:
            with self.client(REPLY + "import time; time.sleep(60)") as client:
                client.call("initialize", {})
                client.timeout = 0.1
                raise failure
        self.assertIs(raised.exception, failure)
        self.assertIn("did not exit after stdin closed", "\n".join(failure.__notes__))
        self.assertIsNotNone(client.process.poll())

    def test_surviving_engine_is_detected_even_without_a_listening_socket(self):
        engine = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        try:
            with self.assertRaisesRegex(RuntimeError, "tgrep process .* survived"):
                with self.client(REPLY + "sys.stdin.read()") as client:
                    client.call("initialize", {})
                    client.timeout = 2
                    client.servers.append({"pid": engine.pid})
            engine.wait(timeout=5)
        finally:
            if engine.poll() is None:
                engine.kill()
                engine.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
