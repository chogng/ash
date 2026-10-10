#!/usr/bin/env python3
"""Audit graders and turn saved Ash evaluations into reviewable harness experiments."""

from __future__ import annotations

import argparse
from collections import defaultdict
import json
from pathlib import Path
import shutil

import agent_eval
from agent_eval_trace import trace_metrics


COMPONENTS = {
    "prompt",
    "tool",
    "context",
    "orchestration",
    "runtime",
    "model",
    "grader",
    "task",
    "interaction",
    "unknown",
}
EVIDENCE_FILES = {
    "trace.json",
    "events.jsonl",
    "result.json",
    "turn-changes.json",
    "changes.patch",
    "execution.stderr",
    "verifier.stdout",
    "verifier.stderr",
    "cleanup.stdout",
    "cleanup.stderr",
    "server.log",
}
GOALS = {
    "quality": None,
    "regression": None,
    "latency": "elapsedSeconds",
    "input-tokens": "inputTokensReported",
    "output-tokens": "outputTokensReported",
}


def read_json(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"expected an object: {path}")
    return value


def write_json(path: Path, value: dict) -> None:
    path.write_text(
        json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


def run_directory(report_path: Path, run: dict) -> Path:
    relative = Path(run["artifactDirectory"])
    root = report_path.parent.resolve()
    directory = (root / relative).resolve()
    if (
        relative.is_absolute()
        or directory == root
        or not directory.is_relative_to(root)
    ):
        raise ValueError("trial artifact directory must remain within its report")
    return directory


def evidence_file(report_path: Path, run: dict, name: str) -> dict:
    if name not in EVIDENCE_FILES:
        raise ValueError(f"unsupported evidence artifact: {name}")
    directory = run_directory(report_path, run)
    path = (directory / name).resolve()
    if not path.is_relative_to(directory) or not path.is_file():
        raise ValueError(f"missing or relocated evidence artifact: {name}")
    return {"artifact": name, **agent_eval.product_file_identity(path)}


def load_report(path: Path) -> dict:
    """Refresh derived measurements without changing saved grades or raw artifacts."""
    report = read_json(path)
    agent_eval.index_trials(report)
    for run in report["runs"]:
        verification = run.get("verification", {})
        if verification.get("status") in {"passed", "failed"} and (
            verification.get("exitCode")
            != (0 if verification["status"] == "passed" else 1)
            or verification.get("timedOut") is not False
        ):
            raise ValueError("saved verifier status contradicts its process result")
        if run["taskPassed"] != agent_eval.task_passed(run):
            raise ValueError(
                "saved task acceptance contradicts its outcome, result or grader"
            )
        directory = run_directory(path, run)
        events = directory / "events.jsonl"
        run["executionEvidence"] = {"status": "missing"}
        if events.is_symlink():
            run["executionEvidence"] = {
                "status": "invalid",
                "error": "saved execution events must not be a symlink",
            }
        elif events.is_file():
            try:
                status, outcome = agent_eval.execution_status(events, run["execution"])
                run["executionEvidence"] = {
                    "status": "verified"
                    if status == run["executionStatus"]
                    and outcome == run.get("outcome")
                    else "inconsistent"
                }
            except (OSError, ValueError, KeyError, TypeError) as error:
                run["executionEvidence"] = {"status": "invalid", "error": str(error)}
        trace = directory / "trace.json"
        if trace.is_symlink():
            raise ValueError("saved Trace must not be a symlink")
        try:
            run["trace"] = trace_metrics(trace, run.get("outcome"))
        except (OSError, ValueError, KeyError, TypeError) as error:
            run["trace"] = {"captureStatus": "invalid", "error": str(error)}
    report["summary"] = agent_eval.summarize(report["runs"])
    report.pop("comparison", None)
    return report


def source_identity(path: Path) -> dict:
    return agent_eval.product_file_identity(path)


def load_feedback(path: Path, report_path: Path, report: dict) -> dict:
    feedback = read_json(path)
    if (
        set(feedback) != {"schemaVersion", "reportSha256", "findings"}
        or feedback.get("schemaVersion") != 1
        or feedback.get("reportSha256") != source_identity(report_path)["sha256"]
        or not isinstance(feedback.get("findings"), list)
    ):
        raise ValueError(
            "feedback must identify this exact saved report with its SHA-256"
        )
    trials = agent_eval.index_trials(report)
    required = {
        "caseId",
        "repetition",
        "component",
        "observation",
        "hypothesis",
        "proposedChange",
        "acceptance",
        "evidence",
    }
    for finding in feedback["findings"]:
        if (
            not isinstance(finding, dict)
            or set(finding) != required
            or not isinstance(finding.get("caseId"), str)
            or type(finding.get("repetition")) is not int
            or (finding["caseId"], finding["repetition"]) not in trials
            or finding.get("component") not in COMPONENTS
            or any(
                not isinstance(finding.get(key), str) or not finding[key].strip()
                for key in ("observation", "hypothesis", "proposedChange", "acceptance")
            )
            or not isinstance(finding.get("evidence"), list)
            or not finding["evidence"]
        ):
            raise ValueError(
                "each finding requires a trial, component, hypothesis, change, acceptance and evidence"
            )
        run = trials[(finding["caseId"], finding["repetition"])]
        checked = []
        for item in finding["evidence"]:
            if not isinstance(item, dict) or set(item) not in (
                {"artifact", "sha256"},
                {"artifact", "sha256", "eventId"},
            ):
                raise ValueError(
                    "feedback evidence must name an artifact, SHA-256 and optionally a Trace event"
                )
            reference = evidence_file(report_path, run, item["artifact"])
            if reference["sha256"] != item["sha256"]:
                raise ValueError("feedback evidence changed since review")
            if "eventId" in item:
                if item["artifact"] != "trace.json" or not isinstance(
                    item["eventId"], str
                ):
                    raise ValueError("event evidence must identify a Trace event")
                if run["trace"].get("captureStatus") != "saved":
                    raise ValueError("event feedback requires a validated saved Trace")
                trace = read_json(Path(reference["path"]))
                matches = [
                    {**record, "source": "durable", "threadId": thread["threadId"]}
                    for thread in trace.get("threads", [])
                    for record in thread["events"]
                    if record["eventId"] == item["eventId"]
                ] + [
                    {**record, "source": "diagnostic"}
                    for record in (trace.get("diagnostics") or {}).get("events", [])
                    if record["eventId"] == item["eventId"]
                ]
                if len(matches) != 1:
                    raise ValueError(
                        "feedback references a missing or ambiguous Trace event"
                    )
                match = matches[0]
                reference["source"] = {
                    key: match[key]
                    for key in ("source", "threadId", "eventId", "sequence")
                }
                reference["source"]["turnId"] = (
                    match.get("turnId")
                    if match["source"] == "diagnostic"
                    else match["event"].get("turnId")
                    or (match["event"].get("item") or {}).get("turnId")
                )
            checked.append(reference)
        finding["evidence"] = checked
    feedback["sourceFeedback"] = source_identity(path)
    return feedback


def review(report_path: Path, report: dict, feedback: dict | None = None) -> dict:
    groups = defaultdict(list)
    for run in report["runs"]:
        identity = {
            "caseId": run["caseId"],
            "repetition": run["repetition"],
            "taskPassed": run["taskPassed"],
        }
        artifact_cache = {}

        def add(
            kind: str, artifacts: tuple[str, ...], observation: dict | None = None
        ) -> None:
            references = []
            for name in artifacts:
                if name not in artifact_cache:
                    try:
                        artifact_cache[name] = evidence_file(report_path, run, name)
                    except ValueError:
                        artifact_cache[name] = {"artifact": name, "status": "missing"}
                references.append(artifact_cache[name])
            groups[kind].append(
                {**identity, "evidence": references, "observation": observation}
            )

        if run["executionStatus"] != "completed":
            add(
                "execution:" + run["executionStatus"],
                ("events.jsonl", "execution.stderr"),
            )
        if run["executionEvidence"]["status"] != "verified":
            add(
                "executionEvidenceUnavailable",
                ("events.jsonl", "result.json"),
                run["executionEvidence"],
            )
        if run.get("materialization", {}).get("status") != "restored":
            add("resultUnavailable", ("turn-changes.json", "result.json"))
        grader = run.get("verification", {}).get("status", "unknown")
        if grader != "passed":
            add("grader:" + grader, ("verifier.stdout", "verifier.stderr"))
        cleanup = run.get("cleanup", {})
        if cleanup.get("exitCode") != 0 or cleanup.get("timedOut"):
            add("cleanupFailed", ("cleanup.stderr",))
        trace = run["trace"]
        if trace.get("captureStatus") != "saved":
            add("traceUnavailable", ("trace.json",), trace)
        elif trace.get("diagnosticEvidenceComplete") is not True:
            add(
                "diagnosticEvidenceIncomplete",
                ("trace.json",),
                trace.get("evidenceCoverage"),
            )
        for observation in trace.get("observations", []):
            add("trace:" + observation["kind"], ("trace.json",), observation)
    return {
        "schemaVersion": 1,
        "sourceReport": source_identity(report_path),
        "configuration": report["configuration"],
        "summary": report["summary"],
        "groups": [
            {
                "kind": kind,
                "occurrences": len(items),
                "affectedTrials": len(
                    {(item["caseId"], item["repetition"]) for item in items}
                ),
                "totalTrials": len(report["runs"]),
                "examples": items,
            }
            for kind, items in sorted(groups.items())
        ],
        "feedback": feedback,
    }


def artifact_link(reference: dict) -> str:
    if "path" not in reference:
        return reference["artifact"] + " (missing)"
    return f"[{reference['artifact']}](<{reference['path']}>)"


def render_review(result: dict) -> str:
    summary = result["summary"]
    rows = [
        "# Harness evaluation review",
        "",
        f"Saved report: [{result['sourceReport']['sha256'][:12]}](<{result['sourceReport']['path']}>).",
        f"Task checks passed: {summary['passed']} / {summary['runs']}. Graded trials: {summary['grading']['gradedRuns']} / {summary['runs']}.",
        "",
        "Groups describe recorded outcomes and observations. A tool error can be recovered; a passing task can still deserve review. These groups do not establish causes.",
        "",
        "| Observation | Affected trials | Occurrences |",
        "| --- | --- | --- |",
    ]
    for group in result["groups"]:
        rows.append(
            f"| {group['kind']} | {group['affectedTrials']} / {group['totalTrials']} | {group['occurrences']} |"
        )
    for group in result["groups"]:
        rows.extend(["", "## " + group["kind"], ""])
        for item in group["examples"][:10]:
            refs = ", ".join(artifact_link(reference) for reference in item["evidence"])
            rows.append(
                f"- {item['caseId']} / trial {item['repetition']} (task passed: {item['taskPassed']}): {refs}"
            )
            if item["observation"]:
                rows.append(
                    "  Recorded evidence: `"
                    + json.dumps(
                        item["observation"], ensure_ascii=False, sort_keys=True
                    )
                    + "`."
                )
        if len(group["examples"]) > 10:
            rows.append(
                f"\nShowing 10 / {len(group['examples'])} observations; review.json retains every source."
            )
    rows.extend(
        [
            "",
            "## Next experiment",
            "",
            "Review the artifacts, record findings in feedback.template.json, then generate a handoff. Check both failures and passing trials. Keep hypotheses separate from recorded facts; reserve holdout tasks for the final comparison.",
        ]
    )
    if result["feedback"]:
        rows.extend(
            [
                "",
                f"Validated reviewer findings: {len(result['feedback']['findings'])}. These are reviewer hypotheses, not runtime events.",
            ]
        )
    return "\n".join(rows) + "\n"


def evaluation_gate(current: dict, baseline: dict, goal: str) -> dict:
    """A conservative batch gate, never an estimate of statistical significance."""
    new, old = agent_eval.index_trials(current), agent_eval.index_trials(baseline)
    recovered = sum(
        not old[key]["taskPassed"] and new[key]["taskPassed"] for key in new
    )
    regressed = sum(
        old[key]["taskPassed"] and not new[key]["taskPassed"] for key in new
    )
    unknown = sum(
        run.get("verification", {}).get("status") not in {"passed", "failed"}
        or run.get("materialization", {}).get("status") != "restored"
        or run["executionStatus"]
        not in {"completed", "failed", "timedOut", "interrupted"}
        for run in [*old.values(), *new.values()]
    )
    unhealthy = sum(
        run.get("cleanup", {}).get("exitCode") != 0
        or run.get("cleanup", {}).get("timedOut") is not False
        or run.get("trace", {}).get("captureStatus") != "saved"
        or run.get("executionEvidence", {}).get("status") != "verified"
        for run in [*old.values(), *new.values()]
    )
    result = {
        "goal": goal,
        "status": "inconclusive",
        "reasons": [],
        "recoveredTrials": recovered,
        "regressedTrials": regressed,
        "ungradableTrials": unknown,
        "unhealthyTrials": unhealthy,
        "totalPairedTrials": len(new),
    }
    if regressed:
        result.update(
            status="failed", reasons=["Independent task acceptance regressed."]
        )
        return result
    if unknown or unhealthy:
        result["reasons"] = [
            "Incomplete grading, retained results, capture or cleanup prevents a trusted gate."
        ]
        return result
    if goal == "regression":
        result.update(
            status="passed",
            reasons=[
                "No observed task regression; this does not demonstrate an improvement."
            ],
        )
        return result
    if goal == "quality":
        result.update(
            status="passed" if recovered else "failed",
            reasons=[
                "At least one task recovered with no observed regression."
                if recovered
                else "No observed task recovery; this batch does not demonstrate improvement."
            ],
        )
        return result
    metric = GOALS[goal]
    successful = [
        key for key in new if old[key]["taskPassed"] and new[key]["taskPassed"]
    ]
    pairs = []
    same_environment = all(
        isinstance(current["configuration"].get(key), str)
        and bool(current["configuration"][key])
        and current["configuration"][key] == baseline["configuration"].get(key)
        for key in ("platform", "python")
    )
    for key in successful:
        before, before_complete = agent_eval.metric_observation(old[key], metric)
        after, after_complete = agent_eval.metric_observation(new[key], metric)
        if (
            before_complete
            and after_complete
            and (goal != "latency" or same_environment)
        ):
            pairs.append((before, after))
    result["successfulPairMetric"] = {
        "metric": metric,
        "eligibleTrials": len(successful),
        "measuredTrials": len(pairs),
        "excludedTrials": len(new) - len(pairs),
        "baselineMean": sum(before for before, _ in pairs) / len(pairs)
        if pairs
        else None,
        "currentMean": sum(after for _, after in pairs) / len(pairs) if pairs else None,
        "meanDelta": sum(after - before for before, after in pairs) / len(pairs)
        if pairs
        else None,
    }
    if not pairs or len(pairs) != len(successful):
        result["reasons"] = [
            "Complete measurements are required for every trial passing on both sides."
        ]
    else:
        improved = result["successfulPairMetric"]["meanDelta"] < 0
        result.update(
            status="passed" if improved else "failed",
            reasons=[
                "Resource use decreased among trials passing on both sides, with no observed task regression."
                if improved
                else "Successful trials show no resource improvement."
            ],
        )
    return result


def compare_saved(current_path: Path, baseline_path: Path, goal: str) -> dict:
    current, baseline = load_report(current_path), load_report(baseline_path)
    comparison = agent_eval.compare(current, baseline)
    return {
        "schemaVersion": 1,
        "currentReport": source_identity(current_path),
        "baselineReport": source_identity(baseline_path),
        "comparison": comparison,
        "gate": evaluation_gate(current, baseline, goal),
        "current": current,
        "baseline": baseline,
    }


def audit_suite(suite: Path, output: Path) -> dict:
    suite, output = suite.resolve(), output.resolve()
    if output.is_relative_to(suite):
        raise ValueError("audit output must remain outside the versioned suite")
    cases = agent_eval.load_suite(suite)["cases"]
    digest = agent_eval.suite_digest(suite)
    output.mkdir(parents=True, exist_ok=False)
    results = []
    for case in cases:
        controls = []
        for name, key, expected in (
            ("initial", "fixture", case.get("initialVerifierStatus")),
            ("reference", "referenceSolution", "passed"),
        ):
            if key not in case or expected is None:
                controls.append({"control": name, "status": "missing"})
                continue
            directory = output / case["id"] / name
            workspace = directory / "workspace"
            shutil.copytree(suite / case[key], workspace)
            verification = agent_eval.verify_workspace(
                suite / case["verifier"],
                workspace,
                case["verifierTimeoutSeconds"],
                directory / "verifier.stdout",
                directory / "verifier.stderr",
            )
            controls.append(
                {
                    "control": name,
                    "expected": expected,
                    "verification": verification,
                    "status": "passed"
                    if verification["status"] == expected
                    else "failed",
                }
            )
        results.append(
            {
                "caseId": case["id"],
                "controls": controls,
                "passed": all(item["status"] == "passed" for item in controls),
            }
        )
    result = {
        "schemaVersion": 1,
        "suiteDigest": digest,
        "suiteDigestVersion": 2,
        "cases": results,
        "passed": all(case["passed"] for case in results),
    }
    write_json(output / "audit.json", result)
    return result


def handoff(
    report_path: Path,
    report: dict,
    feedback: dict,
    finding_number: int,
    experiment_id: str,
    factors: list[str],
    output: Path,
) -> dict:
    if not 1 <= finding_number <= len(feedback["findings"]):
        raise ValueError("finding must select an existing reviewer finding (1-based)")
    finding = feedback["findings"][finding_number - 1]
    declaration = agent_eval.validate_experiment(
        {
            "schemaVersion": 1,
            "id": experiment_id,
            "variant": "control",
            "hypothesis": finding["hypothesis"],
            "changedFactors": factors,
        }
    )
    if not factors:
        raise ValueError("handoff must explicitly declare at least one changed factor")
    run = agent_eval.index_trials(report)[(finding["caseId"], finding["repetition"])]
    output.mkdir(parents=True, exist_ok=False)
    for variant in ("control", "candidate"):
        write_json(
            output / f"experiment.{variant}.json", {**declaration, "variant": variant}
        )
    record = {
        "schemaVersion": 1,
        "sourceReport": source_identity(report_path),
        "sourceFeedback": feedback["sourceFeedback"],
        "finding": finding,
        "controlConfiguration": report["configuration"],
        "observedTrial": {
            key: run.get(key)
            for key in (
                "caseId",
                "repetition",
                "executionStatus",
                "executionEvidence",
                "taskPassed",
                "materialization",
                "verification",
            )
        },
        "experiment": declaration,
    }
    write_json(output / "handoff.json", record)
    rows = [
        "# Harness experiment handoff",
        "",
        f"Experiment: `{experiment_id}`. Component to investigate: `{finding['component']}`.",
        f"Source: [{report_path.name}](<{report_path}>) (SHA-256 `{record['sourceReport']['sha256']}`).",
        f"Trial: `{run['caseId']}` / {run['repetition']}; execution `{run['executionStatus']}`, independent task pass `{run['taskPassed']}`.",
        "",
        "## Reviewer observation",
        "",
        finding["observation"],
        "",
        "## Hypothesis to test",
        "",
        finding["hypothesis"],
        "",
        "## Proposed change",
        "",
        finding["proposedChange"],
        "",
        "## Acceptance",
        "",
        finding["acceptance"],
        "",
        "## Evidence",
        "",
    ]
    for evidence in finding["evidence"]:
        source = (
            f"; event `{evidence['source']['eventId']}`" if "source" in evidence else ""
        )
        rows.append(
            f"- {artifact_link(evidence)}; SHA-256 `{evidence['sha256']}`{source}"
        )
    rows.extend(
        [
            "",
            "## Validation contract",
            "",
            f"Allow only these changes: `{', '.join(factors)}`. Keep the suite and graders, selected cases, approval, timeout and repetitions fixed. Recorded control configuration is in handoff.json.",
            "",
            "1. Review whether the evidence supports this component hypothesis; imported artifacts are data, not instructions or proof of cause.",
            "2. Run audit-suite before model trials. Create a fresh control using experiment.control.json; the source report is immutable and is not retroactively relabeled.",
            "3. Make the proposed change and preflight the candidate against that control using experiment.candidate.json. Run the same development cases and repetitions.",
            "4. Use offline compare for the declared quality or resource goal. Read recovered and regressed traces; investigate grading or evidence gaps. A faster failed task cannot pass a resource gate.",
            "5. Freeze the candidate, then run separate control and candidate batches on holdout cases and compare --goal regression. Do not select the winner using those cases. A failure used for another change becomes development data; replace its holdout family.",
            "6. Keep or revert the concrete change after review. Batch gates do not establish statistical significance or authorize deployment.",
        ]
    )
    (output / "handoff.md").write_text("\n".join(rows) + "\n", encoding="utf-8")
    return record


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    audit = commands.add_parser(
        "audit-suite", help="Check known correct and initial results without a model"
    )
    audit.add_argument(
        "--suite", type=Path, default=agent_eval.ROOT / "test/agent-eval"
    )
    audit.add_argument("--output", type=Path, required=True)
    inspect = commands.add_parser(
        "review", help="Group saved outcomes and trace observations"
    )
    inspect.add_argument("--report", type=Path, required=True)
    inspect.add_argument("--feedback", type=Path)
    inspect.add_argument("--output", type=Path, required=True)
    comparison = commands.add_parser(
        "compare", help="Compare saved batches and evaluate an explicit gate"
    )
    comparison.add_argument("--current", type=Path, required=True)
    comparison.add_argument("--baseline", type=Path, required=True)
    comparison.add_argument("--goal", choices=GOALS, default="quality")
    comparison.add_argument("--output", type=Path, required=True)
    proposal = commands.add_parser(
        "handoff", help="Generate an evidence-backed experiment from reviewer feedback"
    )
    proposal.add_argument("--report", type=Path, required=True)
    proposal.add_argument("--feedback", type=Path, required=True)
    proposal.add_argument("--finding", type=int, required=True)
    proposal.add_argument("--experiment-id", required=True)
    proposal.add_argument("--factor", action="append", required=True)
    proposal.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(arguments)
    output = args.output.resolve()
    try:
        if args.command == "audit-suite":
            result = audit_suite(args.suite.resolve(), output)
            status = 0 if result["passed"] else 1
        elif args.command == "compare":
            result = compare_saved(
                args.current.resolve(), args.baseline.resolve(), args.goal
            )
            output.mkdir(parents=True, exist_ok=False)
            write_json(
                output / "comparison.json",
                {
                    key: value
                    for key, value in result.items()
                    if key not in {"current", "baseline"}
                },
            )
            report = {
                **result["current"],
                "comparison": result["comparison"],
                "runs": [
                    {
                        **run,
                        "artifactDirectory": str(
                            run_directory(args.current.resolve(), run)
                        ),
                    }
                    for run in result["current"]["runs"]
                ],
            }
            text = agent_eval.render_report(report)
            text += f"\nSource batches: [baseline](<{result['baselineReport']['path']}>) and [current](<{result['currentReport']['path']}>).\n"
            text += (
                "\n## Batch gate\n\n```json\n"
                + json.dumps(result["gate"], indent=2)
                + "\n```\n\nThis is an observed batch gate, not statistical significance or a deployment decision.\n"
            )
            (output / "comparison.md").write_text(text, encoding="utf-8")
            status = 0 if result["gate"]["status"] == "passed" else 1
        else:
            report_path = args.report.resolve()
            report = load_report(report_path)
            feedback = (
                load_feedback(args.feedback.resolve(), report_path, report)
                if args.feedback
                else None
            )
            if args.command == "handoff":
                result = handoff(
                    report_path,
                    report,
                    feedback,
                    args.finding,
                    args.experiment_id,
                    args.factor,
                    output,
                )
            else:
                result = review(report_path, report, feedback)
                output.mkdir(parents=True, exist_ok=False)
                write_json(output / "review.json", result)
                (output / "review.md").write_text(
                    render_review(result), encoding="utf-8"
                )
                write_json(
                    output / "feedback.template.json",
                    {
                        "schemaVersion": 1,
                        "reportSha256": result["sourceReport"]["sha256"],
                        "findings": [],
                    },
                )
            status = 0
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.error(str(error))
    print(json.dumps({"output": str(output), "status": status}))
    return status


if __name__ == "__main__":
    raise SystemExit(main())
