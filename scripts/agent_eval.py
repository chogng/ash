#!/usr/bin/env python3
"""Run fixed coding tasks through ash exec and verify their resulting workspaces."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import tomllib

from agent_eval_trace import trace_metrics

ROOT = Path(__file__).resolve().parents[1]
EXPERIMENT_FACTORS = (
    "model",
    "ashExecutableDigest",
    "appServerExecutable",
    "productServices",
    "platform",
    "python",
)


def profile_factors(content: bytes) -> dict[str, str]:
    """Hash semantic TOML leaves; never copy configuration values into a report."""
    values = tomllib.loads(content.decode("utf-8")) if content else {}
    factors = {}

    def visit(value: object, path: str) -> None:
        if isinstance(value, dict) and value:
            for key, child in value.items():
                visit(child, path + "/" + key.replace("~", "~0").replace("/", "~1"))
        else:
            factors["profile:" + path] = hashlib.sha256(
                json.dumps(
                    value,
                    sort_keys=True,
                    ensure_ascii=False,
                    separators=(",", ":"),
                    default=str,
                    allow_nan=False,
                ).encode()
            ).hexdigest()

    visit(values, "")
    return factors


def validate_experiment(experiment: dict) -> dict:
    if (
        not isinstance(experiment, dict)
        or experiment.get("schemaVersion") != 1
        or set(experiment)
        != {"schemaVersion", "id", "variant", "hypothesis", "changedFactors"}
    ):
        raise ValueError("expected a version 1 experiment manifest")
    if any(
        not isinstance(experiment.get(key), str) or not experiment[key].strip()
        for key in ("id", "variant", "hypothesis")
    ):
        raise ValueError("experiment identity, variant and hypothesis must be explicit")
    factors = experiment["changedFactors"]
    if (
        not isinstance(factors, list)
        or any(
            not isinstance(factor, str)
            or not (factor in EXPERIMENT_FACTORS or factor.startswith("profile:/"))
            for factor in factors
        )
        or len(set(factors)) != len(factors)
    ):
        raise ValueError("invalid declared experiment factors")
    return experiment


def load_experiment(path: Path) -> dict:
    return validate_experiment(json.loads(path.read_text(encoding="utf-8")))


def changed_conditions(current: dict, baseline: dict) -> dict:
    if current.get("suiteDigestVersion", 1) != baseline.get("suiteDigestVersion", 1):
        raise ValueError("baseline has incompatible suiteDigestVersion")
    for key in ("suiteDigest", "timeoutSeconds", "approval", "repetitions"):
        if current[key] != baseline[key]:
            raise ValueError(f"baseline has incompatible {key}")
    if (
        "caseSelection" in current
        and "caseSelection" in baseline
        and current["caseSelection"] != baseline["caseSelection"]
    ):
        raise ValueError("baseline has incompatible caseSelection")
    changed = {}
    for key in EXPERIMENT_FACTORS:
        old, new = baseline.get(key), current.get(key)
        old = old.get("sha256") if isinstance(old, dict) else old
        new = new.get("sha256") if isinstance(new, dict) else new
        if old != new:
            changed[key] = {"baseline": old, "current": new}
    experiment, previous = current.get("experiment"), baseline.get("experiment")
    if experiment is None and previous is None:
        if current["profileConfigDigest"] != baseline["profileConfigDigest"]:
            raise ValueError("baseline has incompatible profileConfigDigest")
        return changed
    if (
        not isinstance(experiment, dict)
        or not isinstance(previous, dict)
        or any(
            experiment.get(key) != previous.get(key)
            for key in ("schemaVersion", "id", "hypothesis", "changedFactors")
        )
    ):
        raise ValueError("baseline has incompatible experiment declaration")
    if not isinstance(current.get("profileFactors"), dict) or not isinstance(
        baseline.get("profileFactors"), dict
    ):
        raise ValueError("declared experiment requires semantic profile factors")
    for key in current["profileFactors"].keys() | baseline["profileFactors"].keys():
        old, new = (
            baseline["profileFactors"].get(key),
            current["profileFactors"].get(key),
        )
        if old != new:
            changed[key] = {"baseline": old, "current": new}
    if unexpected := changed.keys() - set(experiment["changedFactors"]):
        raise ValueError(
            f"undeclared experiment changes: {', '.join(sorted(unexpected))}"
        )
    return changed


def suite_digest(root: Path) -> str:
    """Freeze actual task and grading inputs; formatting and unrelated docs are not inputs."""
    root = root.resolve()
    if (root / "suite.json").is_symlink():
        raise ValueError("suite manifest must not be a symlink")
    suite = load_suite(root)
    digest = hashlib.sha256()
    digest.update(b"ash-agent-eval-suite-v2\0")
    digest.update(
        json.dumps(
            suite,
            sort_keys=True,
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        ).encode()
    )
    scopes = {root / resource for resource in suite.get("gradingResources", [])}
    for case in suite["cases"]:
        scopes.add(root / case["fixture"])
        # Include sibling verifier helpers, even when the manifest names one entry point.
        scopes.add((root / case["verifier"]).parent)
        if "referenceSolution" in case:
            scopes.add(root / case["referenceSolution"])
    files = set()
    for scope in scopes:
        for path in [scope, *scope.rglob("*")] if scope.is_dir() else [scope]:
            if path.is_symlink():
                raise ValueError(f"suite inputs must not contain symlinks: {path}")
            if path.is_file():
                files.add(path)
    for path in sorted(files):
        # suite.json is already hashed semantically above, including resource declarations.
        if path == root / "suite.json":
            continue
        digest.update(path.relative_to(root).as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def product_file_identity(path: Path) -> dict:
    path = path.resolve()
    if not path.is_file():
        return {"path": str(path), "status": "unavailable"}
    with path.open("rb") as file:
        digest = hashlib.sha256()
        while block := file.read(1024 * 1024):
            digest.update(block)
        return {
            "path": str(path),
            "sha256": digest.hexdigest(),
        }


def load_suite(path: Path) -> dict:
    path = path.resolve()
    suite = json.loads((path / "suite.json").read_text(encoding="utf-8"))
    if (
        not isinstance(suite, dict)
        or suite.get("schemaVersion") != 1
        or not isinstance(suite.get("cases"), list)
        or not suite["cases"]
    ):
        raise ValueError("expected a non-empty version 1 task suite")
    resources = suite.get("gradingResources", [])
    if not isinstance(resources, list) or any(
        not isinstance(resource, str) for resource in resources
    ):
        raise ValueError("grading resources must be suite-relative paths")
    for resource in resources:
        target = (path / resource).resolve()
        if not target.is_relative_to(path) or not target.exists():
            raise ValueError("grading resources must remain within the suite")
    ids: set[str] = set()
    for case in suite["cases"]:
        if not isinstance(case, dict):
            raise ValueError("task cases must be objects")
        identity = case.get("id", "")
        if (
            not isinstance(identity, str)
            or not identity
            or not all(
                character.isalnum() or character in "-_" for character in identity
            )
            or identity in ids
        ):
            raise ValueError("case ids must be unique path-safe names")
        ids.add(identity)
        if not isinstance(case.get("prompt"), str) or not case["prompt"].strip():
            raise ValueError(f"missing prompt: {identity}")
        if case.get("split", "development") not in {"development", "holdout"}:
            raise ValueError(f"invalid task split: {identity}")
        targets = [("fixture", True), ("verifier", False)]
        if "referenceSolution" in case:
            targets.append(("referenceSolution", True))
            if case.get("initialVerifierStatus") not in {"passed", "failed"}:
                raise ValueError(f"missing initial verifier expectation: {identity}")
        for key, directory in targets:
            if not isinstance(case.get(key), str):
                raise ValueError(f"invalid {key}: {identity}")
            target = (path / case[key]).resolve()
            if not target.is_relative_to(path) or not (
                target.is_dir() if directory else target.is_file()
            ):
                raise ValueError(f"invalid {key}: {identity}")
        if (
            type(case.get("verifierTimeoutSeconds")) is not int
            or case["verifierTimeoutSeconds"] < 1
        ):
            raise ValueError(f"invalid verifier timeout: {identity}")
    return suite


def select_cases(suite: dict, split: str) -> list[dict]:
    cases = [
        case
        for case in suite["cases"]
        if split == "all" or case.get("split", "development") == split
    ]
    if not cases:
        raise ValueError(f"suite has no {split} cases")
    return cases


def task_passed(run: dict) -> bool:
    """The product outcome, retained result and independent grader must all agree."""
    return (
        run.get("executionStatus") == "completed"
        and run.get("execution", {}).get("exitCode") == 0
        and run.get("execution", {}).get("timedOut") is False
        and run.get("verification", {}).get("status") == "passed"
        and run.get("verification", {}).get("exitCode") == 0
        and run.get("verification", {}).get("timedOut") is False
        and run.get("materialization", {}).get("status") == "restored"
    )


def kill_group(process: subprocess.Popen) -> None:
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/T", "/F", "/PID", str(process.pid)],
            capture_output=True,
            timeout=10,
            check=False,
        )
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    process.wait(timeout=10)


def run_process(
    command: list[str],
    cwd: Path,
    environment: dict[str, str],
    timeout: float,
    stdout: Path,
    stderr: Path,
    interrupt: bool = False,
) -> dict:
    start = time.monotonic()
    timed_out = False
    with stdout.open("wb") as output, stderr.open("wb") as errors:
        try:
            process = subprocess.Popen(
                command,
                cwd=cwd,
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=output,
                stderr=errors,
                start_new_session=os.name != "nt",
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP
                if os.name == "nt"
                else 0,
            )
        except OSError as error:
            errors.write(str(error).encode())
            return {
                "exitCode": None,
                "timedOut": False,
                "spawnError": str(error),
                "elapsedSeconds": round(time.monotonic() - start, 3),
            }
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            if interrupt:
                process.send_signal(
                    signal.CTRL_BREAK_EVENT if os.name == "nt" else signal.SIGINT
                )
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    kill_group(process)
            else:
                kill_group(process)
        except BaseException:
            kill_group(process)
            raise
    return {
        "exitCode": process.returncode,
        "timedOut": timed_out,
        "elapsedSeconds": round(time.monotonic() - start, 3),
    }


def execution_status(path: Path, process: dict) -> tuple[str, dict | None]:
    outcome = None
    for line in path.read_text(encoding="utf-8").splitlines():
        envelope = json.loads(line)
        if envelope.get("schemaVersion") != 1:
            raise ValueError("unsupported exec event version")
        event = envelope.get("event", {})
        if event.get("type") == "runCompleted":
            outcome = event.get("outcome")
    if process["timedOut"] or (
        outcome
        and outcome.get("type") == "interrupted"
        and outcome.get("reason") == "turnTimeout"
    ):
        return "timedOut", outcome
    if not outcome:
        return "outcomeUnknown", None
    return outcome["type"], outcome


def verify_workspace(
    verifier: Path, workspace: Path, timeout: int, stdout: Path, stderr: Path
) -> dict:
    verification = run_process(
        [sys.executable, "-B", str(verifier), str(workspace)],
        workspace,
        {**os.environ, "PYTHONOPTIMIZE": "0"},
        timeout,
        stdout,
        stderr,
    )
    verification["status"] = (
        "timedOut"
        if verification["timedOut"]
        else "error"
        if verification.get("spawnError") or verification["exitCode"] not in {0, 1}
        else "passed"
        if verification["exitCode"] == 0
        else "failed"
    )
    return verification


def prepare_profile(template: Path, profile: Path) -> None:
    profile.mkdir()
    # Copy declared model settings and credentials, never daemon sockets or previous task history.
    for name in ["config.toml", "secrets"]:
        source = template / name
        if source.is_dir():
            shutil.copytree(source, profile / name)
        elif source.is_file():
            shutil.copy2(source, profile / name)


def restore_turn_changes(path: Path, workspace: Path, outcome: dict | None) -> dict:
    """Materialize retained text changes over the fixture, without publishing its Git branch."""
    workspace = workspace.resolve()
    if not path.is_file():
        return {"status": "missing"}
    artifact = json.loads(path.read_text(encoding="utf-8"))
    if (
        artifact.get("formatVersion") != 1
        or not outcome
        or any(
            artifact.get(key) != outcome.get(key)
            for key in ["sessionId", "threadId", "turnId"]
        )
    ):
        raise ValueError("Turn changes must match the completed execution identity")
    records = artifact.get("changeSets")
    if not isinstance(records, list) or len(records) != 1:
        raise ValueError("task fixtures require one complete Git repository change set")
    record = records[0]
    if record["summary"].get("captureState") != "sealed":
        raise ValueError("Turn changes are not completely sealed")

    def target(name: str) -> Path:
        if not isinstance(name, str) or not name or "\\" in name or ":" in name:
            raise ValueError("invalid changed file path")
        relative = Path(name)
        if relative.is_absolute() or any(
            part in {"..", ".git"} for part in relative.parts
        ):
            raise ValueError("changed file is outside the task fixture")
        result = (workspace / relative).resolve()
        if result == workspace or not result.is_relative_to(workspace):
            raise ValueError("changed file is outside the task fixture")
        return result

    changes = []
    destinations: set[Path] = set()
    for entry in record["files"]:
        file, content = entry["file"], entry["content"]
        destination = target(file["path"])
        previous = target(file.get("previousPath") or file["path"])
        if destination in destinations or content.get("path") != file["path"]:
            raise ValueError("ambiguous changed file identity")
        destinations.add(destination)
        if file["binary"] or content["binary"] or content["truncated"]:
            raise ValueError(
                "binary or truncated results cannot be verified as complete text"
            )
        if file.get("afterMode") not in {None, "100644", "100755"}:
            raise ValueError("task results must contain regular files")
        before, after = content.get("before"), content.get("after")
        if before is not None and previous.read_bytes() != before.encode("utf-8"):
            raise ValueError("retained change baseline differs from the task fixture")
        if after is not None and not isinstance(after, str):
            raise ValueError("invalid retained text")
        if (file["kind"] == "deleted") != (after is None):
            raise ValueError("retained change is missing its final file contents")
        changes.append((destination, previous, after, file.get("afterMode")))
    # Validate the full artifact before replacing any fixture file.
    for destination, previous, after, mode in changes:
        if after is None or previous != destination:
            previous.unlink(missing_ok=True)
        if after is not None:
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(after.encode("utf-8"))
            destination.chmod(0o755 if mode == "100755" else 0o644)
    return {"status": "restored", "files": len(changes)}


def run_case(
    case: dict,
    repetition: int,
    suite: Path,
    output: Path,
    ash: Path,
    template: Path,
    model: str,
    timeout: int,
    approval: str,
) -> dict:
    directory = output / "runs" / f"{case['id']}-{repetition}"
    directory.mkdir(parents=True)
    workspace = directory / "workspace"
    shutil.copytree(suite / case["fixture"], workspace)
    git_environment = {
        **os.environ,
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
    }
    for command in [
        ["git", "init", "--quiet"],
        ["git", "add", "--all"],
        [
            "git",
            "-c",
            "user.name=Agent Eval",
            "-c",
            "user.email=agent-eval@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--quiet",
            "-m",
            "Initial fixture",
        ],
    ]:
        subprocess.run(
            command, cwd=workspace, env=git_environment, capture_output=True, check=True
        )
    result = {
        "caseId": case["id"],
        "repetition": repetition,
        "taskPassed": False,
        "artifactDirectory": directory.relative_to(output).as_posix(),
    }
    temporary = Path(tempfile.mkdtemp(prefix="ash-agent-eval-"))
    try:
        profile = temporary / "profile"
        prepare_profile(template, profile)
        environment = {
            **os.environ,
            "ASH_HOME": str(profile),
            "ASH_WORKSPACE_ROOT": str(workspace),
            "ASH_ROLLOUT_TRACE_ROOT": str(directory / "diagnostics"),
        }
        trace = directory / "trace.json"
        changes = directory / "turn-changes.json"
        command = [
            str(ash),
            "exec",
            "--jsonl",
            "--model",
            model,
            "--timeout-seconds",
            str(timeout),
            "--trace-output",
            str(trace),
            "--changes-output",
            str(changes),
            "--title",
            f"Eval {case['id']} {repetition}",
        ]
        if approval == "automaticReview":
            command.append("--auto-review")
        elif approval == "bypassPermissions":
            command.append("--dangerously-bypass-permissions")
        command.extend(["--", case["prompt"]])
        try:
            process = run_process(
                command,
                workspace,
                environment,
                timeout + 60,
                directory / "events.jsonl",
                directory / "execution.stderr",
                interrupt=True,
            )
            result["execution"] = process
            if process["exitCode"] != 0:
                result["daemonDiagnostics"] = run_process(
                    [str(ash), "app-server", "daemon", "version"],
                    workspace,
                    environment,
                    15,
                    directory / "daemon.json",
                    directory / "daemon.stderr",
                )
                try:
                    daemon = json.loads((directory / "daemon.json").read_text())
                    if isinstance(daemon.get("logPath"), str):
                        log = Path(daemon["logPath"])
                        if log.is_file():
                            (directory / "server.log").write_bytes(
                                log.read_bytes()[-1024 * 1024 :]
                            )
                except (OSError, ValueError, TypeError):
                    pass
            try:
                status, outcome = execution_status(directory / "events.jsonl", process)
                result.update(executionStatus=status, outcome=outcome)
            except (ValueError, KeyError, TypeError) as error:
                result.update(executionStatus="outcomeUnknown", eventError=str(error))
            try:
                result["trace"] = trace_metrics(trace, result.get("outcome"))
            except (ValueError, KeyError, TypeError) as error:
                result["trace"] = {"captureStatus": "invalid", "error": str(error)}
            try:
                result["materialization"] = restore_turn_changes(
                    changes, workspace, result.get("outcome")
                )
            except (OSError, ValueError, KeyError, TypeError) as error:
                result["materialization"] = {"status": "failed", "error": str(error)}
            # The verifier is outside the agent workspace and runs after the product has finished.
            verification = verify_workspace(
                suite / case["verifier"],
                workspace,
                case["verifierTimeoutSeconds"],
                directory / "verifier.stdout",
                directory / "verifier.stderr",
            )
            result["verification"] = verification
            result["taskPassed"] = task_passed(result)
        finally:
            cleanup = run_process(
                [str(ash), "app-server", "daemon", "stop"],
                workspace,
                environment,
                15,
                directory / "cleanup.stdout",
                directory / "cleanup.stderr",
            )
            result["cleanup"] = cleanup
    finally:
        cleanup = result.get("cleanup")
        if cleanup and cleanup["exitCode"] == 0 and not cleanup["timedOut"]:
            shutil.rmtree(temporary)
        else:
            # Preserve the exact daemon endpoint for an explicit cleanup retry after a failure.
            result["retainedProfile"] = str(temporary / "profile")
    subprocess.run(
        ["git", "add", "--all"],
        cwd=workspace,
        env=git_environment,
        capture_output=True,
        check=True,
    )
    patch = subprocess.check_output(
        [
            "git",
            "-c",
            "core.quotePath=false",
            "diff",
            "--cached",
            "--no-ext-diff",
            "--binary",
            "HEAD",
        ],
        cwd=workspace,
        env=git_environment,
    )
    (directory / "changes.patch").write_bytes(patch)
    (directory / "result.json").write_text(
        json.dumps(result, indent=2) + "\n", encoding="utf-8"
    )
    return result


PROCESS_METRICS = (
    "elapsedSeconds",
    "modelCalls",
    "toolCalls",
    "failedToolResults",
    "modelAttempts",
    "failedAttempts",
    "inputTokensReported",
    "outputTokensReported",
)


def metric_observation(run: dict, metric: str) -> tuple[int | float | None, bool]:
    if metric == "elapsedSeconds":
        value = run["execution"].get(metric)
        complete = value is not None
    else:
        trace = run.get("trace") or {}
        if trace.get("captureStatus") != "saved" or trace.get(
            "analysisVersion"
        ) not in {1, 2}:
            return None, False
        value = trace.get(metric)
        complete = value is not None
        if metric in {"modelAttempts", "failedAttempts"}:
            complete = complete and trace["diagnosticEvidenceComplete"] is True
        elif metric in {"inputTokensReported", "outputTokensReported"}:
            complete = (
                complete
                and trace["usage"][metric.removesuffix("Reported")]["complete"] is True
                and trace.get("usageComparisonComplete") is True
            )
    if value is not None and (
        type(value) not in {int, float}
        or value < 0
        or (type(value) is float and not math.isfinite(value))
    ):
        raise ValueError(f"invalid evaluation metric: {metric}")
    return value, complete


def summarize(runs: list[dict]) -> dict:
    count = len(runs)
    cases: dict[str, list[bool]] = {}
    for run in runs:
        cases.setdefault(run["caseId"], []).append(run["taskPassed"])
    trial_counts = {len(trials) for trials in cases.values()}
    metrics = {}
    for metric in PROCESS_METRICS:
        observations = [metric_observation(run, metric) for run in runs]
        reported = [value for value, _ in observations if value is not None]
        complete = [value for value, known in observations if known]
        metrics[metric] = {
            "reportedRuns": len(reported),
            "completeRuns": len(complete),
            "meanReported": sum(reported) / len(reported) if reported else None,
            "meanComplete": sum(complete) / len(complete) if complete else None,
        }
    return {
        "runs": count,
        "grading": {
            "gradedRuns": sum(
                run.get("verification", {}).get("status") in {"passed", "failed"}
                for run in runs
            ),
            "errorRuns": sum(
                run.get("verification", {}).get("status") == "error" for run in runs
            ),
            "timedOutRuns": sum(
                run.get("verification", {}).get("status") == "timedOut" for run in runs
            ),
            "unknownRuns": sum(
                run.get("verification", {}).get("status")
                not in {"passed", "failed", "error", "timedOut"}
                for run in runs
            ),
        },
        "passed": sum(run["taskPassed"] for run in runs),
        "passRate": sum(run["taskPassed"] for run in runs) / count if count else None,
        "executionCompleted": sum(
            run["executionStatus"] == "completed" for run in runs
        ),
        "timeouts": sum(run["executionStatus"] == "timedOut" for run in runs),
        "meanElapsedSeconds": metrics["elapsedSeconds"]["meanReported"],
        "repeatReliability": {
            "cases": len(cases),
            "trialsPerCase": next(iter(trial_counts))
            if len(trial_counts) == 1
            else None,
            "casesWithAnyPass": sum(any(trials) for trials in cases.values()),
            "casesWithAllPasses": sum(all(trials) for trials in cases.values()),
            # These describe the observed batch, not estimated pass@k or pass^k probabilities.
            "observedAnyPassRate": sum(any(trials) for trials in cases.values())
            / len(cases)
            if cases
            else None,
            "observedAllPassRate": sum(all(trials) for trials in cases.values())
            / len(cases)
            if cases
            else None,
        },
        "processMetrics": metrics,
    }


def index_trials(report: dict) -> dict[tuple[str, int], dict]:
    if report.get("schemaVersion", 1) not in {1, 2}:
        raise ValueError("unsupported agent evaluation report version")
    trials = {}
    repetitions = report["configuration"]["repetitions"]
    if type(repetitions) is not int or repetitions < 1:
        raise ValueError("report must declare a positive repetition count")
    for run in report["runs"]:
        identity = (run["caseId"], run["repetition"])
        if (
            identity in trials
            or not isinstance(run["caseId"], str)
            or not run["caseId"]
            or type(run["taskPassed"]) is not bool
            or type(run["repetition"]) is not int
            or not 1 <= run["repetition"] <= repetitions
        ):
            raise ValueError(
                "baseline comparison requires unique valid trial identities"
            )
        trials[identity] = run
    cases = {identity for identity, _ in trials}
    selection = report["configuration"].get("caseSelection")
    if selection is not None and (
        not isinstance(selection, dict)
        or selection.get("split") not in {"all", "development", "holdout"}
        or not isinstance(selection.get("caseIds"), list)
        or len(selection["caseIds"]) != len(cases)
        or set(selection["caseIds"]) != cases
    ):
        raise ValueError("report trials differ from its declared case selection")
    if not trials or set(trials) != {
        (identity, repetition)
        for identity in cases
        for repetition in range(1, repetitions + 1)
    }:
        raise ValueError("baseline comparison requires every declared repetition")
    return trials


def compare(report: dict, baseline: dict) -> dict:
    changed = changed_conditions(report["configuration"], baseline["configuration"])
    current_trials = index_trials(report)
    baseline_trials = index_trials(baseline)
    if current_trials.keys() != baseline_trials.keys():
        raise ValueError("baseline has incompatible task trial identities")
    cases = {}
    same_environment = all(
        isinstance(report["configuration"].get(key), str)
        and bool(report["configuration"][key])
        and report["configuration"][key] == baseline["configuration"].get(key)
        for key in ("platform", "python")
    )
    for identity in sorted({run["caseId"] for run in report["runs"]}):
        current = summarize(
            [run for run in report["runs"] if run["caseId"] == identity]
        )
        previous = summarize(
            [run for run in baseline["runs"] if run["caseId"] == identity]
        )
        pairs = [
            (baseline_trials[key], current_trials[key])
            for key in sorted(current_trials)
            if key[0] == identity
        ]
        process_metrics = {}
        for metric in PROCESS_METRICS:
            values = []
            for old, new in pairs:
                old_value, old_complete = metric_observation(old, metric)
                new_value, new_complete = metric_observation(new, metric)
                if (
                    old_complete
                    and new_complete
                    and (metric != "elapsedSeconds" or same_environment)
                ):
                    values.append((old_value, new_value))
            process_metrics[metric] = {
                "pairedRuns": len(values),
                "excludedRuns": len(pairs) - len(values),
                "baselineMean": sum(old for old, _ in values) / len(values)
                if values
                else None,
                "currentMean": sum(new for _, new in values) / len(values)
                if values
                else None,
                "meanDelta": sum(new - old for old, new in values) / len(values)
                if values
                else None,
            }
        cases[identity] = {
            "baseline": previous,
            "current": current,
            "passRateDelta": current["passRate"] - previous["passRate"],
            "recoveredTrials": sum(
                not old["taskPassed"] and new["taskPassed"] for old, new in pairs
            ),
            "regressedTrials": sum(
                old["taskPassed"] and not new["taskPassed"] for old, new in pairs
            ),
            "processMetrics": process_metrics,
        }
    return {
        "baselineModel": baseline["configuration"]["model"],
        "changedFactors": changed,
        "cases": cases,
    }


def baseline_preflight(configuration: dict, cases: list[dict], baseline: dict) -> None:
    """Reject incompatible or incomplete controls before any product/model call."""
    changed_conditions(configuration, baseline["configuration"])
    trials = index_trials(baseline)
    expected = {
        (case["id"], repetition)
        for case in cases
        for repetition in range(1, configuration["repetitions"] + 1)
    }
    if trials.keys() != expected:
        raise ValueError("baseline has incompatible task trial identities")
    # Validate retained metric values too; a malformed control cannot consume a new batch.
    summarize(list(trials.values()))


def render_report(report: dict) -> str:
    summary = report["summary"]
    reliability = summary["repeatReliability"]
    rows = [
        "# Agent task evaluation",
        "",
        f"Model: `{report['configuration']['model']}`. Passed {summary['passed']} / {summary['runs']} independent task checks.",
        "",
        f"Observed repeated trials: {reliability['casesWithAnyPass']} / {reliability['cases']} tasks passed at least once; {reliability['casesWithAllPasses']} / {reliability['cases']} passed every trial ({reliability['trialsPerCase']} trials per task). These are batch observations, not estimated pass@k / pass^k probabilities.",
        "",
        "| Case | Repeat | Execution | Verifier | Passed | Artifacts |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    if grading := summary.get("grading"):
        rows[4:4] = [
            f"Grading coverage: {grading['gradedRuns']} / {summary['runs']} runs graded; {grading['errorRuns']} grader errors, {grading['timedOutRuns']} grader timeouts, {grading['unknownRuns']} unknown. Verifier exit 0 means pass, 1 means task failure, and any other exit means grading error.",
            "",
        ]
    for run in report["runs"]:
        directory = run["artifactDirectory"]
        trace = (
            f"[trace]({directory}/trace.json)"
            if run["trace"]["captureStatus"] == "saved"
            else run["trace"]["captureStatus"]
        )
        rows.append(
            f"| {run['caseId']} | {run['repetition']} | {run['executionStatus']} | {run['verification']['status']} | {run['taskPassed']} | [result]({directory}/result.json), {trace}, [changes]({directory}/changes.patch) |"
        )
    rows.extend(
        [
            "",
            "## Process evidence",
            "",
            "Reported means use only available measurements. Complete means exclude missing or partial evidence. modelCalls counts durable accounting records; modelAttempts counts observed ModelService operations. Failed attempts have no authoritative link to accounting, so their runs do not enter complete usage comparisons. Tool errors and loop stops are observations, not task grades or explanations of cause.",
            "",
            "| Metric | Reported runs | Complete runs | Reported mean | Complete mean |",
            "| --- | --- | --- | --- | --- |",
        ]
    )

    def display(value: float | None) -> str:
        return "unknown" if value is None else f"{value:.3f}"

    for metric, values in summary["processMetrics"].items():
        rows.append(
            f"| {metric} | {values['reportedRuns']} / {summary['runs']} | {values['completeRuns']} / {summary['runs']} | {display(values['meanReported'])} | {display(values['meanComplete'])} |"
        )
    for run in report["runs"]:
        trace = run["trace"]
        if trace.get("analysisVersion") not in {1, 2}:
            continue
        directory = run["artifactDirectory"]
        coverage = trace["evidenceCoverage"]
        rows.extend(
            [
                "",
                f"### {run['caseId']} · trial {run['repetition']}",
                "",
                f"Diagnostic recording: `{trace['diagnosticRecordingStatus']}`; complete exported evidence: `{trace['diagnosticEvidenceComplete']}`. Dropped records: {coverage['droppedRecords']}; pending persistence: {coverage.get('pendingRecords', 0)}; unlinked attempts: {display(coverage.get('unlinkedAttempts'))}; unobserved accounting: {display(coverage.get('unobservedInvocations'))}; omitted payloads: {coverage['omittedPayloads']}; missing payloads: {coverage['missingPayloads']}; truncated payloads: {coverage['truncatedPayloads']}; unclosed attempts: {coverage['unclosedAttempts']}; orphaned terminal attempts: {coverage['orphanedAttempts']}.",
                f"Usage complete for retained accounting: `{trace['usageComplete']}`; attempt coverage permits a complete usage comparison: `{trace['usageComparisonComplete']}`. Each token dimension must also have complete provider measurements.",
                "",
                f"Loop decision evidence: `{trace['loopDecisionEvidence']}`. Loop actions: `{json.dumps(trace['loopActions'], sort_keys=True)}`. Loop reasons: `{json.dumps(trace['loopReasons'], sort_keys=True)}`. Pending tool results: {trace['pendingToolResults']}; unmatched results: {trace['unmatchedToolResults']}.",
                "",
                f"Frozen instruction selections and all evidence references are in [result]({directory}/result.json). Import [trace]({directory}/trace.json) into Execution Trace and filter by the event ID below.",
            ]
        )
        observations = trace["observations"]
        if observations:
            rows.extend(
                [
                    "",
                    "| Observation | Source | Thread | Turn | Sequence | Event ID |",
                    "| --- | --- | --- | --- | --- | --- |",
                ]
            )
            for observation in observations[:40]:
                ref = observation["source"]
                rows.append(
                    f"| {observation['kind']} | {ref['source']} | `{ref['threadId']}` | `{ref['turnId']}` | {ref['sequence']} | `{ref['eventId']}` |"
                )
            if len(observations) > 40:
                rows.extend(
                    [
                        "",
                        f"Showing 40 / {len(observations)} observations; the result artifact retains every reference.",
                    ]
                )
    comparison = report.get("comparison")
    if comparison and comparison.get("status") == "rejected":
        rows.extend(["", f"Baseline comparison rejected: {comparison['reason']}."])
    elif comparison:
        rows.extend(
            [
                "",
                "## Baseline comparison",
                "",
                f"Baseline model: `{comparison['baselineModel']}`. Changed recorded factors: `{', '.join(comparison['changedFactors']) or 'none'}`. Changes in several factors cannot be attributed to one prompt or model from this comparison.",
                "",
                "| Case | Baseline pass rate | Current pass rate | Change | Recovered trials | Regressed trials |",
                "| --- | --- | --- | --- | --- | --- |",
            ]
        )
        for identity, case in comparison["cases"].items():
            rows.append(
                f"| {identity} | {case['baseline']['passRate']:.1%} | {case['current']['passRate']:.1%} | {case['passRateDelta']:+.1%} | {case['recoveredTrials']} | {case['regressedTrials']} |"
            )
        rows.extend(
            [
                "",
                "Only matching trial identities with complete measurements on both sides enter process deltas. Review task acceptance alongside resource use; a faster failure is not an improvement.",
                "",
                "| Case | Metric | Paired trials | Excluded trials | Baseline mean | Current mean | Change |",
                "| --- | --- | --- | --- | --- | --- | --- |",
            ]
        )
        for identity, case in comparison["cases"].items():
            for metric, values in case["processMetrics"].items():
                rows.append(
                    f"| {identity} | {metric} | {values['pairedRuns']} | {values['excludedRuns']} | {display(values['baselineMean'])} | {display(values['currentMean'])} | {display(values['meanDelta'])} |"
                )
    return "\n".join(rows) + "\n"


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ash", type=Path, required=True)
    parser.add_argument("--profile-template", type=Path, required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--suite", type=Path, default=ROOT / "test/agent-eval")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--timeout-seconds", type=int, default=120)
    parser.add_argument(
        "--approval",
        choices=["denyInteractiveRequests", "automaticReview", "bypassPermissions"],
        default="denyInteractiveRequests",
    )
    parser.add_argument("--baseline", type=Path)
    parser.add_argument(
        "--experiment",
        type=Path,
        help="Version 1 hypothesis, variant and explicitly allowed condition changes",
    )
    parser.add_argument(
        "--split", choices=["all", "development", "holdout"], default="all"
    )
    parser.add_argument(
        "--preflight-only",
        action="store_true",
        help="Validate inputs and comparison conditions without running a model.",
    )
    args = parser.parse_args(arguments)
    if args.repeat < 1 or args.timeout_seconds < 1 or "/" not in args.model:
        parser.error(
            "model, repetition count and timeout must be explicit valid values"
        )
    ash, template, suite, output = (
        path.resolve()
        for path in [args.ash, args.profile_template, args.suite, args.output]
    )
    if not ash.is_file() or not template.is_dir():
        parser.error("ash executable and profile template must exist")
    if output.exists() or output.is_relative_to(suite):
        parser.error("output must be a new directory outside the versioned suite")
    cases = select_cases(load_suite(suite), args.split)
    profile_config = (
        (template / "config.toml").read_bytes()
        if (template / "config.toml").is_file()
        else b""
    )
    configuration = {
        "suiteDigest": suite_digest(suite),
        "suiteDigestVersion": 2,
        "profileConfigDigest": hashlib.sha256(profile_config).hexdigest(),
        "model": args.model,
        "timeoutSeconds": args.timeout_seconds,
        "approval": args.approval,
        "repetitions": args.repeat,
        "caseSelection": {
            "split": args.split,
            "caseIds": [case["id"] for case in cases],
        },
        "ashExecutable": str(ash),
        "ashExecutableDigest": product_file_identity(ash)["sha256"],
        "appServerExecutable": product_file_identity(
            Path(os.environ["ASH_APP_SERVER_PATH"])
            if os.environ.get("ASH_APP_SERVER_PATH")
            else ash.with_name(
                "ash-app-server.exe" if os.name == "nt" else "ash-app-server"
            )
        ),
        "platform": platform.platform(),
        "python": platform.python_version(),
    }
    if args.experiment:
        configuration["experiment"] = load_experiment(args.experiment.resolve())
        configuration["profileFactors"] = profile_factors(profile_config)
    if os.environ.get("ASH_PRODUCT_SERVICES_PATH"):
        configuration["productServices"] = product_file_identity(
            Path(os.environ["ASH_PRODUCT_SERVICES_PATH"])
        )
    baseline = None
    try:
        if args.baseline:
            baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
            baseline_preflight(configuration, cases, baseline)
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.error(f"baseline preflight rejected: {error}")
    if args.preflight_only:
        print(json.dumps({"status": "ready", "configuration": configuration}, indent=2))
        return 0
    output.mkdir(parents=True, exist_ok=False)
    (output / "configuration.json").write_text(
        json.dumps(configuration, indent=2) + "\n", encoding="utf-8"
    )
    runs = []
    for case in cases:
        for repetition in range(1, args.repeat + 1):
            runs.append(
                run_case(
                    case,
                    repetition,
                    suite,
                    output,
                    ash,
                    template,
                    args.model,
                    args.timeout_seconds,
                    args.approval,
                )
            )
    report = {
        "schemaVersion": 2,
        "configuration": configuration,
        "runs": runs,
        "summary": summarize(runs),
    }
    if baseline is not None:
        try:
            report["comparison"] = compare(report, baseline)
        except (ValueError, KeyError, TypeError, ZeroDivisionError) as error:
            report["comparison"] = {"status": "rejected", "reason": str(error)}
    (output / "report.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8"
    )
    (output / "report.md").write_text(render_report(report), encoding="utf-8")
    print(
        json.dumps(
            {"report": str(output / "report.json"), "summary": report["summary"]}
        )
    )
    healthy = all(
        run["cleanup"]["exitCode"] == 0
        and not run["cleanup"]["timedOut"]
        and run["trace"]["captureStatus"] == "saved"
        for run in runs
    )
    return (
        0
        if healthy
        and all(run["taskPassed"] for run in runs)
        and report.get("comparison", {}).get("status") != "rejected"
        else 1
    )


if __name__ == "__main__":
    raise SystemExit(main())
