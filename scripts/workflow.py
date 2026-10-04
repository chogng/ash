"""Run fixed repository workflows through the existing validation commands."""

from __future__ import annotations

import argparse
import fnmatch
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tomllib


ROOT = Path(__file__).resolve().parents[1]
FRONTMATTER = re.compile(r"\A---\n(.*?)\n---(?:\n|$)", re.S)


def repository_file(value: str, root: Path) -> Path:
    path = (root / value).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise ValueError(f"expected an existing repository file: {value}")
    return path


def workspace_packages(root: Path) -> dict[str, Path]:
    workspace = tomllib.loads((root / "Cargo.toml").read_text(encoding="utf-8"))[
        "workspace"
    ]
    excluded = workspace.get("exclude", [])
    packages = {}
    for member in workspace["members"]:
        for directory in sorted(root.glob(member)):
            if any(directory.match(pattern) for pattern in excluded):
                continue
            manifest = directory / "Cargo.toml"
            name = tomllib.loads(manifest.read_text(encoding="utf-8"))["package"][
                "name"
            ]
            packages[name] = manifest
    return packages


def owner(path: Path, packages: dict[str, Path]) -> str | None:
    matches = [
        (len(manifest.parent.parts), name)
        for name, manifest in packages.items()
        if path.is_relative_to(manifest.parent)
    ]
    return max(matches)[1] if matches else None


def frontmatter(path: Path) -> str:
    match = FRONTMATTER.match(path.read_text(encoding="utf-8"))
    if not match:
        raise ValueError(f"missing frontmatter: {path}")
    return match[1]


def field(header: str, name: str) -> str:
    match = re.search(rf"^{name}:\s*(.+)$", header, re.M)
    if not match:
        raise ValueError(f"missing {name} in frontmatter")
    return match[1].strip().strip("\"'")


def glob_matches(path: str, pattern: str) -> bool:
    """Match path segments; ** includes zero directories, while * never crosses /."""
    parts, patterns = path.split("/"), pattern.split("/")

    def match(i: int, j: int) -> bool:
        if j == len(patterns):
            return i == len(parts)
        if patterns[j] == "**":
            return match(i, j + 1) or (i < len(parts) and match(i + 1, j))
        return (
            i < len(parts)
            and fnmatch.fnmatchcase(parts[i], patterns[j])
            and match(i + 1, j + 1)
        )

    return match(0, 0)


def scope_patterns(scope: str) -> list[str]:
    # Expand brace alternatives before splitting the top-level comma-separated patterns.
    if alternative := re.search(r"\{([^{}]+)\}", scope):
        return list(
            dict.fromkeys(
                pattern
                for choice in alternative[1].split(",")
                for pattern in scope_patterns(
                    scope[: alternative.start()] + choice + scope[alternative.end() :]
                )
            )
        )
    return [pattern.strip() for pattern in scope.split(",")]


def context(path: Path, root: Path) -> None:
    paths = [path]
    if path.name.endswith((".snap", ".snap.new")):
        paths.append(repository_file(field(frontmatter(path), "source"), root))
    packages = workspace_packages(root)
    print("Files:")
    for target in paths:
        print(f"  {target.relative_to(root)}")
        if package := owner(target, packages):
            print(f"    Cargo package: {package}")
            print(f"    Validation: just verify {package}")
    instructions = []
    directories = {
        parent
        for target in paths
        for parent in target.parents
        if parent.is_relative_to(root)
    }
    for directory in sorted(directories, key=lambda item: (len(item.parts), str(item))):
        if (directory / "AGENTS.md").is_file():
            instructions.append(directory / "AGENTS.md")
    instructions.append(root / ".github/copilot-instructions.md")
    for instruction in sorted((root / ".github/instructions").glob("*.md")):
        header = FRONTMATTER.match(instruction.read_text(encoding="utf-8"))
        if not header:
            continue
        scope = re.search(r"^applyTo:\s*(.+)$", header[1], re.M)
        if not scope:
            continue
        patterns = scope_patterns(scope[1].strip().strip("\"'"))
        if any(
            glob_matches(target.relative_to(root).as_posix(), pattern.strip())
            for target in paths
            for pattern in patterns
        ):
            instructions.append(instruction)
    print("Instructions:")
    for instruction in instructions:
        print(f"  {instruction.relative_to(root)}")
    # Skill links belong to the instructions; do not maintain a second routing table.
    skills = set()
    for instruction in instructions:
        for link in re.findall(
            r"\]\(([^)]+SKILL\.md)\)", instruction.read_text(encoding="utf-8")
        ):
            skill = (instruction.parent / link).resolve()
            label = os.path.relpath(skill, root)
            skills.add(label + (" (missing)" if not skill.is_file() else ""))
    print("Skills referenced by these instructions (check their scope before use):")
    for skill in sorted(skills):
        print(f"  {skill}")
    if path.name.endswith((".snap", ".snap.new")):
        print(
            f"Snapshot workflow: just snapshot {shlex.quote(str(path.relative_to(root)))}"
        )


