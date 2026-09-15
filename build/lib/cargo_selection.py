"""Inspect the selected Cargo dependency graph before configuring V8."""

from __future__ import annotations

import subprocess
from pathlib import Path


DEPENDENCY_COMMANDS = {
    "bench",
    "build",
    "check",
    "clippy",
    "doc",
    "run",
    "rustc",
    "rustdoc",
    "test",
}

VALUE_OPTIONS = {
    "--config",
    "--exclude",
    "--features",
    "--manifest-path",
    "--package",
    "--target",
    "-F",
    "-Z",
    "-p",
}

FLAG_OPTIONS = {
    "--all",
    "--all-features",
    "--frozen",
    "--locked",
    "--no-default-features",
    "--offline",
    "--workspace",
}

LONG_VALUE_OPTIONS = {option for option in VALUE_OPTIONS if option.startswith("--")}
SHORT_VALUE_OPTIONS = {
    option
    for option in VALUE_OPTIONS
    if option.startswith("-") and not option.startswith("--")
}


def cargo_command_uses_v8(
    cargo: str,
    cargo_arguments: list[str],
    repository_root: Path,
) -> bool:
    """Return whether the packages selected by a Cargo command depend on V8."""

    if not cargo_arguments or cargo_arguments[0] not in DEPENDENCY_COMMANDS:
        return False

    command = [
        cargo,
        "tree",
        "--edges",
        "normal,build,dev",
        "--prefix",
        "none",
        "--format",
        "{p}",
        *cargo_tree_selection_arguments(cargo_arguments[1:]),
    ]
    result = subprocess.run(
        command,
        cwd=repository_root,
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    )
    return any(line.partition(" ")[0] == "v8" for line in result.stdout.splitlines())


def cargo_tree_selection_arguments(arguments: list[str]) -> list[str]:
    """Keep Cargo arguments that can change package or dependency selection."""

    selected: list[str] = []
    index = 0
    while index < len(arguments):
        argument = arguments[index]
        if argument == "--":
            break
        if argument in FLAG_OPTIONS:
            selected.append(argument)
            index += 1
            continue
        if argument in VALUE_OPTIONS:
            if index + 1 >= len(arguments):
                selected.append(argument)
                break
            selected.extend((argument, arguments[index + 1]))
            index += 2
            continue
        if any(argument.startswith(f"{option}=") for option in LONG_VALUE_OPTIONS):
            selected.append(argument)
            index += 1
            continue
        if any(
            argument.startswith(option) and argument != option
            for option in SHORT_VALUE_OPTIONS
        ):
            selected.append(argument)
        index += 1
    return selected
