"""Exercise the commit gate through Just with real Git index and working-tree changes."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class CommitCheckTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="ash commit checks ")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / "scripts").mkdir()
        for name in ("justfile", "scripts/commit_check.py"):
            (self.root / name).write_bytes((ROOT / name).read_bytes())
        # Keep formatter dependencies out of this workflow test while exercising
        # the real nested Just invocation and its argument forwarding.
        (self.root / "scripts/format.py").write_text(
            "import json, pathlib, sys\n"
            "with open('format-calls.jsonl', 'a') as calls:\n"
            "    calls.write(json.dumps(sys.argv[1:]) + '\\n')\n"
            "mode = 'scoped' if '--changed' in sys.argv else 'full'\n"
            "failure = pathlib.Path(mode + '-failure')\n"
            "sys.exit(int(failure.read_text()) if failure.exists() else 0)\n",
            encoding="utf-8",
        )
        self.environment = {
            **os.environ,
            "PATH": str(Path(sys.executable).parent)
            + os.pathsep
            + os.environ.get("PATH", ""),
        }
        self.git("init", "--quiet")
        self.git("config", "user.email", "test@example.com")
        self.git("config", "user.name", "Test")
        self.git("config", "core.autocrlf", "false")
        self.git("config", "core.whitespace", "blank-at-eol")
        self.git("config", "core.hooksPath", str(self.root / "no-hooks"))
        (self.root / "source.txt").write_bytes(b"original\n")
        self.git("add", "source.txt")
        self.git("commit", "--quiet", "-m", "baseline")
        self.base = "refs/heads/review's-base"
        self.git("update-ref", self.base, "HEAD")

    def git(self, *arguments: str) -> bytes:
        return subprocess.check_output(["git", *arguments], cwd=self.root)

    def run_gate(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["just", "commit-check", self.base, *arguments],
            cwd=self.root,
            env=self.environment,
            capture_output=True,
            text=True,
            check=False,
        )

    def calls(self) -> list[list[str]]:
        return [
            json.loads(line)
            for line in (self.root / "format-calls.jsonl").read_text().splitlines()
        ]

    def assert_rejected_without_mutation(self) -> None:
        before = (
            (self.root / "source.txt").read_bytes(),
            self.git("diff"),
            self.git("diff", "--cached"),
        )
        result = self.run_gate()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("trailing whitespace", result.stdout)
        self.assertEqual(
            before,
            (
                (self.root / "source.txt").read_bytes(),
                self.git("diff"),
                self.git("diff", "--cached"),
            ),
        )

    def test_default_gate_checks_scoped_formatting_with_literal_base(self) -> None:
        result = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls(), [["--check", "--changed", self.base]])

    def test_full_gate_also_runs_repository_formatting(self) -> None:
        result = self.run_gate("--full")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            self.calls(), [["--check", "--changed", self.base], ["--check"]]
        )

    def test_scoped_failure_stops_before_full_check(self) -> None:
        (self.root / "scoped-failure").write_text("23")
        result = self.run_gate("--full")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.calls(), [["--check", "--changed", self.base]])
        self.assertNotIn("$ git diff", result.stdout)

    def test_full_failure_rejects_the_gate(self) -> None:
        (self.root / "full-failure").write_text("24")
        result = self.run_gate("--full")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(len(self.calls()), 2)
        self.assertNotIn("$ git diff", result.stdout)

    def test_unstaged_whitespace_is_rejected_without_modifying_other_work(self) -> None:
        (self.root / "source.txt").write_bytes(b"unrelated change \n")
        self.assert_rejected_without_mutation()

    def test_staged_whitespace_is_rejected_when_working_file_is_clean(self) -> None:
        (self.root / "source.txt").write_bytes(b"staged change \n")
        self.git("add", "source.txt")
        (self.root / "source.txt").write_bytes(b"staged change\n")
        self.assert_rejected_without_mutation()


if __name__ == "__main__":
    unittest.main()
