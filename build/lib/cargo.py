"""Shared Cargo output paths, executable artifacts, and compiler diagnostics."""

import json
import os
from pathlib import Path
from typing import Any, Dict, Mapping, Optional


def resolve_cargo_target_directory(
    repository_root: Path,
    environment: Optional[Mapping[str, str]] = None,
) -> Path:
    selected_environment = os.environ if environment is None else environment
    configured = selected_environment.get("CARGO_TARGET_DIR", "").strip()
    if not configured:
        return (repository_root / ".build" / "cargo").resolve()
    target_directory = Path(configured).expanduser()
    if not target_directory.is_absolute():
        target_directory = repository_root / target_directory
    return target_directory.resolve()


def cargo_profile_directory(profile: str) -> str:
    if profile == "dev":
        return "debug"
    return profile


def parse_cargo_message(line: str) -> Optional[Dict[str, Any]]:
    try:
        message = json.loads(line)
    except (json.JSONDecodeError, TypeError):
        return None
    return message if isinstance(message, dict) else None


def cargo_artifact_executable(
    message: Optional[Mapping[str, Any]], target_name: str
) -> Optional[str]:
    if message is None or message.get("reason") != "compiler-artifact":
        return None
    target = message.get("target")
    if not isinstance(target, dict) or target.get("name") != target_name:
        return None
    kinds = target.get("kind")
    executable = message.get("executable")
    if (
        not isinstance(kinds, list)
        or "bin" not in kinds
        or not isinstance(executable, str)
    ):
        return None
    return executable


def cargo_rendered_diagnostic(
    message: Optional[Mapping[str, Any]],
) -> Optional[str]:
    if message is None or message.get("reason") != "compiler-message":
        return None
    diagnostic = message.get("message")
    if not isinstance(diagnostic, dict):
        return None
    rendered = diagnostic.get("rendered")
    return rendered if isinstance(rendered, str) else None
