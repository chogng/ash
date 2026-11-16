"""Select Ash's reusable CI workflows and require their declared results."""

from __future__ import annotations

import argparse
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen
import zipfile

from check_blob_size import changed_paths


ROOT = Path(__file__).resolve().parents[1]
POLICY = ROOT / ".github/ci-workflows.json"
CONTROL_PATHS = {
    ".just-version",
    ".github/actions/setup-just/action.yml",
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


class ArtifactRedirect(HTTPRedirectHandler):
    """Never forward the repository credential to artifact storage."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urlsplit(newurl).scheme != "https":
            raise ValueError("Artifact redirects require HTTPS")
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected is not None and urlsplit(newurl).netloc != "api.github.com":
            redirected.remove_header("Authorization")
        return redirected


def main_baseline(root: Path, head: str, repository: str, token: str, policy: dict):
    """Cover dropped pending commits and retry failures without rerunning successful domains.

    The last completed push supplies both the diff base and the selected domain
    results. Missing, expired or incompatible evidence falls back to a full run.
    """
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository) or not token:
        raise ValueError("main CI selection requires a repository and GitHub token")
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    api = f"https://api.github.com/repos/{repository}"

    def get(path):
        with urlopen(Request(api + path, headers=headers), timeout=30) as response:
            return json.loads(response.read(2 * 1024 * 1024))

    runs = get(
        "/actions/workflows/blocking-ci.yml/runs?branch=main&event=push&status=completed&per_page=1"
    )["workflow_runs"]
    if not isinstance(runs, list):
        raise ValueError("GitHub workflow runs must be a list")
    if not runs:
        return None
    if not isinstance(runs[0], dict):
        raise ValueError("completed CI run must be an object")
    base = runs[0].get("head_sha")
    if not isinstance(base, str) or not re.fullmatch(r"[0-9a-f]{40}", base):
        raise ValueError("completed CI run has an invalid commit SHA")
    # A replaced history cannot establish coverage for the current branch.
    ancestor = subprocess.run(
        ["git", "merge-base", "--is-ancestor", base, head], cwd=root, check=False
    )
    if ancestor.returncode != 0:
        return None
    run_id = runs[0].get("id")
    if type(run_id) is not int or run_id <= 0:
        raise ValueError("completed CI run has an invalid run ID")
    artifacts = get(f"/actions/runs/{run_id}/artifacts?per_page=100")["artifacts"]
    if not isinstance(artifacts, list) or not all(
        isinstance(a, dict) for a in artifacts
    ):
        raise ValueError("Invalid CI artifact listing")
    matching = [
        a
        for a in artifacts
        if a.get("name") == f"ci-results-{run_id}" and not a.get("expired")
    ]
    if len(matching) != 1:
        return None
    artifact_id = matching[0].get("id")
    if type(artifact_id) is not int or artifact_id <= 0:
        raise ValueError("invalid CI evidence artifact ID")
    opener = build_opener(ArtifactRedirect())
    with opener.open(
        Request(f"{api}/actions/artifacts/{artifact_id}/zip", headers=headers),
        timeout=30,
    ) as response:
        archive = response.read(2 * 1024 * 1024 + 1)
    if len(archive) > 2 * 1024 * 1024:
        raise ValueError("CI evidence archive is too large")
    with zipfile.ZipFile(io.BytesIO(archive)) as source:
        member = source.getinfo("ci-results.json")
        if member.file_size > 1024 * 1024:
            raise ValueError("CI evidence document is too large")
        record = json.loads(source.read(member))
    if not isinstance(record, dict):
        raise ValueError("CI evidence must be an object")
    if (
        record.get("schemaVersion") != 1
        or record.get("sha") != base
        or record.get("runId") != run_id
    ):
        raise ValueError("CI evidence does not match the completed run")
    selection, results = record.get("selection"), record.get("results")
    if (
        not isinstance(results, dict)
        or set(results) != set(policy)
        or any(
            not isinstance(value, dict)
            or value.get("result") not in {"success", "failure", "cancelled", "skipped"}
            for value in results.values()
        )
    ):
        raise ValueError("invalid domain results in CI evidence")
    # Reuse the required gate's boundary contract, including exact workflow keys.
    require_results({"select": {"result": "success"}, **results}, selection, policy)
    retry = {
        name
        for name in policy
        if selection[name] and results[name].get("result") != "success"
    }
    return base, retry


def record_results(
    path: Path, needs: dict, selection: dict, policy: dict, sha: str, run_id: str
):
    # Failure conclusions are legitimate evidence; malformed/incomplete selection is not.
    require_results(needs, selection, policy)
    if needs["select"].get("result") != "success":
        raise ValueError("cannot record results after selection failed")
    if not re.fullmatch(r"[0-9a-f]{40}", sha) or not re.fullmatch(
        r"[1-9][0-9]*", run_id
    ):
        raise ValueError("invalid CI evidence identity")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "sha": sha,
                "runId": int(run_id),
                "selection": selection,
                "results": {name: needs[name] for name in policy},
            }
        ),
        encoding="utf-8",
    )


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
    selection_parser.add_argument("--since-completed-main", action="store_true")
    subparsers.add_parser("require")
    record_parser = subparsers.add_parser("record")
    record_parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(arguments)
    try:
        policy = load_policy(args.policy)
        if args.operation == "select":
            base = args.base
            force_all = args.all
            retry = set()
            if args.since_completed_main and not force_all:
                try:
                    evidence = main_baseline(
                        ROOT,
                        args.head,
                        os.environ["GITHUB_REPOSITORY"],
                        os.environ["GITHUB_TOKEN"],
                        policy,
                    )
                except (
                    OSError,
                    ValueError,
                    KeyError,
                    TypeError,
                    zipfile.BadZipFile,
                    URLError,
                ) as error:
                    print(
                        f"CI baseline unavailable; selecting every check: {type(error).__name__}",
                        file=sys.stderr,
                    )
                    evidence = None
                force_all = evidence is None
                if evidence is not None:
                    base, retry = evidence
            paths = changed_paths(ROOT, base, args.head, include_deleted=True)
            selection = select(paths, policy, force_all)
            for name in retry:
                selection[name] = True
            serialized = json.dumps(selection, separators=(",", ":"))
            print(serialized)
            if output := os.environ.get("GITHUB_OUTPUT"):
                with open(output, "a", encoding="utf-8") as stream:
                    stream.write(f"selection={serialized}\n")
        elif args.operation == "record":
            record_results(
                args.output,
                json.loads(os.environ["NEEDS_JSON"]),
                json.loads(os.environ["CI_SELECTION_JSON"]),
                policy,
                os.environ["GITHUB_SHA"],
                os.environ["GITHUB_RUN_ID"],
            )
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
