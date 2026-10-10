"""Run Cargo with Ash's checksum-verified Code Mode V8 inputs."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY_ROOT))

from build.lib.cargo_selection import cargo_command_packages  # noqa: E402
from build.lib.cargo import (  # noqa: E402
    cargo_artifact_executable,
    cargo_rendered_diagnostic,
    parse_cargo_message,
)
from build.lib.cargo_cache import leased_cache, profile_from_arguments  # noqa: E402
from build.protocol.generate import generate_protocol  # noqa: E402
from build.lib.sherpa import resolve_sherpa_cargo_env  # noqa: E402
from build.lib.targets import TARGETS, default_target  # noqa: E402
from build.lib.v8 import (  # noqa: E402
    DEFAULT_CACHE,
    DEFAULT_LOCK,
    resolve_v8_cargo_env,
)


def cargo_target(arguments: list[str]) -> str | None:
    for index, argument in enumerate(arguments):
        if argument == "--target" and index + 1 < len(arguments):
            return arguments[index + 1]
        if argument.startswith("--target="):
            return argument.split("=", 1)[1]
    return None


def prepare_test_executable(
    cargo: str, arguments: list[str], environment: dict[str, str], package: str
) -> str:
    # Cargo does not build a dependency's executable for library tests. Match the
    # test compilation settings and use its reported artifact, not a guessed path.
    selection: list[str] = []
    value_options = {
        "--target",
        "--target-dir",
        "--profile",
        "--config",
        "--jobs",
        "-j",
        "-Z",
    }
    flag_options = {"--release", "--locked", "--frozen", "--offline"}
    iterator = iter(arguments[1:])
    for argument in iterator:
        if argument == "--":
            break
        if argument in value_options:
            selection.extend((argument, next(iterator)))
        elif (
            argument in flag_options
            or any(argument.startswith(option + "=") for option in value_options)
            or any(
                argument.startswith(option) and argument != option
                for option in ("-j", "-Z")
            )
        ):
            selection.append(argument)
    if "--release" not in selection and not any(
        argument == "--profile" or argument.startswith("--profile=")
        for argument in selection
    ):
        selection.extend(("--profile", "test"))
    result = subprocess.run(
        [
            cargo,
            "build",
            "-p",
            package,
            "--bin",
            package,
            "--message-format=json",
            *selection,
        ],
        cwd=REPOSITORY_ROOT,
        env=environment,
        check=False,
        stdout=subprocess.PIPE,
        text=True,
    )
    executable = None
    for line in result.stdout.splitlines():
        message = parse_cargo_message(line)
        if diagnostic := cargo_rendered_diagnostic(message):
            sys.stderr.write(diagnostic)
        if artifact := cargo_artifact_executable(message, package):
            executable = artifact
    result.check_returncode()
    if executable is None:
        raise RuntimeError(f"Cargo did not report the {package} executable")
    return executable


def run_process_tests(
    cargo: str, arguments: list[str], environment: dict[str, str]
) -> int:
    """Compile selected integration tests, then run them independently of Cargo's Job."""
    separator = arguments.index("--") if "--" in arguments else len(arguments)
    compile_arguments = arguments[:separator]
    test_arguments = arguments[separator + 1 :]
    value_options = {
        "-p",
        "--package",
        "--test",
        "--target",
        "--target-dir",
        "--profile",
        "--config",
        "--jobs",
        "-j",
        "-Z",
        "--features",
        "-F",
        "--exclude",
        "--manifest-path",
        "--color",
    }
    result = subprocess.run(
        [cargo, *compile_arguments, "--no-run", "--message-format=json"],
        cwd=REPOSITORY_ROOT,
        env=environment,
        stdout=subprocess.PIPE,
        text=True,
        check=False,
    )
    tests = []
    binaries: dict[str, dict[str, str]] = {}
    for line in result.stdout.splitlines():
        message = parse_cargo_message(line)
        if diagnostic := cargo_rendered_diagnostic(message):
            sys.stderr.write(diagnostic)
        if message is None:
            print(line)
        elif message.get("reason") == "compiler-artifact" and message.get("executable"):
            if message["profile"]["test"] and "test" in message["target"]["kind"]:
                tests.append(message)
            elif "bin" in message["target"]["kind"]:
                binaries.setdefault(message["package_id"], {})[
                    "CARGO_BIN_EXE_" + message["target"]["name"]
                ] = message["executable"]
    if result.returncode:
        return result.returncode
    iterator = iter(compile_arguments[1:])
    for argument in iterator:
        if argument in value_options:
            next(iterator)
        elif not argument.startswith("-"):
            test_arguments.insert(0, argument)
    if not tests:
        raise RuntimeError(
            "Cargo did not report any selected integration test executables"
        )
    exit_code = 0
    for artifact in tests:
        executable = Path(artifact["executable"])
        manifest = Path(artifact["manifest_path"])
        test_environment = environment.copy()
        test_environment.update(binaries.get(artifact["package_id"], {}))
        test_environment["CARGO_MANIFEST_DIR"] = str(manifest.parent)
        test_environment["CARGO_MANIFEST_PATH"] = str(manifest)
        test_environment["PATH"] = os.pathsep.join(
            [
                str(executable.parent),
                str(executable.parent.parent),
                environment.get("PATH", ""),
            ]
        )
        print(f"Running {artifact['target']['name']} ({executable})", flush=True)
        completed = subprocess.run(
            [str(executable), *test_arguments],
            cwd=manifest.parent,
            env=test_environment,
            check=False,
        )
        if completed.returncode:
            exit_code = completed.returncode
            if "--no-fail-fast" not in compile_arguments:
                break
    return exit_code


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run Cargo with the locked sandbox-enabled rusty_v8 archive and binding."
    )
    parser.add_argument("--cargo", default="cargo")
    parser.add_argument("--v8-target", choices=sorted(TARGETS))
    parser.add_argument("--v8-lock", type=Path, default=DEFAULT_LOCK)
    parser.add_argument("--v8-cache-root", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--deny-warnings", action="store_true")
    parser.add_argument("--process-tests", action="store_true")
    parser.add_argument("cargo_arguments", nargs=argparse.REMAINDER)
    args = parser.parse_args(arguments)
    cargo_arguments = list(args.cargo_arguments)
    if cargo_arguments[:1] == ["--"]:
        cargo_arguments = cargo_arguments[1:]
    if not cargo_arguments:
        parser.error("a Cargo command is required")
    if args.process_tests:
        cargo_options = (
            cargo_arguments[: cargo_arguments.index("--")]
            if "--" in cargo_arguments
            else cargo_arguments
        )
        if (
            cargo_options[0] != "test"
            or not any(
                option == "--test" or option.startswith("--test=")
                for option in cargo_options
            )
            or any(
                option
                in {
                    "--lib",
                    "--bins",
                    "--bin",
                    "--examples",
                    "--example",
                    "--benches",
                    "--bench",
                    "--doc",
                    "--all-targets",
                    "--tests",
                    "--no-run",
                    "--message-format",
                }
                or option.startswith(
                    ("--bin=", "--example=", "--bench=", "--message-format=")
                )
                for option in cargo_options
            )
        ):
            parser.error(
                "--process-tests requires test with explicit --test targets only; Cargo JSON output is managed by the runner"
            )

    target = args.v8_target or cargo_target(cargo_arguments) or default_target()
    if target not in TARGETS:
        parser.error(f"unsupported V8 target: {target}")
    environment = os.environ.copy()
    if (
        "apple-darwin" in target
        and profile_from_arguments(cargo_arguments) == "release"
    ):
        environment["CARGO_PROFILE_RELEASE_SPLIT_DEBUGINFO"] = "packed"
    packages = cargo_command_packages(args.cargo, cargo_arguments, REPOSITORY_ROOT)
    if "ash-app-server-protocol" in packages:
        # Prepare outside Cargo's build lock; the exporter bootstraps without metadata.
        generate_protocol(root=REPOSITORY_ROOT, cargo=args.cargo)
    if args.deny_warnings:
        # Cargo replays cached diagnostics for this gate without changing rustc's
        # artifact identity, unlike appending -D warnings to RUSTFLAGS.
        environment["CARGO_BUILD_WARNINGS"] = "deny"
    needs_code_mode_host = (
        cargo_arguments[0] == "test"
        and "--no-run" not in cargo_arguments
        and "ASH_CODE_MODE_HOST_BIN" not in environment
        and "ash-code-mode" in packages
    )
    if needs_code_mode_host or "v8" in packages:
        environment.update(
            resolve_v8_cargo_env(
                TARGETS[target],
                environ=environment,
                lock_path=args.v8_lock.expanduser().resolve(),
                cache_root=args.v8_cache_root.expanduser().resolve(),
            )
        )
    if "sherpa-onnx-sys" in packages:
        environment.update(
            resolve_sherpa_cargo_env(TARGETS[target], environ=environment)
        )
    if (
        cargo_arguments[0] in {"test", "run"}
        and "ASH_TGREP_PATH" not in environment
        and (
            "ash-tgrep" in packages
            # The CLI starts a sibling App Server; its runtime inputs no longer appear in
            # the CLI's Cargo dependency graph.
            or "ash-cli" in packages
        )
    ):
        from build.lib.tgrep import resolve_tgrep

        executable = resolve_tgrep(
            TARGETS[target],
            REPOSITORY_ROOT / "third_party/tgrep/runtime-lock.json",
            REPOSITORY_ROOT / "third_party/.cache/tgrep",
        )
        environment["ASH_TGREP_PATH"] = str(executable.executable)
    with leased_cache(
        REPOSITORY_ROOT,
        profile=profile_from_arguments(cargo_arguments),
        target_triple=cargo_target(cargo_arguments),
    ):
        if needs_code_mode_host:
            environment["ASH_CODE_MODE_HOST_BIN"] = prepare_test_executable(
                args.cargo, cargo_arguments, environment, "ash-code-mode-host"
            )
        if (
            cargo_arguments[0] == "test"
            and "--no-run" not in cargo_arguments
            and "ASH_APP_SERVER_PATH" not in environment
            and "ash-remote-server" in packages
        ):
            environment["ASH_APP_SERVER_PATH"] = prepare_test_executable(
                args.cargo, cargo_arguments, environment, "ash-app-server"
            )
        if args.process_tests:
            # Windows Cargo owns a Job that forbids CREATE_BREAKAWAY_FROM_JOB. A process
            # lifecycle test must exercise the daemon's independent lifetime unchanged.
            return run_process_tests(args.cargo, cargo_arguments, environment)
        if (
            cargo_arguments[0] == "build"
            and profile_from_arguments(cargo_arguments) == "release"
            and environment.get("ASH_SYMBOLS_DIR")
        ):
            from build.release.symbols import capture_cargo_build

            return capture_cargo_build(
                [args.cargo, *cargo_arguments], REPOSITORY_ROOT, environment, target
            )
        return subprocess.run(
            [args.cargo, *cargo_arguments], cwd=REPOSITORY_ROOT, env=environment
        ).returncode


if __name__ == "__main__":
    raise SystemExit(main())