def run(command: list[str], root: Path, **kwargs) -> subprocess.CompletedProcess:
    print(f"$ {shlex.join(command)}", flush=True)
    return subprocess.run(command, cwd=root, check=False, **kwargs)


def run_test(
    command: list[str], root: Path, environment: dict[str, str] | None = None
) -> int:
    result = run(command, root, env=environment, stdout=subprocess.PIPE, text=True)
    print(result.stdout, end="", flush=True)
    if result.returncode:
        return result.returncode
    passed = sum(
        int(count)
        for count in re.findall(r"test result: ok\. (\d+) passed;", result.stdout)
    )
    if not passed:
        print(
            "No tests passed; check the filter, features, and ignored-test attributes.",
            file=sys.stderr,
        )
        return 1
    return 0


def verify(args: argparse.Namespace, root: Path) -> int:
    if args.package not in workspace_packages(root):
        raise ValueError(f"unknown workspace package: {args.package}")
    settings = ["--profile", args.profile]
    if args.features:
        settings += ["--features", args.features]
    commands = [
        ["just", "check", args.package, *settings],
        [
            "just",
            "test",
            args.package,
            *settings,
            *([args.filter] if args.filter else []),
        ],
        ["just", "rust-warnings", args.package, *settings],
    ]
    for command in commands:
        if args.plan:
            print(shlex.join(command))
        elif result := (
            run_test(command, root)
            if command[1] == "test"
            else run(command, root).returncode
        ):
            print(f"Verification stopped: {command[1]} exited with {result}")
            return result
    if not args.plan:
        print(f"Verification passed: {args.package} (check, test, rust-warnings)")
    return 0


def rust_tokens(source: str) -> list[str]:
    """Keep strings atomic so comments and fixture text cannot look like Rust calls."""
    token = re.compile(
        r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])\'|[A-Za-z_]\w*|[^\s]', re.S
    )
    raw_string = re.compile(r'r(#+)?"')
    tokens = []
    i = 0
    while i < len(source):
        if source[i].isspace():
            i += 1
        elif source.startswith("//", i):
            end = source.find("\n", i)
            i = len(source) if end < 0 else end
        elif source.startswith("/*", i):
            depth = 1
            i += 2
            while depth:
                if i >= len(source):
                    raise ValueError("unterminated Rust comment")
                if source.startswith("/*", i):
                    depth += 1
                    i += 2
                elif source.startswith("*/", i):
                    depth -= 1
                    i += 2
                else:
                    i += 1
        elif raw := raw_string.match(source, i):
            end_marker = '"' + (raw[1] or "")
            end = source.find(end_marker, raw.end())
            if end < 0:
                raise ValueError("unterminated Rust raw string")
            tokens.append(source[i : end + len(end_marker)])
            i = end + len(end_marker)
        else:
            match = token.match(source, i)
            tokens.append(match[0])
            i = match.end()
    return tokens


