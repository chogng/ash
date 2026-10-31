"""Docker maintenance must leave live caches and unrelated volumes intact."""

import copy
import json
import subprocess
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

from build.lib import docker_cache


VOLUME = "ash-" + "a" * 52 + "-build-output"
NOW = datetime.now(timezone.utc)


def container(status="exited", *, hours=48, source=None):
    return {
        "Image": "sha256:existing-image",
        "State": {
            "Status": status,
            "FinishedAt": (NOW - timedelta(hours=hours)).isoformat(),
        },
        "Mounts": [
            {
                "Type": "bind",
                "Source": str(source or docker_cache.ROOT),
                "Destination": "/workspaces/ash",
            },
            {
                "Type": "volume",
                "Name": VOLUME,
                "Destination": "/workspaces/ash/.build",
            },
        ],
    }


class DockerCacheTests(unittest.TestCase):
    def run_maintenance(
        self, containers=None, *, free_gib=100, context="unix:///local"
    ):
        calls = []

        def docker(selected_context, *arguments, **options):
            self.assertEqual(selected_context, "desktop-linux")
            calls.append(arguments)
            if arguments[:2] == ("context", "inspect"):
                return json.dumps([{"Endpoints": {"docker": {"Host": context}}}])
            if arguments[0] == "version":
                return "linux"
            if arguments == ("volume", "ls", "--quiet"):
                return "\n".join(
                    [VOLUME, "ash-main-ci-x64-cache", "database", "ash-project-data"]
                )
            return ""

        with (
            patch.object(docker_cache, "_docker", side_effect=docker),
            patch.object(docker_cache, "_containers", return_value=containers or []),
            patch.object(
                docker_cache.shutil,
                "disk_usage",
                return_value=SimpleNamespace(free=free_gib * 1024**3),
            ),
        ):
            docker_cache.maintain_docker_cache("desktop-linux")
        return calls

    def test_removes_only_unreferenced_known_cache_volumes(self):
        calls = self.run_maintenance()
        removed = [call[2] for call in calls if call[:2] == ("volume", "rm")]
        self.assertEqual(removed, [VOLUME, "ash-main-ci-x64-cache"])
        self.assertFalse(any(call[:2] == ("container", "rm") for call in calls))

    def test_stopped_owner_keeps_volume_and_uses_locked_cargo_maintenance(self):
        calls = self.run_maintenance([container()])
        self.assertNotIn(("volume", "rm", VOLUME), calls)
        helper = next(call for call in calls if call[0] == "run")
        self.assertIn("sha256:existing-image", helper)
        self.assertIn("--pull=never", helper)
        self.assertIn("--network=none", helper)
        self.assertIn("trim_artifact_cache(p, 32 * 1024**3)", helper[-1])

    def test_running_recent_paused_and_created_owners_protect_shared_volume(self):
        for status, hours in [
            ("running", 48),
            ("exited", 1),
            ("paused", 48),
            ("created", 48),
        ]:
            with self.subTest(status=status, hours=hours):
                calls = self.run_maintenance(
                    [container(), container(status, hours=hours)]
                )
                self.assertFalse(any(call[0] == "run" for call in calls))
                self.assertNotIn(("volume", "rm", VOLUME), calls)

    def test_foreign_checkout_and_wrong_mount_are_not_cleaned(self):
        foreign = container(source="/another/checkout")
        wrong = copy.deepcopy(container())
        wrong["Mounts"][1]["Destination"] = "/database"
        calls = self.run_maintenance([foreign, wrong])
        self.assertFalse(any(call[0] == "run" for call in calls))
        self.assertNotIn(("volume", "rm", VOLUME), calls)

    def test_rechecks_container_state_before_starting_helper(self):
        with (
            patch.object(
                docker_cache,
                "_containers",
                side_effect=[[container()], [container("running")]],
            ),
            patch.object(docker_cache, "_docker") as docker,
        ):
            docker.side_effect = [
                json.dumps([{"Endpoints": {"docker": {"Host": "unix:///local"}}}]),
                "linux",
                "",
                "pruned",
            ]
            docker_cache.maintain_docker_cache("desktop-linux")
        self.assertFalse(any(call.args[1] == "run" for call in docker.call_args_list))

    def test_low_host_space_lowers_both_budgets(self):
        calls = self.run_maintenance([container()], free_gib=10)
        helper = next(call for call in calls if call[0] == "run")
        self.assertIn("trim_artifact_cache(p, 8 * 1024**3)", helper[-1])
        prune = next(call for call in calls if call[0] == "buildx")
        self.assertIn("1GB", prune)
        self.assertIn("until=24h", prune)
        self.assertIn("32GB", prune)

    def test_remote_context_rejected_before_any_mutation(self):
        with self.assertRaisesRegex(ValueError, "local Unix socket"):
            self.run_maintenance(context="ssh://another-host")

    def test_volume_acquiring_reference_is_never_forcibly_removed(self):
        def docker(context, *arguments, **options):
            if arguments[0] == "context":
                return json.dumps(
                    [{"Endpoints": {"docker": {"Host": "unix:///local"}}}]
                )
            if arguments[0] == "version":
                return "linux"
            if arguments[:2] == ("volume", "ls"):
                return VOLUME
            if arguments[:2] == ("volume", "rm"):
                self.assertEqual(arguments, ("volume", "rm", VOLUME))
                raise subprocess.CalledProcessError(1, "docker", stderr="volume in use")
            return ""

        with (
            patch.object(docker_cache, "_docker", side_effect=docker),
            patch.object(docker_cache, "_containers", return_value=[]),
            self.assertRaises(subprocess.CalledProcessError),
        ):
            docker_cache.maintain_docker_cache("desktop-linux")
