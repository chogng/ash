#!/usr/bin/env python3
"""Offline GitHub fixture for the actual CLI process; never accesses a network."""

import json
from pathlib import Path
import subprocess
import sys
from urllib.parse import parse_qs, unquote

root = Path(sys.argv[0]).parent
if sys.argv[1:3] == ["pr", "merge"]:
    (root / "auto-merge.json").write_text(json.dumps({"args": sys.argv[1:]}))
    count = root / "auto-merge-count"
    count.write_text(str(int(count.read_text()) + 1 if count.exists() else 1))
    print("Fixture rejected auto-merge", file=sys.stderr)
    raise SystemExit(1)
endpoint = sys.argv[6]
method = sys.argv[5]
with (root / "issue-requests.jsonl").open("a") as log:
    log.write(json.dumps(endpoint) + "\n")
if (root / "issue-offline").exists():
    print("Fixture offline", file=sys.stderr)
    raise SystemExit(1)
pull = root / "pull.json"


def respond(value):
    print(json.dumps(value))
    raise SystemExit(0)


def read(name):
    value = json.loads((root / name).read_text())
    if isinstance(value, dict) and "number" in value and "pull_request" not in value and name in ["3.json", "5.json"]:
        value.setdefault("node_id", "ISSUE_" + str(value["number"]))
        value.setdefault("labels", [])
        value.setdefault("assignees", [])
    return value


labels_path = root / "labels.json"
labels = read("labels.json") if labels_path.exists() else []
if endpoint.startswith("repos/team/repo/labels?"):
    respond(labels)
if endpoint == "repos/team/repo/labels" and method == "POST":
    body = json.load(sys.stdin)
    label = dict(body, node_id="LABEL_" + body["name"])
    labels.append(label)
    labels_path.write_text(json.dumps(labels))
    respond(label)
if endpoint.startswith("repos/team/repo/labels/") and method == "PATCH":
    name = unquote(endpoint.rsplit("/", 1)[1])
    body = json.load(sys.stdin)
    label = next(label for label in labels if label["name"] == name)
    label.update(body)
    labels_path.write_text(json.dumps(labels))
    respond(label)
if endpoint in ["repos/team/repo/issues/3", "repos/team/repo/issues/5"] and method == "PATCH":
    number = endpoint.rsplit("/", 1)[1]
    value = read(number + ".json")
    value.update(json.load(sys.stdin))
    (root / (number + ".json")).write_text(json.dumps(value))
    respond(value)
if endpoint.startswith("repos/team/repo/assignees?"):
    respond([{"login": "tester"}, {"login": "other"}])
if "/issues/" in endpoint and ("/assignees" in endpoint or "/labels" in endpoint):
    number = endpoint.split("/issues/", 1)[1].split("/", 1)[0]
    value = read(number + ".json")
    if endpoint.endswith("/assignees"):
        body = json.load(sys.stdin)
        value["assignees"] = ([account for account in value["assignees"] if account["login"] not in body["assignees"]] if method == "DELETE" else [{"login": login} for login in body["assignees"]])
    elif method == "DELETE":
        name = unquote(endpoint.rsplit("/", 1)[1])
        value["labels"] = [label for label in value["labels"] if label["name"] != name]
    else:
        body = json.load(sys.stdin)
        for name in body["labels"]:
            label = next(label for label in labels if label["name"] == name)
            if label not in value["labels"]:
                value["labels"].append(label)
    (root / (number + ".json")).write_text(json.dumps(value))
    respond(value if "/assignees" in endpoint else value["labels"])
