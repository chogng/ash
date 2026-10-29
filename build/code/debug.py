"""Prepare the native Code TUI debugger and its checksum-locked runtime tools."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from build.code.build import BINARY_PACKAGES  # noqa: E402
from build.code.build import prepare_runtime_environment  # noqa: E402
from build.lib.ripgrep import resolve_ripgrep  # noqa: E402
from build.lib.targets import TARGETS, default_target  # noqa: E402
from build.lib.tgrep import resolve_tgrep  # noqa: E402


def main() -> int:
    status, environment = prepare_runtime_environment(ROOT)
    if status:
        return status
    target = TARGETS[default_target()]
    tools = {
        "ASH_DEV_RUNTIME_ROOT": Path(environment["ASH_DEV_RUNTIME_ROOT"]),
        "ASH_RG_PATH": resolve_ripgrep(
            target,
            ROOT / "third_party/ripgrep/runtime-lock.json",
            ROOT / "third_party/.cache/ripgrep",
        ).executable,
        "ASH_TGREP_PATH": resolve_tgrep(
            target,
            ROOT / "third_party/tgrep/runtime-lock.json",
            ROOT / "third_party/.cache/tgrep",
        ).executable,
    }
    command = [sys.executable, "-B", "scripts/cargo.py", "build"]
    for name in [
        "ash",
        "ash-app-server",
        "ash-app-server-daemon",
        "ash-code-mode-host",
    ]:
        command.extend(["-p", BINARY_PACKAGES[name], "--bin", name])
    command.extend(
        [
            "--profile",
            "ci-test",
            "--config",
            "profile.ci-test.package.ash-cli.debug=2",
            "--config",
            "profile.ci-test.package.ash-cli.opt-level=0",
            "--config",
            "profile.ci-test.package.ash-tui.debug=2",
        ]
    )
    result = subprocess.run(command, cwd=ROOT, check=False)
    if result.returncode:
        return result.returncode
    # This target lives outside an immutable runtime package. CodeLLDB loads
    # these literal environment values before the CLI starts its sibling server.
    output = ROOT / ".build/code/debug.env"
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".env.partial")
    temporary.write_text(
        "".join(
            f"{key}={json.dumps(path.resolve().as_posix(), ensure_ascii=False)}\n"
            for key, path in tools.items()
        ),
        encoding="utf-8",
    )
    temporary.replace(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
