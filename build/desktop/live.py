"""Build and publish the opt-in Rust diff module through ash-build."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from build.lib.cargo import cargo_artifact_executable, parse_cargo_message
from build.lib.cargo_cache import leased_cache
from build.protocol.generate import generate_protocol
from build.desktop.analyze import PROFILE as ANALYSIS_PROFILE, build_bridge

ROOT = Path(__file__).resolve().parents[2]


def live_directory(environment: dict[str, str] | None = None) -> Path | None:
    configured = (
        (os.environ if environment is None else environment)
        .get("ASH_RUST_LIVE_DIRECTORY", "")
        .strip()
    )
    if not configured:
        return None
    directory = Path(configured)
    if not directory.is_absolute():
        raise ValueError("ASH_RUST_LIVE_DIRECTORY must be an absolute path")
    return directory


def build_tool(root: Path) -> str:
    result = subprocess.run(
        [
            sys.executable,
            "-B",
            "scripts/cargo.py",
            "build",
            "--locked",
            "-p",
            "ash-dev-build",
            "--bin",
            "ash-build",
            "--features",
            "compiler",
            "--profile",
            "dev-small",
            "--message-format=json-render-diagnostics",
        ],
        cwd=root,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        text=True,
        check=False,
    )
    executable = None
    for line in result.stdout.splitlines():
        message = parse_cargo_message(line)
        if message and message.get("reason") == "compiler-message":
            sys.stderr.write(message.get("message", {}).get("rendered", ""))
        executable = cargo_artifact_executable(message, "ash-build") or executable
    if result.returncode:
        raise subprocess.CalledProcessError(result.returncode, result.args)
    if executable is None:
        raise RuntimeError("Cargo reported no ash-build executable")
    return executable


def build_live(
    root: Path = ROOT, *, protocol_prepared: bool = False, functions_only: bool = False
) -> None:
    directory = live_directory()
    if directory is None:
        raise ValueError("Set ASH_RUST_LIVE_DIRECTORY to enable Rust live development")
    if not protocol_prepared:
        generate_protocol(root=root)
    executable = build_tool(root)
    if functions_only:
        bridge = build_bridge(root)
        with (
            leased_cache(root, profile="dev-small"),
            leased_cache(root, profile=ANALYSIS_PROFILE),
        ):
            result = subprocess.run(
                [executable, str(root), str(directory), "--serve", bridge],
                cwd=root,
                input=json.dumps({"protocol_version": 1, "id": 1, "mode": "functions"})
                + "\n",
                stdout=subprocess.PIPE,
                text=True,
                check=True,
            )
        frames = [json.loads(line) for line in result.stdout.splitlines()]
        if (
            len(frames) != 2
            or any(
                not isinstance(frame, dict) or frame.get("protocol_version") != 1
                for frame in frames
            )
            or frames[0].get("id") is not None
            or not isinstance(frames[0].get("result"), dict)
            or frames[0].get("result", {}).get("event") != "ready"
            or frames[1].get("id") != 1
            or "error" in frames[1]
            or not isinstance(frames[1].get("result"), dict)
            or frames[1]["result"].get("kind") not in {"function", "module"}
        ):
            raise RuntimeError(
                f"Function build failed: {frames[-1] if frames else 'no response'}"
            )
        return
    with leased_cache(root, profile="dev-small"):
        subprocess.run(
            [executable, str(root), str(directory)],
            cwd=root,
            stdin=subprocess.DEVNULL,
            check=True,
        )


def serve_live(root: Path = ROOT) -> None:
    directory = live_directory()
    if directory is None:
        raise ValueError("Set ASH_RUST_LIVE_DIRECTORY to enable Rust live development")
    executable = build_tool(root)
    bridge = build_bridge(root)
    # Leases are shared: they prevent cache eviction, not other Cargo builds.
    # Keeping them through EOF also protects the running tool executables.
    with (
        leased_cache(root, profile="dev-small"),
        leased_cache(root, profile=ANALYSIS_PROFILE),
    ):
        subprocess.run(
            [executable, str(root), str(directory), "--serve", bridge],
            cwd=root,
            check=True,
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--protocol-prepared", action="store_true")
    parser.add_argument("--functions-only", action="store_true")
    parser.add_argument("--serve", action="store_true")
    arguments = parser.parse_args()
    try:
        if arguments.serve:
            if arguments.functions_only or not arguments.protocol_prepared:
                raise ValueError(
                    "--serve requires --protocol-prepared and cannot use --functions-only"
                )
            serve_live()
        else:
            build_live(
                protocol_prepared=arguments.protocol_prepared,
                functions_only=arguments.functions_only,
            )
    except subprocess.CalledProcessError as error:
        raise SystemExit(error.returncode) from None
    except (OSError, RuntimeError, ValueError) as error:
        print(f"[ash-build] {error}", file=sys.stderr)
        raise SystemExit(1) from None
