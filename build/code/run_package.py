"""Build a complete development package and launch the Code TUI against it."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT))

from build.code import run  # noqa: E402
from build.code import build as code_build  # noqa: E402
from build.ash_rs.prepare import current_package as selected_package  # noqa: E402
from build.ash_rs.prepare import development_root  # noqa: E402
from build.lib.targets import default_target  # noqa: E402


def current_package() -> Path:
    package_root = selected_package(
        development_root(run.REPOSITORY_ROOT, default_target(), "host-provided-node")
    )
    if not package_root.is_dir():
        raise RuntimeError(f"Ash development package is missing: {package_root}")
    return package_root


def main(arguments: list[str] | None = None) -> int:
    environment = os.environ.copy()
    prepared = subprocess.run(
        [sys.executable, "-B", "build/ash_rs/prepare.py"],
        cwd=run.REPOSITORY_ROOT,
        env=environment,
        check=False,
    )
    if prepared.returncode != 0:
        return prepared.returncode

    package_root = current_package()
    suffix = ".exe" if os.name == "nt" else ""
    backend = package_root / "bin" / f"ash-app-server{suffix}"
    product_services = (
        package_root / "ash-resources/product-services/product-services.json"
    )
    if not backend.is_file():
        raise RuntimeError(f"Ash App Server backend is missing: {backend}")
    if not product_services.is_file():
        raise RuntimeError(f"Ash product services are missing: {product_services}")

    returncode, built = code_build.build_binaries(["ash"], environment)
    if returncode != 0:
        return returncode
    executable = code_build.stage_runtime(built)["ash"]
    environment = environment.copy()
    environment["ASH_APP_SERVER_PATH"] = str(backend.resolve())
    environment["ASH_PRODUCT_SERVICES_PATH"] = str(product_services.resolve())
    arguments = arguments or []
    if run.requires_selected_server(arguments):
        prepared = subprocess.run(
            [str(executable), "app-server", "daemon", "ensure-selected"],
            cwd=run.REPOSITORY_ROOT,
            env=environment,
            stdout=subprocess.DEVNULL,
            check=False,
        )
        if prepared.returncode != 0:
            return prepared.returncode
    return subprocess.run(
        [str(executable), *arguments],
        cwd=run.REPOSITORY_ROOT,
        env=environment,
        check=False,
    ).returncode


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
