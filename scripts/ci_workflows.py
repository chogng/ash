"""Select Ash's reusable CI workflows and require their declared results."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys

from check_blob_size import changed_paths


ROOT = Path(__file__).resolve().parents[1]
POLICY = ROOT / ".github/ci-workflows.json"
CONTROL_PATHS = {
    ".github/ci-workflows.json",
    ".github/workflows/blocking-ci.yml",
    "scripts/ci_workflows.py",
    "scripts/test_ci_workflows.py",
    "scripts/check_blob_size.py",
}


def load_policy(path: Path) -> dict[str, list[str] | None]:
    policy = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(policy, dict) or not policy:
        raise ValueError("CI policy must be a nonempty workflow mapping")
    for name, patterns in policy.items():
        if not re.fullmatch(r"[a-z][a-z0-9-]*", name) or name in {"select", "required"}:
            raise ValueError(f"invalid workflow name: {name!r}")
        if patterns is not None and (
            not isinstance(patterns, list)
            or not patterns
            or not all(isinstance(pattern, str) and pattern for pattern in patterns)
        ):
            raise ValueError(
                f"{name}: paths must be a nonempty list, or null for every run"
            )
    return policy


def matches(pattern: str, path: str) -> bool:
    # The policy uses GitHub-style *, ** and ?; a single * never crosses '/'.
    expression = []
    index = 0
    while index < len(pattern):
        if pattern[index : index + 3] == "**/":
            expression.append("(?:.*/)?")
            index += 3
        elif pattern[index : index + 2] == "**":
            expression.append(".*")
            index += 2
        else:
            char = pattern[index]
            expression.append(
                "[^/]*" if char == "*" else "[^/]" if char == "?" else re.escape(char)
            )
            index += 1
    return re.fullmatch("".join(expression), path) is not None


def select(paths: list[str], policy: dict, force_all: bool = False) -> dict[str, bool]:
    if not all(isinstance(path, str) and path for path in paths):
        raise ValueError("changed files must be nonempty paths")
    force_all = force_all or bool(CONTROL_PATHS.intersection(paths))
    return {
        name: force_all
        or patterns is None
        or any(matches(pattern, path) for pattern in patterns for path in paths)
        for name, patterns in policy.items()
    }


def require_results(needs: dict, selection: dict, policy: dict) -> list[str]:
    if not isinstance(selection, dict) or set(selection) != set(policy):
        raise ValueError("selection must include exactly the configured workflows")
    if not all(type(value) is bool for value in selection.values()):
        raise ValueError("selection values must be booleans")
    if not isinstance(needs, dict) or set(needs) != {"select", *policy}:
        raise ValueError("needs must include selection and every configured workflow")
    failures = []
    for name, dependency in needs.items():
        result = dependency.get("result") if isinstance(dependency, dict) else None
        if name == "select" or selection[name]:
            expected = "success"
        else:
            # A skipped job is accepted only when the successful selector explicitly
            # excluded it. A failure or cancellation is never a permitted skip.
            expected = "skipped"
        if result != expected:
            failures.append(f"{name}: expected {expected}, got {result!r}")
        if name != "select" and policy[name] is None and not selection[name]:
            failures.append(f"{name}: an always-required workflow was excluded")
    return failures


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--policy", type=Path, default=POLICY)
    subparsers = parser.add_subparsers(dest="operation", required=True)
    selection_parser = subparsers.add_parser("select")
    selection_parser.add_argument("--base")
    selection_parser.add_argument("--head", default="HEAD")
    selection_parser.add_argument("--all", action="store_true")
    subparsers.add_parser("require")
    args = parser.parse_args(arguments)
    try:
        policy = load_policy(args.policy)
        if args.operation == "select":
            paths = changed_paths(ROOT, args.base, args.head)
            selection = select(paths, policy, args.all)
            serialized = json.dumps(selection, separators=(",", ":"))
            print(serialized)
            if output := os.environ.get("GITHUB_OUTPUT"):
                with open(output, "a", encoding="utf-8") as stream:
                    stream.write(f"selection={serialized}\n")
        else:
            failures = require_results(
                json.loads(os.environ["NEEDS_JSON"]),
                json.loads(os.environ["CI_SELECTION_JSON"]),
                policy,
            )
            for failure in failures:
                print(failure, file=sys.stderr)
            if failures:
                return 1
            print(
                "All required CI workflows succeeded; only explicitly unneeded jobs were skipped"
            )
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f"CI workflow check failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
