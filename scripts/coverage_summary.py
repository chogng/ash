#!/usr/bin/env python3
"""Report instrumented, explicitly scoped LCOV line/branch coverage."""

import os
import sys
from pathlib import Path


def accepts(filename: str, scope: str) -> bool:
    name = "/" + filename.replace("\\", "/").lstrip("/")
    if scope == "typescript":
        return (
            "/src/ash/" in name
            and name.endswith(".ts")
            and "/test/" not in name
            and not name.endswith(".test.ts")
        )
    if scope == "rust":
        return name.endswith(".rs") and any(
            root in name for root in ("/crates/protocol/src/", "/crates/keybinding/src/")
        )
    raise ValueError(f"Unknown coverage scope: {scope}")


def summarize(scope: str, input_file: Path) -> str:
    if not input_file.is_file():
        raise ValueError(f"LCOV report is missing: {input_file}")
    lines: dict[tuple[str, int], bool] = {}
    branches: dict[tuple[str, str, str, str], bool] = {}
    sources: set[str] = set()
    current: str | None = None
    for row in input_file.read_text(encoding="utf-8").splitlines():
        if row.startswith("SF:"):
            candidate = row[3:].replace("\\", "/")
            current = candidate if accepts(candidate, scope) else None
            if current is not None:
                sources.add(current)
        elif row.startswith("DA:") and current is not None:
            position, hits, *_ = row[3:].split(",")
            key = (current, int(position))
            lines[key] = lines.get(key, False) or int(hits) > 0
        elif row.startswith("BRDA:") and current is not None:
            position, block, branch, hits = row[5:].split(",")
            key = (current, position, block, branch)
            branches[key] = branches.get(key, False) or (hits != "-" and int(hits) > 0)
        elif row == "end_of_record":
            current = None

    if not sources or not lines:
        raise ValueError(f"No instrumented {scope} source lines in {input_file}; check source-map remapping and scope")
    line_hits = sum(lines.values())
    branch_hits = sum(branches.values())
    label = "TypeScript (compiled unit-test scope)" if scope == "typescript" else "Rust (ash-protocol + ash-keybinding)"
    summary = (
        f"### {label}\n\n"
        f"- Line coverage: **{100 * line_hits / len(lines):.2f}%** "
        f"({line_hits}/{len(lines)} instrumented lines)\n"
        f"- Branch coverage: "
        + (
            f"**{100 * branch_hits / len(branches):.2f}%** ({branch_hits}/{len(branches)} branches)"
            if branches else "not reported by this tool"
        )
        + f"\n- Source files: {len(sources)}\n\n"
        + "This result describes only the stated measurement scope, not the whole Ash repository.\n"
    )
    print(summary)
    if summary_file := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(summary_file, "a", encoding="utf-8") as output:
            output.write(summary + "\n")
    return summary


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: coverage_summary.py <typescript|rust> <lcov.info>")
    try:
        summarize(sys.argv[1], Path(sys.argv[2]))
    except (ValueError, OSError) as error:
        raise SystemExit(str(error)) from error
