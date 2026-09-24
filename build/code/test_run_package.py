from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import call
from unittest.mock import patch

from build.code import run_package


class PackageRunnerTests(unittest.TestCase):
    def test_main_packages_then_runs_the_staged_cli_against_that_package(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            package = Path(temporary) / "package"
            suffix = ".exe" if run_package.os.name == "nt" else ""
            backend = package / "bin" / f"ash-app-server{suffix}"
            product_services = (
                package / "ash-resources/product-services/product-services.json"
            )
            backend.parent.mkdir(parents=True)
            product_services.parent.mkdir(parents=True)
            backend.touch()
            product_services.touch()
            built = Path(temporary) / "built-ash"
            staged = Path(temporary) / "staged-ash"
            environment = {"PATH": "tools"}
            with (
                patch.dict(run_package.os.environ, environment, clear=True),
                patch.object(run_package, "current_package", return_value=package),
                patch.object(
                    run_package.code_build,
                    "build_binaries",
                    return_value=(0, {"ash": built}),
                ) as build,
                patch.object(
                    run_package.code_build,
                    "stage_runtime",
                    return_value={"ash": staged},
                ),
                patch.object(run_package.subprocess, "run") as subprocess_run,
            ):
                subprocess_run.side_effect = [
                    run_package.subprocess.CompletedProcess([], 0),
                    run_package.subprocess.CompletedProcess([], 0),
                ]

                self.assertEqual(
                    run_package.main(["app-server", "backend", "version"]), 0
                )

            build.assert_called_once_with(["ash"], environment)
            subprocess_run.assert_has_calls(
                [
                    call(
                        [run_package.sys.executable, "-B", "build/ash_rs/prepare.py"],
                        cwd=run_package.run.REPOSITORY_ROOT,
                        env=environment,
                        check=False,
                    ),
                    call(
                        [str(staged), "app-server", "backend", "version"],
                        cwd=run_package.run.REPOSITORY_ROOT,
                        env={
                            **environment,
                            "ASH_APP_SERVER_PATH": str(backend.resolve()),
                            "ASH_PRODUCT_SERVICES_PATH": str(
                                product_services.resolve()
                            ),
                        },
                        check=False,
                    ),
                ]
            )

    def test_current_package_resolves_the_latest_numbered_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            development_root = Path(temporary)
            build = "a" * 64
            package_root = development_root / "packages" / "0.1.0" / build
            package_root.mkdir(parents=True)
            manifests = development_root / "manifests"
            manifests.mkdir()
            (manifests / "00000000000000000001.json").write_text(
                json.dumps(
                    {
                        "formatVersion": 1,
                        "sequence": 1,
                        "directory": f"packages/0.1.0/{build}",
                    }
                ),
                encoding="utf-8",
            )

            with patch.object(
                run_package, "development_root", return_value=development_root
            ):
                self.assertEqual(run_package.current_package(), package_root)

    def test_current_package_rejects_a_path_outside_the_package_store(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            development_root = Path(temporary)
            manifests = development_root / "manifests"
            manifests.mkdir()
            (manifests / "00000000000000000001.json").write_text(
                json.dumps(
                    {"formatVersion": 1, "sequence": 1, "directory": "../package"}
                ),
                encoding="utf-8",
            )

            with patch.object(
                run_package, "development_root", return_value=development_root
            ):
                with self.assertRaisesRegex(
                    RuntimeError, "Invalid Ash development package manifest"
                ):
                    run_package.current_package()


if __name__ == "__main__":
    unittest.main()