def group_end(tokens: list[str], start: int) -> int:
    closing = {"(": ")", "[": "]", "{": "}"}
    stack = [closing[tokens[start]]]
    for i in range(start + 1, len(tokens)):
        if tokens[i] in closing:
            stack.append(closing[tokens[i]])
        elif tokens[i] == stack[-1]:
            stack.pop()
            if not stack:
                return i
    raise ValueError("unclosed Rust token group")


def snapshot_function(source: str, name: str) -> str:
    tokens = rust_tokens(source)
    matches = set()
    for i, token in enumerate(tokens[:-2]):
        if token != "fn" or not re.fullmatch(r"[A-Za-z_]\w*", tokens[i + 1]):
            continue
        body = next(
            (j for j in range(i + 2, len(tokens)) if tokens[j] in {"{", ";"}), None
        )
        if body is None or tokens[body] == ";":
            continue
        end = group_end(tokens, body)
        for j in range(body + 1, end - 2):
            if tokens[j : j + 3] != ["tui_assert_snapshot", "!", "("]:
                continue
            first = j + 3
            if tokens[first] in {"app", "mode"} and tokens[first + 1] == "=":
                first = tokens.index(";", first, group_end(tokens, j + 2)) + 1
            if tokens[first : first + 2] == [f'"{name}"', ","]:
                matches.add(tokens[i + 1])
    if len(matches) != 1:
        raise ValueError(
            f"expected one function with a literal tui_assert_snapshot name {name!r}; found {sorted(matches)}"
        )
    return matches.pop()


def snapshot(args: argparse.Namespace, root: Path) -> int:
    directory = root / "code/tui/snapshots"
    if args.pending and args.accept:
        raise ValueError("--accept requires explicit reviewed paths; omit --pending")
    if not args.paths and not args.pending:
        raise ValueError("provide snapshot paths or --pending")
    initial_pending = set(directory.rglob("*.snap.new"))
    paths = [repository_file(value, root) for value in args.paths]
    if args.pending:
        paths += sorted(initial_pending)
    if not paths:
        print("No pending TUI snapshots.")
        return 0
    # Screen modes can share an assertion and owning test. Group before compiling or accepting.
    groups: dict[tuple[Path, str], list[Path]] = {}
    baselines = set()
    for path in paths:
        baseline = Path(str(path).removesuffix(".new"))
        if baseline.suffix != ".snap" or not baseline.is_relative_to(directory):
            raise ValueError(
                "snapshot workflow supports external code/tui/snapshots/*.snap files"
            )
        if baseline in baselines:
            continue
        source = repository_file(field(frontmatter(path), "source"), root)
        if not source.is_relative_to(root / "code/tui/src"):
            raise ValueError("snapshot source must belong to code/tui/src")
        function = snapshot_function(source.read_text(encoding="utf-8"), baseline.stem)
        groups.setdefault((source, function), []).append(baseline)
        baselines.add(baseline)
    selected_pending = [
        Path(str(baseline) + ".new") for group in groups.values() for baseline in group
    ]
    if args.accept:
        for pending in selected_pending:
            if not pending.is_file():
                raise ValueError(
                    f"no pending snapshot to accept: {pending.relative_to(root)}"
                )
    command = ["just", "test-tui-unit"]
    settings = ["--features", args.features] if args.features else []
    listing_command = [*command, *settings, "--", "--list"]
    for (source, function), group in groups.items():
        print(f"Source: {source.relative_to(root)}\nFunction: {function}")
        for baseline in group:
            print(f"  {baseline.relative_to(root)}")
    if args.plan:
        print(shlex.join(listing_command))
        for _, function in groups:
            print(
                f"Resolve compiled test for {function}, then run with --exact --nocapture"
            )
        return 0
    # Do not inherit settings that can overwrite baselines or turn failed assertions green.
    environment = {
        key: value for key, value in os.environ.items() if not key.startswith("INSTA_")
    }
    listing = run(
        listing_command,
        root,
        env=environment,
        stdout=subprocess.PIPE,
        text=True,
    )
    if listing.returncode:
        print(listing.stdout, end="")
        return listing.returncode
    names = re.findall(r"^(\S+): test$", listing.stdout, re.M)
    tests = []
    for _, function in groups:
        matching = [name for name in names if name.rsplit("::", 1)[-1] == function]
        if len(matching) != 1:
            raise ValueError(
                f"expected exactly one compiled test for {function}; found {matching}"
            )
        tests.append(matching[0])
    if len(set(tests)) != len(tests):
        raise ValueError(
            "different snapshot sources resolved to the same compiled test"
        )
    if args.accept:
        # Show the complete explicit selection before changing any baseline.
        for pending in selected_pending:
            if result := run(
                ["cargo", "insta", "show", str(pending)], root, env=environment
            ).returncode:
                return result
        for baseline in (baseline for group in groups.values() for baseline in group):
            if result := run(
                [
                    "cargo",
                    "insta",
                    "accept",
                    "--snapshot",
                    baseline.relative_to(root).as_posix(),
                ],
                root,
                env=environment,
            ).returncode:
                return result
    result = 0
    for test in tests:
        status = run_test(
            [*command, test, *settings, "--", "--exact", "--nocapture"],
            root,
            environment if args.accept else {**environment, "INSTA_UPDATE": "new"},
        )
        print(f"Test: {test} (exit {status})")
        result = result or status
    pending_files = sorted(directory.rglob("*.snap.new"))
    if pending_files:
        print("Pending snapshots:")
        for pending in pending_files:
            print(f"  {pending.relative_to(root)}")
        # Include additional baselines emitted by the selected tests, without reviewing
        # unrelated pending files that were already present before this run.
        review = set(selected_pending) | (set(pending_files) - initial_pending)
        for pending in pending_files:
            if pending not in review:
                continue
            shown = run(
                ["cargo", "insta", "show", str(pending)], root, env=environment
            ).returncode
            baseline = Path(str(pending).removesuffix(".new"))
            print(
                f"After reviewing this file: just snapshot {shlex.quote(str(baseline.relative_to(root)))} --accept"
            )
            result = result or shown
        return result or 1
    return result


