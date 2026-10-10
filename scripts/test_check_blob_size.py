"""Exercise blob budgets against real Git histories, including renamed binaries."""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import tempfile
import unittest

import check_blob_size


class BlobSizeTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.git("init", "-q")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "user.name", "Repository tests")
        self.git("config", "core.autocrlf", "false")
        self.write("small.txt", b"small")
        self.base = self.commit()
        self.policy = {"max_bytes": 10, "exceptions": {}}

    def git(self, *arguments: str) -> str:
        return subprocess.check_output(
            ["git", *arguments], cwd=self.root, text=True
        ).strip()

    def write(self, name: str, data: bytes) -> None:
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def commit(self) -> str:
        self.git("add", "-A")
        self.git("commit", "-qm", "fixture")
        return self.git("rev-parse", "HEAD")

    def test_new_and_modified_blobs_enforce_inclusive_budget(self) -> None:
        self.write("small.txt", b"x" * 11)
        self.write("binary.dat", b"\0" * 11)
        self.write("limit.txt", b"x" * 10)
        violations = check_blob_size.check(
            self.root, self.base, self.commit(), self.policy
        )
        self.assertEqual(len(violations), 2)
        self.assertTrue(any("binary.dat" in item for item in violations))

    def test_unchanged_and_deleted_large_blobs_are_not_checked(self) -> None:
        self.write("old.dat", b"\0" * 20)
        base = self.commit()
        self.write("small.txt", b"changed")
        self.assertEqual(
            check_blob_size.check(self.root, base, self.commit(), self.policy), []
        )
        (self.root / "old.dat").unlink()
        self.assertEqual(
            check_blob_size.check(self.root, base, self.commit(), self.policy), []
        )

    def test_exception_is_exact_and_still_has_a_budget(self) -> None:
        self.policy["exceptions"]["asset.dat"] = {"max_bytes": 20, "reason": "fixture"}
        self.write("asset.dat", b"x" * 20)
        base = self.commit()
        self.assertEqual(
            check_blob_size.check(self.root, self.base, base, self.policy), []
        )
        self.git("mv", "asset.dat", "renamed.dat")
        self.assertEqual(
            len(check_blob_size.check(self.root, base, self.commit(), self.policy)), 1
        )
        self.write("asset.dat", b"x" * 21)
        self.assertEqual(
            len(check_blob_size.check(self.root, base, self.commit(), self.policy)), 2
        )

    def test_first_push_checks_the_whole_tree_and_unicode_paths(self) -> None:
        self.write("含 空格.dat", b"x" * 11)
        head = self.commit()
        for base in (None, "", "0" * 40):
            with self.subTest(base=base):
                violations = check_blob_size.check(self.root, base, head, self.policy)
                self.assertEqual(len(violations), 1)
                self.assertIn("含 空格.dat", violations[0])

    def test_cli_reports_failure_and_invalid_revision(self) -> None:
        self.write("large.dat", b"x" * 11)
        head = self.commit()
        policy_path = self.root / "policy.json"
        policy_path.write_text(json.dumps(self.policy))
        for revision in (head, "missing-revision"):
            result = subprocess.run(
                ["git", "rev-parse", "--verify", revision],
                cwd=self.root,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode == 0, revision == head)
            self.assertEqual(
                check_blob_size.main(
                    [
                        "--root",
                        str(self.root),
                        "--policy",
                        str(policy_path),
                        "--base",
                        self.base,
                        "--head",
                        revision,
                    ]
                ),
                1,
            )

    def test_policy_rejects_unbounded_or_unexplained_exceptions(self) -> None:
        policy_path = self.root / "policy.json"
        invalid = [
            None,
            10,
            [],
            {"max_bytes": True, "exceptions": {}},
            {
                "max_bytes": 10,
                "exceptions": {"*.dat": {"max_bytes": 20, "reason": "x"}},
            },
            {
                "max_bytes": 10,
                "exceptions": {"../asset": {"max_bytes": 20, "reason": "x"}},
            },
            {"max_bytes": 10, "exceptions": {"asset": {"max_bytes": 20, "reason": ""}}},
            {
                "max_bytes": 10,
                "exceptions": {"asset": {"max_bytes": 10, "reason": "x"}},
            },
        ]
        for policy in invalid:
            with self.subTest(policy=policy):
                policy_path.write_text(json.dumps(policy))
                with self.assertRaises(ValueError):
                    check_blob_size.load_policy(policy_path)


if __name__ == "__main__":
    unittest.main()