if endpoint == "graphql":
    body = json.load(sys.stdin)
    branches_path = root / "linked-branches.json"
    branches = read("linked-branches.json") if branches_path.exists() else {}
    if "createLinkedBranch" in body["query"]:
        request = body["variables"]["input"]
        branch = {"id": "LINK_" + request["name"], "ref": {"name": request["name"], "target": {"oid": request["oid"]}}}
        branches.setdefault(request["issueId"], []).append(branch)
        branches_path.write_text(json.dumps(branches))
        subprocess.check_call(["/usr/bin/git", "--git-dir", str(root / "origin.git"), "update-ref", "refs/heads/" + request["name"], request["oid"]])
        respond({"data": {"createLinkedBranch": {"linkedBranch": branch}}})
    respond({"data": {"node": {"linkedBranches": {"nodes": branches.get(body["variables"]["id"], []), "pageInfo": {"hasNextPage": False}}}}})

if endpoint.startswith("search/issues?"):
    query = parse_qs(endpoint.split("?", 1)[1])
    assert query["per_page"] == ["100"]
    assert "repo:team/repo" in query["q"][0]
    assert "is:issue" in query["q"][0]
    respond({"items": [dict(read("5.json"), number=5001, html_url="https://github.com/team/repo/issues/5001", title="Search found issue outside the first page")], "total_count": 1, "incomplete_results": False})
if "/comments?" in endpoint:
    respond([])
if "/issues?" in endpoint:
    if "state=closed" in endpoint:
        closed = dict(read("3.json"), number=9, title="Previously resolved issue", state="closed")
        respond([closed])
    if "state=open" not in endpoint:
        raise RuntimeError("Issue state is required")
    query = parse_qs(endpoint.split("?", 1)[1])
    assert query["per_page"] == ["100"]
    page = int(query["page"][0])
    rows = read("issues.json")
    if "labels" in query:
        rows = [read(str(row["number"]) + ".json") for row in rows]
        required = query["labels"][0].split(",")
        rows = [row for row in rows if all(any(label["name"] == name for label in row["labels"]) for name in required)]
    respond(rows[(page - 1) * 100:page * 100])
if endpoint.endswith("/issues/3"):
    respond(read("3.json"))
if endpoint.endswith("/issues/5001"):
    respond(dict(read("5.json"), number=5001, html_url="https://github.com/team/repo/issues/5001", title="Repair issue outside loaded pages"))
if endpoint.endswith("/issues/5"):
    respond(read("5.json"))
if endpoint == "repos/team/repo":
    respond({"node_id": "REPO_fixture", "full_name": "team/repo", "default_branch": "main", "allow_merge_commit": True, "allow_squash_merge": True,
             "allow_rebase_merge": True, "allow_auto_merge": True})
if "/pulls?" in endpoint:
    respond([read("pull.json")] if pull.exists() else [])
if endpoint.endswith("/pulls") and method == "POST":
    body = json.load(sys.stdin)
    head = subprocess.check_output([
        "/usr/bin/git", "--git-dir", str(root / "origin.git"),
        "rev-parse", "refs/heads/" + body["head"],
    ], text=True).strip()
    base = subprocess.check_output([
        "/usr/bin/git", "--git-dir", str(root / "origin.git"),
        "rev-parse", "refs/heads/" + body["base"],
    ], text=True).strip()
    result = {"number": 7, "node_id": "PR_fixture", "html_url": "https://github.com/team/repo/pull/7",
              "state": "open", "draft": body["draft"], "merged_at": None,
              "head": {"sha": head, "ref": body["head"]},
              "base": {"sha": base, "ref": body["base"]}, "auto_merge": None}
    pull.write_text(json.dumps(result))
    count = root / "create-count"
    count.write_text(str(int(count.read_text()) + 1 if count.exists() else 1))
    (root / "submitted-pr.json").write_text(json.dumps(body))
    respond(result)
if endpoint.endswith("/pulls/7"):
    respond(read("pull.json"))
if endpoint.endswith("/status"):
    respond({"state": "success"})
if "/check-runs?" in endpoint:
    respond({"total_count": 0, "check_runs": []})
print("Unexpected fixture endpoint: " + endpoint, file=sys.stderr)
raise SystemExit(19)
