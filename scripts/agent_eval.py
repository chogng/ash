#!/usr/bin/env python3
"""Run fixed coding tasks through ash exec and verify their resulting workspaces."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]


def digest_files(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"suite fixtures must not contain symlinks: {path}")
        if path.is_file() and "__pycache__" not in path.parts:
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
    suite = json.loads((path / "suite.json").read_text(encoding="utf-8"))
    if (
        suite.get("schemaVersion") != 1
        or not isinstance(suite.get("cases"), list)
        or not suite["cases"]
    ):
        raise ValueError("expected a non-empty version 1 task suite")
    ids: set[str] = set()
    for case in suite["cases"]:
        identity = case.get("id", "")
        if (
            not identity
            or not all(
                character.isalnum() or character in "-_" for character in identity
            )
            or identity in ids
        ):
            raise ValueError("case ids must be unique path-safe names")
        ids.add(identity)
        if not isinstance(case.get("prompt"), str) or not case["prompt"].strip():
            raise ValueError(f"missing prompt: {identity}")
        for key, directory in [("fixture", True), ("verifier", False)]:
            target = (path / case[key]).resolve()
            if not target.is_relative_to(path) or not (
                target.is_dir() if directory else target.is_file()
            ):
                raise ValueError(f"invalid {key}: {identity}")
        if (
            not isinstance(case.get("verifierTimeoutSeconds"), int)
            or case["verifierTimeoutSeconds"] < 1
        ):
            raise ValueError(f"invalid verifier timeout: {identity}")
    return suite


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


def trace_metrics(path: Path) -> dict:
    if not path.is_file():
        return {"captureStatus": "missing"}
    trace = json.loads(path.read_text(encoding="utf-8"))
    if trace.get("formatVersion") != 3 or not isinstance(trace.get("threads"), list):
        raise ValueError("invalid rollout trace")
    invocations = [
        event["event"]["record"]
        for thread in trace["threads"]
        for event in thread["events"]
        if event["event"]["type"] == "modelInvocationRecorded"
    ]
    usage = [record.get("usage") or {} for record in invocations]
    diagnostics = trace.get("diagnostics") or {}
    observations = [record["event"] for record in diagnostics.get("events", [])]
    return {
        "captureStatus": "saved",
        "sessionId": trace["sessionId"],
        "threads": len(trace["threads"]),
        "modelCalls": len(invocations),
        "modelAttempts": sum(event["type"] == "modelAttemptStarted" for event in observations),
        "failedAttempts": sum(event["type"] == "modelAttemptFailed" for event in observations),
        "cancelledAttempts": sum(event["type"] == "modelAttemptCancelled" for event in observations),
        "diagnosticRecordingStatus": diagnostics.get("recordingStatus", "disabled"),
        "savedPayloads": len(diagnostics.get("payloads", {})),
        "failedModelCalls": sum(
            record["outcome"] == "failed" for record in invocations
        ),
        "inputTokensReported": sum(item.get("inputTokens") or 0 for item in usage),
        "outputTokensReported": sum(item.get("outputTokens") or 0 for item in usage),
        "usageComplete": bool(usage)
        and all(
            isinstance(item.get("inputTokens"), int)
            and isinstance(item.get("outputTokens"), int)
            for item in usage
        ),
    }


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
                result["trace"] = trace_metrics(trace)
            except (ValueError, KeyError, TypeError) as error:
                result["trace"] = {"captureStatus": "invalid", "error": str(error)}
            try:
                result["materialization"] = restore_turn_changes(
                    changes, workspace, result.get("outcome")
                )
            except (OSError, ValueError, KeyError, TypeError) as error:
                result["materialization"] = {"status": "failed", "error": str(error)}
            # The verifier is outside the agent workspace and runs after the product has finished.
            verification = run_process(
                [sys.executable, "-B", str(suite / case["verifier"]), str(workspace)],
                workspace,
                {**os.environ, "PYTHONOPTIMIZE": "0"},
                case["verifierTimeoutSeconds"],
                directory / "verifier.stdout",
                directory / "verifier.stderr",
            )
            verification["status"] = (
                "timedOut"
                if verification["timedOut"]
                else "passed"
                if verification["exitCode"] == 0
                else "failed"
            )
            result["verification"] = verification
            result["taskPassed"] = (
                result["executionStatus"] == "completed"
                and process["exitCode"] == 0
                and verification["status"] == "passed"
                and result["materialization"]["status"] == "restored"
            )
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


def summarize(runs: list[dict]) -> dict:
    return {
        "runs": len(runs),
        "passed": sum(run["taskPassed"] for run in runs),
        "passRate": sum(run["taskPassed"] for run in runs) / len(runs),
        "executionCompleted": sum(
            run["executionStatus"] == "completed" for run in runs
        ),
        "timeouts": sum(run["executionStatus"] == "timedOut" for run in runs),
        "meanElapsedSeconds": sum(run["execution"]["elapsedSeconds"] for run in runs)
        / len(runs),
    }


def compare(report: dict, baseline: dict) -> dict:
    for key in [
        "suiteDigest",
        "timeoutSeconds",
        "approval",
        "repetitions",
        "profileConfigDigest",
    ]:
        if report["configuration"][key] != baseline["configuration"][key]:
            raise ValueError(f"baseline has incompatible {key}")
    cases = {}
    for identity in sorted({run["caseId"] for run in report["runs"]}):
        current = summarize(
            [run for run in report["runs"] if run["caseId"] == identity]
        )
        previous = summarize(
            [run for run in baseline["runs"] if run["caseId"] == identity]
        )
        cases[identity] = {
            "baseline": previous,
            "current": current,
            "passRateDelta": current["passRate"] - previous["passRate"],
        }
    return {"baselineModel": baseline["configuration"]["model"], "cases": cases}


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
    cases = load_suite(suite)["cases"]
    output.mkdir(parents=True, exist_ok=False)
    profile_config = (
        (template / "config.toml").read_bytes()
        if (template / "config.toml").is_file()
        else b""
    )
    configuration = {
        "suiteDigest": digest_files(suite),
        "profileConfigDigest": hashlib.sha256(profile_config).hexdigest(),
        "model": args.model,
        "timeoutSeconds": args.timeout_seconds,
        "approval": args.approval,
        "repetitions": args.repeat,
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
    if os.environ.get("ASH_PRODUCT_SERVICES_PATH"):
        configuration["productServices"] = product_file_identity(
            Path(os.environ["ASH_PRODUCT_SERVICES_PATH"])
        )
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
        "schemaVersion": 1,
        "configuration": configuration,
        "runs": runs,
        "summary": summarize(runs),
    }
    if args.baseline:
        try:
            report["comparison"] = compare(
                report, json.loads(args.baseline.read_text(encoding="utf-8"))
            )
        except (ValueError, KeyError, TypeError, ZeroDivisionError) as error:
            report["comparison"] = {"status": "rejected", "reason": str(error)}
    (output / "report.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8"
    )
    rows = [
        "# Agent task evaluation",
        "",
        f"Model: `{args.model}`. Passed {report['summary']['passed']} / {len(runs)} independent task checks.",
        "",
        "| Case | Repeat | Execution | Verifier | Passed | Artifacts |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for run in runs:
        directory = run["artifactDirectory"]
        trace = (
            f"[trace]({directory}/trace.json)"
            if run["trace"]["captureStatus"] == "saved"
            else run["trace"]["captureStatus"]
        )
        rows.append(
            f"| {run['caseId']} | {run['repetition']} | {run['executionStatus']} | {run['verification']['status']} | {run['taskPassed']} | [result]({directory}/result.json), {trace}, [changes]({directory}/changes.patch) |"
        )
    comparison = report.get("comparison")
    if comparison and comparison.get("status") == "rejected":
        rows.extend(["", f"Baseline comparison rejected: {comparison['reason']}."])
    elif comparison:
        rows.extend(
            [
                "",
                f"Baseline model: `{comparison['baselineModel']}`.",
                "",
                "| Case | Baseline pass rate | Current pass rate | Change |",
                "| --- | --- | --- | --- |",
            ]
        )
        for identity, case in comparison["cases"].items():
            rows.append(
                f"| {identity} | {case['baseline']['passRate']:.1%} | {case['current']['passRate']:.1%} | {case['passRateDelta']:+.1%} |"
            )
    (output / "report.md").write_text("\n".join(rows) + "\n", encoding="utf-8")
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
