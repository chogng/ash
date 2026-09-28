#!/usr/bin/env python3
"""Compare two Desktop startup trace reports without hiding failed launches."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import statistics
import sys


COHORTS = ("fresh", "stopped", "reused", "ui-only")
CONDITIONS = (
    "platform",
    "architecture",
    "workbenchMode",
    "workspace",
    "credentialFixture",
    "readiness",
    "measurement",
    "cache",
    "profileState",
)
V2_CONDITIONS = ("osRelease", "cpuModel", "cpuCount", "milestoneClock")
V3_CONDITIONS = ("rendererClock",)
STAGES = (
    ("launch-requested", "electron-launch-resolved"),
    ("electron-launch-resolved", "first-window"),
    ("first-window", "workbench-ready"),
)
RENDERER_STAGES = (
    ("response-end", "ash.desktop.open-start"),
    ("ash.desktop.contributions-start", "ash.desktop.contributions-ready"),
    ("ash.rendererApi.start", "ash.rendererApi.acquire-start"),
    ("ash.rendererApi.acquire-start", "ash.rendererApi.acquired"),
    ("ash.rendererApi.acquired", "ash.rendererApi.initialized"),
    ("ash.rendererApi.initialized", "ash.rendererApi.workspace-initialized"),
    ("ash.desktop.open-start", "ash.desktop.api-ready"),
    ("ash.desktop.api-ready", "ash.desktop.themes-ready"),
    ("ash.desktop.themes-ready", "ash.desktop.workspace-ready"),
    ("ash.desktop.workspace-ready", "ash.desktop.configuration-ready"),
    ("ash.workbench.constructor-start", "ash.workbench.services-ready"),
    ("ash.workbench.services-ready", "ash.workbench.shell-ready"),
    ("ash.workbench.shell-ready", "ash.workbench.views-restored"),
    ("ash.workbench.views-restored", "ash.workbench.constructor-done"),
    ("ash.desktop.workbench-start", "ash.desktop.workbench-created"),
    ("ash.desktop.workbench-created", "ash.desktop.lifecycle-ready"),
)
REQUIRED_RENDERER_MARKS = (
    "ash.desktop.contributions-start",
    "ash.desktop.contributions-ready",
    "ash.desktop.open-start",
    "ash.rendererApi.start",
    "ash.rendererApi.acquire-start",
    "ash.rendererApi.acquired",
    "ash.desktop.api-ready",
    "ash.desktop.themes-ready",
    "ash.desktop.workspace-ready",
    "ash.desktop.configuration-ready",
    "ash.desktop.workbench-start",
    "ash.workbench.constructor-start",
    "ash.workbench.services-ready",
    "ash.workbench.shell-ready",
    "ash.workbench.views-restored",
    "ash.workbench.constructor-done",
    "ash.desktop.workbench-created",
    "ash.desktop.lifecycle-ready",
)
CONNECTED_RENDERER_MARKS = ("ash.rendererApi.initialized", "ash.rendererApi.workspace-initialized")


def validate(report: dict, label: str) -> dict[str, list[dict]]:
    if report.get("schemaVersion") not in (1, 2, 3):
        raise ValueError(f"{label}: unsupported schemaVersion")
    metadata = report.get("metadata")
    required = CONDITIONS + (V2_CONDITIONS if report["schemaVersion"] >= 2 else ()) + (V3_CONDITIONS if report["schemaVersion"] == 3 else ())
    if not isinstance(metadata, dict) or any(key not in metadata for key in required):
        raise ValueError(f"{label}: missing measurement conditions")
    samples = report.get("samples")
    if not isinstance(samples, list):
        raise ValueError(f"{label}: missing samples")
    grouped: dict[str, list[dict]] = {cohort: [] for cohort in COHORTS}
    for sample in samples:
        if not isinstance(sample, dict) or sample.get("cohort") not in grouped:
            raise ValueError(f"{label}: invalid sample cohort")
        cohort = sample["cohort"]
        index = sample.get("index")
        ready = sample.get("readyMs")
        if (
            not isinstance(index, int)
            or isinstance(index, bool)
            or index < 0
            or (ready is not None and (not isinstance(ready, (int, float)) or isinstance(ready, bool) or ready < 0))
        ):
            raise ValueError(f"{label}: invalid sample index or duration in {cohort}")
        if report["schemaVersion"] >= 2:
            milestones = sample.get("milestones")
            if not isinstance(milestones, list) or not milestones:
                raise ValueError(f"{label}: missing milestones in {cohort}[{index}]")
            previous = -1
            phases = set()
            for milestone in milestones:
                if not isinstance(milestone, dict):
                    raise ValueError(f"{label}: invalid milestone in {cohort}[{index}]")
                phase, elapsed = milestone.get("phase"), milestone.get("elapsedMs")
                if (
                    not isinstance(phase, str)
                    or phase in phases
                    or not isinstance(elapsed, (int, float))
                    or isinstance(elapsed, bool)
                    or elapsed < previous
                ):
                    raise ValueError(f"{label}: invalid milestone order in {cohort}[{index}]")
                phases.add(phase)
                previous = elapsed
            if milestones[0] != {"phase": "launch-requested", "elapsedMs": 0}:
                raise ValueError(f"{label}: invalid launch origin in {cohort}[{index}]")
        if report["schemaVersion"] == 3 and not sample.get("error"):
            renderer = sample.get("renderer")
            if not isinstance(renderer, dict):
                raise ValueError(f"{label}: missing renderer timings in {cohort}[{index}]")
            response_end, marks = renderer.get("responseEndMs"), renderer.get("marks")
            if (not isinstance(response_end, (int, float)) or isinstance(response_end, bool) or response_end < 0 or not isinstance(marks, list)):
                raise ValueError(f"{label}: invalid renderer timings in {cohort}[{index}]")
            names = set()
            for mark in marks:
                if (not isinstance(mark, dict) or not isinstance(mark.get("name"), str) or mark["name"] in names
                    or not isinstance(mark.get("startTimeMs"), (int, float)) or isinstance(mark["startTimeMs"], bool)
                    or mark["startTimeMs"] < 0):
                    raise ValueError(f"{label}: invalid renderer mark in {cohort}[{index}]")
                names.add(mark["name"])
            required_marks = REQUIRED_RENDERER_MARKS + (CONNECTED_RENDERER_MARKS if cohort != "ui-only" else ())
            if any(name not in names for name in required_marks):
                raise ValueError(f"{label}: missing renderer mark in {cohort}[{index}]")
        grouped[cohort].append(sample)
    for cohort, cohort_samples in grouped.items():
        indexes = [sample["index"] for sample in cohort_samples]
        if not indexes or sorted(indexes) != list(range(len(indexes))):
            raise ValueError(f"{label}: missing or duplicate sample indexes in {cohort}")
        cohort_samples.sort(key=lambda sample: sample["index"])
    return grouped


def valid(sample: dict, schema_version: int) -> bool:
    if sample.get("error") or sample.get("readyMs") is None:
        return False
    if schema_version >= 2:
        return any(mark["phase"] == "workbench-ready" for mark in sample["milestones"])
    return True


def median(values: list[float]) -> str:
    return f"{statistics.median(values):.1f}" if values else "—"


def stage_duration(sample: dict, start: str, end: str) -> float | None:
    marks = {mark["phase"]: mark["elapsedMs"] for mark in sample.get("milestones", [])}
    if start in marks and end in marks:
        return marks[end] - marks[start]
    return None


def renderer_stage_duration(sample: dict, start: str, end: str) -> float | None:
    renderer = sample.get("renderer")
    if not isinstance(renderer, dict):
        return None
    marks = {mark["name"]: mark["startTimeMs"] for mark in renderer["marks"]}
    marks["response-end"] = renderer["responseEndMs"]
    if start in marks and end in marks:
        return marks[end] - marks[start]
    return None


def compare_reports(baseline: dict, candidate: dict) -> tuple[str, int]:
    before = validate(baseline, "baseline")
    after = validate(candidate, "candidate")
    if baseline["schemaVersion"] != candidate["schemaVersion"]:
        raise ValueError("schema versions differ; use the same instrumentation for both runs")
    conditions = CONDITIONS + (V2_CONDITIONS if baseline["schemaVersion"] >= 2 else ()) + (V3_CONDITIONS if baseline["schemaVersion"] == 3 else ())
    differences = [key for key in conditions if baseline["metadata"].get(key) != candidate["metadata"].get(key)]
    if differences:
        raise ValueError(f"measurement conditions differ: {', '.join(differences)}")
    lines = [
        f"Baseline build: {baseline['metadata'].get('buildId')}",
        f"Candidate build: {candidate['metadata'].get('buildId')}",
        "End-to-end: Playwright launch request → usable Workbench (ms)",
        "cohort | baseline samples | candidate samples | baseline median | candidate median | delta | errors (B/C)",
    ]
    incomplete = bool(
        baseline["metadata"].get("failure")
        or candidate["metadata"].get("failure")
        or baseline["metadata"].get("reusedDaemonSameProcess") is False
        or candidate["metadata"].get("reusedDaemonSameProcess") is False
    )
    for cohort in COHORTS:
        old, new = before[cohort], after[cohort]
        if len(old) != len(new) or len(old) < 5:
            incomplete = True
        old_valid = [sample["readyMs"] for sample in old if valid(sample, baseline["schemaVersion"])]
        new_valid = [sample["readyMs"] for sample in new if valid(sample, candidate["schemaVersion"])]
        old_errors, new_errors = len(old) - len(old_valid), len(new) - len(new_valid)
        if old_errors or new_errors:
            incomplete = True
        old_median, new_median = median(old_valid), median(new_valid)
        delta = f"{statistics.median(new_valid) - statistics.median(old_valid):+.1f}" if old_valid and new_valid else "—"
        display = lambda samples, version: ",".join(
            str(sample["readyMs"]) if valid(sample, version) else "ERROR" for sample in samples
        )
        lines.append(
            f"{cohort} | {display(old, baseline['schemaVersion'])} | {display(new, candidate['schemaVersion'])} "
            f"| {old_median} | {new_median} | {delta} | {old_errors}/{new_errors}"
        )
    if baseline["schemaVersion"] >= 2:
        lines.extend(("", "Observer stages, same Playwright worker clock (ms)", "cohort | stage | baseline samples | candidate samples | baseline median | candidate median | delta"))
        for cohort in COHORTS:
            for start, end in STAGES:
                old_durations = [stage_duration(sample, start, end) if valid(sample, 2) else None for sample in before[cohort]]
                new_durations = [stage_duration(sample, start, end) if valid(sample, 2) else None for sample in after[cohort]]
                old_values = [value for value in old_durations if value is not None]
                new_values = [value for value in new_durations if value is not None]
                if len(old_values) != len(before[cohort]) or len(new_values) != len(after[cohort]):
                    incomplete = True
                delta = f"{statistics.median(new_values) - statistics.median(old_values):+.1f}" if old_values and new_values else "—"
                display = lambda durations: ",".join(str(value) if value is not None else "ERROR" for value in durations)
                lines.append(
                    f"{cohort} | {start} → {end} | {display(old_durations)} | {display(new_durations)} "
                    f"| {median(old_values)} | {median(new_values)} | {delta}"
                )
    if baseline["schemaVersion"] == 3:
        lines.extend(("", "Renderer stages, one window performance clock (ms)", "cohort | stage | baseline samples | candidate samples | baseline median | candidate median | delta"))
        for cohort in COHORTS:
            for start, end in RENDERER_STAGES:
                if cohort == "ui-only" and (start in CONNECTED_RENDERER_MARKS or end in CONNECTED_RENDERER_MARKS):
                    continue
                old_durations = [renderer_stage_duration(sample, start, end) if valid(sample, 3) else None for sample in before[cohort]]
                new_durations = [renderer_stage_duration(sample, start, end) if valid(sample, 3) else None for sample in after[cohort]]
                old_values = [value for value in old_durations if value is not None]
                new_values = [value for value in new_durations if value is not None]
                if len(old_values) != len(before[cohort]) or len(new_values) != len(after[cohort]):
                    incomplete = True
                delta = f"{statistics.median(new_values) - statistics.median(old_values):+.1f}" if old_values and new_values else "—"
                display = lambda durations: ",".join(f"{value:.1f}" if value is not None else "ERROR" for value in durations)
                lines.append(
                    f"{cohort} | {start} → {end} | {display(old_durations)} | {display(new_durations)} "
                    f"| {median(old_values)} | {median(new_values)} | {delta}"
                )
    for label, groups in (("baseline", before), ("candidate", after)):
        for cohort in COHORTS:
            for sample in groups[cohort]:
                if sample.get("error"):
                    lines.append(f"{label} {cohort}[{sample['index']}] error: {sample['error']}")
    for label, report in (("baseline", baseline), ("candidate", candidate)):
        if failure := report["metadata"].get("failure"):
            lines.append(f"{label} setup error: {failure}")
        if report["metadata"].get("reusedDaemonSameProcess") is False:
            lines.append(f"{label} reused-daemon PID changed")
    lines.append("Result: incomplete comparison; inspect failed or missing samples." if incomplete else "Result: complete comparison; deltas are descriptive, not a latency threshold.")
    return "\n".join(lines), 2 if incomplete else 0


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline", type=Path, help="baseline desktop-startup-trace.json")
    parser.add_argument("candidate", type=Path, help="candidate desktop-startup-trace.json")
    args = parser.parse_args(arguments)
    try:
        output, status = compare_reports(
            json.loads(args.baseline.read_text()), json.loads(args.candidate.read_text())
        )
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"Desktop startup trace comparison: {error}", file=sys.stderr)
        return 2
    print(output)
    return status


if __name__ == "__main__":
    raise SystemExit(main())