def main(arguments: list[str] | None = None, root: Path = ROOT) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="workflow", required=True)
    inspect = commands.add_parser(
        "context", help="show applicable instructions, linked skills, and Cargo owner"
    )
    inspect.add_argument("path")
    validation = commands.add_parser(
        "verify", help="check, test, and deny warnings for one workspace package"
    )
    validation.add_argument("package")
    validation.add_argument("--filter", help="Cargo test-name filter")
    validation.add_argument(
        "--profile", default="ci-test", help="shared Cargo profile (default: ci-test)"
    )
    validation.add_argument(
        "--features", help="Cargo feature selection for all three steps"
    )
    validation.add_argument(
        "--plan", action="store_true", help="print commands without running them"
    )
    snapshots = commands.add_parser(
        "snapshot", help="group named TUI snapshots and run each owning test once"
    )
    snapshots.add_argument(
        "paths",
        nargs="*",
        help="repository-relative or absolute .snap / .snap.new paths",
    )
    snapshots.add_argument(
        "--pending",
        action="store_true",
        help="include all pending TUI snapshots for review",
    )
    snapshots.add_argument("--features", help="e.g. in-process-tests")
    mode = snapshots.add_mutually_exclusive_group()
    mode.add_argument(
        "--plan",
        action="store_true",
        help="resolve the source function without compiling",
    )
    mode.add_argument(
        "--accept",
        action="store_true",
        help="accept only the explicitly listed reviewed pending snapshots, then rerun",
    )
    args = parser.parse_args(arguments)
    try:
        if args.workflow == "context":
            context(repository_file(args.path, root), root)
            return 0
        if args.workflow == "verify":
            return verify(args, root)
        return snapshot(args, root)
    except (ValueError, OSError) as error:
        print(f"{args.workflow}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
