"""Verify the shared local/CI dependency-security command and failure handling."""

from __future__ import annotations

import subprocess
import unittest
from unittest.mock import patch

import dependency_security


class DependencySecurityTests(unittest.TestCase):
    def test_pinned_tool_runs_all_owned_checks_and_propagates_failure(self) -> None:
        with (
            patch(
                "dependency_security.subprocess.check_output",
                return_value="cargo-deny 0.20.2\n",
            ),
            patch(
                "dependency_security.subprocess.run",
                return_value=subprocess.CompletedProcess([], 7),
            ) as run,
        ):
            self.assertEqual(dependency_security.main(["--deny", "checker"]), 7)
        self.assertEqual(
            run.call_args.args[0],
            [
                "checker",
                "--workspace",
                "--locked",
                "--config",
                str(dependency_security.ROOT / ".cargo/deny.toml"),
                "check",
                "advisories",
                "licenses",
                "sources",
            ],
        )
        self.assertEqual(run.call_args.kwargs["cwd"], dependency_security.ROOT)

    def test_wrong_version_and_missing_tool_fail_before_checking(self) -> None:
        for value in ("cargo-deny 0.19.0", FileNotFoundError("missing tool")):
            with (
                self.subTest(value=value),
                patch(
                    "dependency_security.subprocess.check_output",
                    **(
                        {"side_effect": value}
                        if isinstance(value, Exception)
                        else {"return_value": value}
                    ),
                ),
                patch("dependency_security.subprocess.run") as run,
            ):
                self.assertEqual(dependency_security.main([]), 1)
                run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
