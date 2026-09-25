"""Build one source-tree runtime generation and launch the Code TUI."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT))

from build.code.build import build_binaries  # noqa: E402
from build.code.build import development_binaries  # noqa: E402
from build.code.build import stage_runtime  # noqa: E402
from build.lib.targets import TARGETS, default_target  # noqa: E402
from build.ash_rs.tgrep import resolve_tgrep  # noqa: E402


def runtime_environment(
    environment: dict[str, str], executables: dict[str, Path]
) -> dict[str, str]:
    runtime = environment.copy()
    runtime["ASH_APP_SERVER_PATH"] = str(executables["ash-app-server"].resolve())
    runtime["ASH_PRODUCT_SERVICES_PATH"] = str(
        (REPOSITORY_ROOT / "resources/product-services/product-services.json").resolve()
    )
    if tgrep := executables.get("tgrep"):
        runtime.setdefault("ASH_TGREP_PATH", str(tgrep.resolve()))
    if bubblewrap := executables.get("bwrap"):
        runtime["ASH_BWRAP_PATH"] = str(bubblewrap.resolve())
    runtime["ASH_CODE_MODE_HOST_BIN"] = str(executables["ash-code-mode-host"].resolve())
    return runtime


def requires_selected_server(arguments: list[str]) -> bool:
    return not arguments or arguments[0] not in {
        "--help",
        "-h",
        "--version",
        "-V",
        "app-server",
        "remote",
        "update",
    }


def main(arguments: list[str] | None = None) -> int:
    arguments = arguments or []
    environment = os.environ.copy()
    binaries = development_binaries()
    returncode, built = build_binaries(binaries, environment)
    if returncode != 0:
        return returncode
    if "ASH_TGREP_PATH" not in environment:
        built["tgrep"] = resolve_tgrep(
            TARGETS[default_target()],
            REPOSITORY_ROOT / "third_party/tgrep/runtime-lock.json",
            REPOSITORY_ROOT / "third_party/.cache/tgrep",
        ).executable
    executables = stage_runtime(built)
    environment = runtime_environment(environment, executables)
    if requires_selected_server(arguments):
        prepared = subprocess.run(
            [str(executables["ash"]), "app-server", "daemon", "ensure-selected"],
            cwd=REPOSITORY_ROOT,
            env=environment,
            stdout=subprocess.DEVNULL,
            check=False,
        )
        if prepared.returncode != 0:
            return prepared.returncode
    return subprocess.run(
        [str(executables["ash"]), *arguments],
        cwd=REPOSITORY_ROOT,
        env=environment,
        check=False,
    ).returncode


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
