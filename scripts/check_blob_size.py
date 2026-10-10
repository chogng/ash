"""Enforce reviewed size budgets on Git blobs changed by a candidate revision."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
POLICY = ROOT / ".github/blob-size-policy.json"


def git(root: Path, *arguments: str) -> bytes:
    return subprocess.check_output(["git", *arguments], cwd=root)


def changed_paths(root: Path, base: str | None, head: str) -> list[str]:
    # A new branch has no before revision. Inspect its whole tree, not just its tip.
    if not base or set(base) == {"0"}:
        arguments = ("ls-tree", "-r", "--name-only", "-z", head)
    else:
        # Renames count as additions at the destination; budgets belong to exact paths.
        arguments = (
            "diff",
            "--name-only",
            "--no-renames",
            "--diff-filter=AMDT",
            "-z",
            base,
            head,
            "--",
        )
    return [path.decode("utf-8") for path in git(root, *arguments).split(b"\0") if path]


def load_policy(path: Path) -> dict:
    policy = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(policy, dict) or set(policy) != {"max_bytes", "exceptions"}:
        raise ValueError("blob policy must define max_bytes and exceptions")
    if type(policy["max_bytes"]) is not int or policy["max_bytes"] <= 0:
        raise ValueError("max_bytes must be a positive integer")
    if not isinstance(policy["exceptions"], dict):
        raise ValueError("exceptions must be an exact-path mapping")
    for name, exception in policy["exceptions"].items():
        if (
            not name
            or name.startswith("/")
            or "\\" in name
            or any(part in {"", ".", ".."} for part in name.split("/"))
            or any(char in name for char in "*?[]")
        ):
            raise ValueError(f"invalid exception path: {name!r}")
        if not isinstance(exception, dict) or set(exception) != {"max_bytes", "reason"}:
            raise ValueError(f"{name}: exception requires max_bytes and reason")
        if (
            type(exception["max_bytes"]) is not int
            or exception["max_bytes"] <= policy["max_bytes"]
        ):
            raise ValueError(f"{name}: exception budget must exceed the default")
        if not isinstance(exception["reason"], str) or not exception["reason"].strip():
            raise ValueError(f"{name}: exception must explain the checked-in asset")
    return policy


def check(root: Path, base: str | None, head: str, policy: dict) -> list[str]:
    changed = set(changed_paths(root, base, head))
    violations = []
    checked = 0
    # Read sizes and object types in one Git call. Deleted paths and submodules
    # have no candidate blob; filenames remain NUL-delimited throughout.
    for entry in git(root, "ls-tree", "-r", "-l", "-z", head).split(b"\0"):
        if not entry:
            continue
        metadata, name = entry.split(b"\t", 1)
        name = name.decode("utf-8")
        fields = metadata.split()
        if name not in changed or fields[1] != b"blob":
            continue
        checked += 1
        size = int(fields[3])
        budget = policy["exceptions"].get(name, policy)["max_bytes"]
        if size > budget:
            violations.append(f"{name!r}: {size} bytes exceeds {budget} bytes")
    print(f"Checked {checked} changed Git blobs; {len(violations)} size violations")
    return violations


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--policy", type=Path, default=POLICY)
    parser.add_argument("--base")
    parser.add_argument("--head", default="HEAD")
    args = parser.parse_args(arguments)
    try:
        violations = check(args.root, args.base, args.head, load_policy(args.policy))
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"Blob size check failed: {error}", file=sys.stderr)
        return 1
    for violation in violations:
        print(violation, file=sys.stderr)
    return int(bool(violations))


if __name__ == "__main__":
    raise SystemExit(main())
