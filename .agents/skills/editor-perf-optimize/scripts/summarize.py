#!/usr/bin/env python3
"""Validate editor readiness samples against finalized Ash scenario evidence."""

import argparse
import json
import math
from pathlib import Path


def number(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def distribution(values):
    ordered = sorted(values)
    return {
        "count": len(ordered),
        "min": ordered[0],
        "p50": ordered[math.ceil(len(ordered) * 0.50) - 1],
        "p95": ordered[math.ceil(len(ordered) * 0.95) - 1],
        "max": ordered[-1],
    }


def summarize(data, manifest, expected):
    reasons = []
    results = []
    if manifest.get("outcome") != "passed":
        reasons.append("scenario outcome is not passed")
    steps = manifest.get("steps")
    if not isinstance(steps, list) or not steps:
        reasons.append("scenario has no finalized steps")
    else:
        for step in steps:
            captures = step.get("captures", [])
            if not captures or captures[-1].get("status") != "passed":
                reasons.append(f"scenario step {step.get('id', '?')} did not pass")
    for key in ("runtimeErrors", "errors"):
        if data.get(key) != []:
            reasons.append(f"{key} must be present and empty")
    files = data.get("files")
    if not isinstance(files, list) or not files:
        return {"valid": False, "reasons": reasons + ["no file samples"], "files": []}
    seen = set()
    for file in files:
        name = file.get("name")
        if not isinstance(name, str) or not name or name in seen:
            reasons.append("file names must be nonempty and unique")
            continue
        seen.add(name)
        edits = file.get("edits")
        if not isinstance(edits, list):
            reasons.append(f"{name}: missing edits array")
            continue
        if len(edits) != expected:
            reasons.append(f"{name}: expected {expected} edits, got {len(edits)}")
        timings = {key: [] for key in ("domMs", "frameMs", "factsMs", "readyMs")}
        for index, edit in enumerate(edits):
            prefix = f"{name} edit {index + 1}"
            times = [edit.get(key) for key in ("armed", "inputAt", "dom", "frame", "facts")]
            if not all(number(t) for t in times):
                reasons.append(f"{prefix}: missing/invalid timestamp")
                continue
            armed, start, dom, frame, facts = times
            if not (armed <= start <= dom <= frame and start <= facts):
                reasons.append(f"{prefix}: endpoints precede their causal input/DOM")
                continue
            operation = edit.get("operation")
            inputs = edit.get("inputs", [])
            matched = any(
                event.get("at") == start
                and (
                    operation == "insert" and event.get("type") == "textupdate"
                    or operation == "undo" and event.get("type") == "keydown"
                    and str(event.get("key", "")).lower() == "z"
                ) for event in inputs
            )
            previous = edit.get("previous")
            matching_facts = any(
                event.get("name") == "ash.treeSitter.facts"
                and number(event.get("at")) and start <= event["at"] <= facts
                and event.get("detail", {}).get("completed") is True
                and number(event.get("detail", {}).get("version"))
                and number(previous)
                and event["detail"]["version"] > previous
                and event.get("detail", {}).get("model", "").endswith("/" + name)
                for event in edit.get("events", [])
            )
            if not matched or not matching_facts:
                reasons.append(f"{prefix}: missing causal input or newer completed document facts")
                continue
            for key, end in (("domMs", dom), ("frameMs", frame), ("factsMs", facts), ("readyMs", max(frame, facts))):
                timings[key].append(end - start)
        results.append({
            "name": name,
            "recordedEdits": len(edits),
            "validEdits": len(timings["readyMs"]),
            "timings": {key: distribution(values) for key, values in timings.items() if values},
        })
    return {"valid": not reasons, "reasons": reasons, "files": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("samples", type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--expected-edits", required=True, type=int)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.expected_edits < 1:
        parser.error("--expected-edits must be positive")
    if args.output and args.output.resolve() in (args.samples.resolve(), args.manifest.resolve()):
        parser.error("output must not overwrite raw evidence")
    try:
        data = json.loads(args.samples.read_text())
        manifest = json.loads(args.manifest.read_text())
        report = summarize(data, manifest, args.expected_edits)
    except (OSError, ValueError, TypeError, AttributeError, KeyError) as error:
        report = {"valid": False, "reasons": [f"invalid evidence: {error}"], "files": []}
    report.update({"samples": str(args.samples.resolve()), "manifest": str(args.manifest.resolve())})
    rendered = json.dumps(report, indent=2, allow_nan=False) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered)
    print(rendered, end="")
    return 0 if report["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
