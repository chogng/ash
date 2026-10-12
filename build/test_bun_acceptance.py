"""Test acceptance failures and the completed CI timing report."""

from __future__ import annotations

import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from build import bun_acceptance as acceptance


class BunAcceptanceTests(unittest.TestCase):
    def test_diagnostics_normalize_paths_and_keep_location_code_and_message(self):
        text = "\x1b[31msrc/error.ts(2,7): error TS2345: Argument is invalid.\x1b[0m\nNo type errors in unrelated summary\n"
        self.assertEqual(
            acceptance.diagnostics(text),
            [
                {
                    "file": str((acceptance.ROOT / "src/error.ts").resolve()),
                    "line": 2,
                    "column": 7,
                    "code": 2345,
                    "message": "Argument is invalid.",
                }
            ],
        )

    def test_cold_install_rejects_a_populated_store_before_running_pnpm(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "cached-package").write_text("existing")
            with (
                patch.dict("os.environ", {"BUN_CI_STORE": str(directory)}),
                patch.object(acceptance, "run") as run,
            ):
                with self.assertRaisesRegex(RuntimeError, "empty pnpm store"):
                    acceptance.install(directory, "cold")
                run.assert_not_called()

    def test_warm_install_is_offline_and_propagates_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            with (
                patch.dict("os.environ", {"BUN_CI_STORE": str(directory)}),
                patch.object(acceptance.shutil, "which", return_value="pnpm"),
                patch.object(acceptance, "run", return_value={"exitCode": 1}) as run,
            ):
                with self.assertRaisesRegex(RuntimeError, "installation failed"):
                    acceptance.install(directory, "warm")
                self.assertEqual(
                    run.call_args.args[0],
                    ["pnpm", "install", "--frozen-lockfile", "--offline"],
                )
                self.assertEqual(
                    json.loads((directory / "install.json").read_text())["exitCode"], 1
                )

    def fixture(self, directory):
        jobs = []
        for runner in ("ubuntu-24.04", "windows-latest"):
            for phase in ("cold", "warm"):
                path = directory / runner / phase
                path.mkdir(parents=True)
                acceptance.save(path / "install.json", {"elapsedMs": 2500})
                acceptance.save(
                    path / "results.json",
                    {
                        "renderer": {
                            "medians": {
                                checker: {"elapsedMs": 100, "peakMemoryBytes": 1048576}
                                for checker in ("bun", "ts7")
                            }
                        }
                    },
                )
                jobs.append(
                    {
                        "name": f"{phase} ({runner}) / benchmark",
                        "conclusion": "success",
                        "started_at": "2026-10-12T00:00:00Z",
                        "completed_at": "2026-10-12T00:03:00Z",
                        "steps": [
                            {
                                "name": "Restore the exact cold installation cache",
                                "started_at": "2026-10-12T00:01:00Z",
                                "completed_at": "2026-10-12T00:01:05Z",
                            }
                        ],
                    }
                )
        return jobs

    def test_summary_uses_completed_job_time_and_retains_cache_steps(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            jobs = self.fixture(directory)
            environment = {
                "GITHUB_REPOSITORY": "owner/repo",
                "GITHUB_RUN_ID": "123",
                "GITHUB_TOKEN": "test-token",
                "GITHUB_STEP_SUMMARY": str(directory / "step-summary.md"),
            }
            with (
                patch.dict("os.environ", environment),
                patch.object(
                    acceptance,
                    "urlopen",
                    return_value=io.BytesIO(json.dumps({"jobs": jobs}).encode()),
                ),
            ):
                acceptance.summarize(directory)
            report = json.loads((directory / "summary.json").read_text())
            self.assertEqual(len(report["jobs"]), 4)
            self.assertTrue(all(job["jobSeconds"] == 180 for job in report["jobs"]))
            self.assertEqual(report["jobs"][0]["job"]["steps"], jobs[0]["steps"])
            self.assertIn(
                "not a comparison of two product CI jobs",
                (directory / "step-summary.md").read_text(),
            )

    def test_summary_rejects_failed_or_unfinished_jobs(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            jobs = self.fixture(directory)
            environment = {
                "GITHUB_REPOSITORY": "owner/repo",
                "GITHUB_RUN_ID": "123",
                "GITHUB_TOKEN": "test-token",
            }
            for conclusion in ("failure", None, "cancelled"):
                with self.subTest(conclusion=conclusion):
                    jobs[0]["conclusion"] = conclusion
                    with (
                        patch.dict("os.environ", environment),
                        patch.object(
                            acceptance,
                            "urlopen",
                            return_value=io.BytesIO(
                                json.dumps({"jobs": jobs}).encode()
                            ),
                        ),
                    ):
                        with self.assertRaisesRegex(
                            RuntimeError, "Incomplete acceptance"
                        ):
                            acceptance.summarize(directory)

    def test_workflow_orders_fresh_cold_and_warm_runners_and_requires_cache(self):
        workflow = (
            acceptance.ROOT / ".github/workflows/bun-acceptance.yml"
        ).read_text()
        job = (acceptance.ROOT / ".github/workflows/bun-benchmark.yml").read_text()
        self.assertIn("runner: [ubuntu-24.04, windows-latest]", workflow)
        self.assertIn("needs: cold", workflow.split("\n  warm:\n")[1])
        self.assertIn("needs: [cold, warm]", workflow.split("\n  report:\n")[1])
        self.assertIn("fail-on-cache-miss: true", job)
        self.assertNotIn("restore-keys", job)
        self.assertNotIn("continue-on-error", workflow + job)
        self.assertIn("github.run_attempt", job)
        self.assertIn("if: always()", job)


if __name__ == "__main__":
    unittest.main()
