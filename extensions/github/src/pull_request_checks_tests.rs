use super::*;
use crate::tests::FakeHttp;
use crate::tests::github;
use crate::tests::repository;
use serde_json::Value;
use std::sync::Arc;

const HEAD: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BASE: &str = "release/stable";
const MERGE: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn rollup(head: &str, checks: Vec<Value>, cursor: Option<&str>) -> Value {
    json!({
        "data": {"repository": {"pullRequest": {
            "baseRefName": BASE, "headRefOid": head,
            "commits": {"nodes": [{"commit": commit(head, checks, cursor)}]}
        }}}
    })
}

fn commit(oid: &str, checks: Vec<Value>, cursor: Option<&str>) -> Value {
    json!({"oid": oid, "statusCheckRollup": {
        "contexts": {"nodes": checks, "pageInfo": {"hasNextPage": cursor.is_some(), "endCursor": cursor}}
    }})
}

fn with_merge(mut pr: Value, merge: Value) -> Value {
    pr["data"]["repository"]["pullRequest"]["potentialMergeCommit"] = merge;
    pr
}

fn check(name: &str, conclusion: &str, required: bool) -> Value {
    json!({"__typename":"CheckRun", "name":name, "status":"COMPLETED", "conclusion":conclusion, "isRequired":required})
}

#[tokio::test(flavor = "current_thread")]
async fn combines_classic_protection_with_rulesets_and_waits_for_an_unreported_required_check() {
    let http = Arc::new(FakeHttp::default());
    http.push(
        200,
        rollup(
            HEAD,
            vec![
                check("build", "SUCCESS", true),
                check("gate", "SUCCESS", false),
            ],
            None,
        ),
    );
    http.push(200, json!({"name":BASE,"protection":{"required_status_checks":{"enforcement_level":"everyone","contexts":["build"]}}}));
    http.push(200, json!([{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"gate"}]}}]));
    let status = github(http.clone())
        .pull_request_checks(&repository(), 7, HEAD)
        .await
        .unwrap();
    assert_eq!(status.status, PullRequestChecksStatus::Pending);
    assert_eq!(status.unreported_required_checks, ["gate"]);
    let requests = http.requests.lock().unwrap();
    assert!(requests[1].url().ends_with("branches/release%2Fstable"));
    assert!(
        requests[2]
            .url()
            .ends_with("rules/branches/release%2Fstable?per_page=100&page=1")
    );
}

#[tokio::test(flavor = "current_thread")]
async fn passing_required_checks_ignore_optional_failures_across_rollup_pages() {
    let http = Arc::new(FakeHttp::default());
    let mut optional = check("lint", "FAILURE", false);
    optional["completedAt"] = json!("1970-01-01T00:01:00Z");
    let mut required = check("build", "SUCCESS", true);
    required["completedAt"] = json!("1970-01-01T01:00:30+01:00");
    required["startedAt"] = json!("1970-01-01T00:00:40Z");
    http.push(
        200,
        rollup(
            HEAD,
            vec![check("build", "FAILURE", false), optional],
            Some("next"),
        ),
    );
    http.push(200, rollup(HEAD, vec![
        required,
        json!({"__typename":"StatusContext", "context":"gate", "state":"SUCCESS", "isRequired":true}),
    ], None));
    http.push(200, json!({"name":BASE,"protection":{"required_status_checks":{"checks":[{"context":"build"}]}}}));
    http.push(200, json!([{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"gate"}]}}]));
    let status = github(http.clone())
        .pull_request_checks(&repository(), 7, HEAD)
        .await
        .unwrap();
    assert_eq!(status.status, PullRequestChecksStatus::Success);
    assert_eq!(status.latest_check_at_unix_ms, Some(30_000));
    let requests = http.requests.lock().unwrap();
    let query: Value = serde_json::from_slice(requests[1].body()).unwrap();
    assert_eq!(query["variables"]["headCursor"], "next");
    assert!(query["variables"]["mergeCursor"].is_null());
    assert_eq!(query["variables"]["number"], 7);
    let query = query["query"].as_str().unwrap();
    assert!(query.contains("completedAt startedAt"));
}

#[tokio::test(flavor = "current_thread")]
async fn uses_the_test_merge_checks_and_paginates_them_independently() {
    let http = Arc::new(FakeHttp::default());
    http.push(
        200,
        with_merge(
            rollup(HEAD, vec![check("build", "SUCCESS", true)], Some("head")),
            commit(MERGE, vec![check("build", "FAILURE", true)], Some("merge")),
        ),
    );
    let mut required = check("gate", "SUCCESS", true);
    required["completedAt"] = json!("1970-01-01T00:00:10Z");
    http.push(
        200,
        with_merge(
            rollup(HEAD, vec![check("build", "SUCCESS", true)], Some("head")),
            commit(MERGE, vec![required], None),
        ),
    );
    http.push(200, json!({"name": BASE}));
    http.push(200, json!([]));
    let status = github(http.clone())
        .pull_request_checks(&repository(), 7, HEAD)
        .await
        .unwrap();
    assert_eq!(status.status, PullRequestChecksStatus::Failure);
    assert_eq!(status.latest_check_at_unix_ms, Some(10_000));
    let requests = http.requests.lock().unwrap();
    let query: Value = serde_json::from_slice(requests[1].body()).unwrap();
    assert!(
        query["query"]
            .as_str()
            .unwrap()
            .contains("potentialMergeCommit")
    );
    assert_eq!(query["variables"]["mergeCursor"], "merge");
    assert!(query["variables"]["headCursor"].is_null());
}

#[tokio::test(flavor = "current_thread")]
async fn an_empty_test_merge_rollup_uses_the_head_checks() {
    let http = Arc::new(FakeHttp::default());
    http.push(
        200,
        with_merge(
            rollup(HEAD, vec![check("build", "SUCCESS", true)], None),
            commit(MERGE, Vec::new(), None),
        ),
    );
    http.push(200, json!({"name": BASE}));
    http.push(200, json!([]));
    let status = github(http)
        .pull_request_checks(&repository(), 7, HEAD)
        .await
        .unwrap();
    assert_eq!(status.status, PullRequestChecksStatus::Success);
}

#[tokio::test(flavor = "current_thread")]
async fn drops_partial_checks_when_the_test_merge_commit_changes() {
    let http = Arc::new(FakeHttp::default());
    http.push(
        200,
        with_merge(
            rollup(HEAD, Vec::new(), None),
            commit(MERGE, vec![check("build", "FAILURE", true)], Some("next")),
        ),
    );
    http.push(
        200,
        with_merge(
            rollup(HEAD, Vec::new(), None),
            commit(&"c".repeat(40), vec![check("gate", "SUCCESS", true)], None),
        ),
    );
    let status = github(http.clone())
        .pull_request_checks(&repository(), 7, HEAD)
        .await
        .unwrap();
    assert_eq!(status.status, PullRequestChecksStatus::Pending);
    assert_eq!(status.latest_check_at_unix_ms, None);
    assert_eq!(http.requests.lock().unwrap().len(), 2);
}

#[tokio::test(flavor = "current_thread")]
async fn drops_a_rollup_when_the_pr_head_changes_during_pagination() {
    let http = Arc::new(FakeHttp::default());
    http.push(
        200,
        rollup(HEAD, vec![check("build", "SUCCESS", true)], Some("next")),
    );
    http.push(200, rollup(&"b".repeat(40), Vec::new(), None));
    let status = github(http.clone())
        .pull_request_checks(&repository(), 7, HEAD)
        .await
        .unwrap();
    assert_eq!(status.status, PullRequestChecksStatus::Pending);
    assert_eq!(status.latest_check_at_unix_ms, None);
    assert_eq!(http.requests.lock().unwrap().len(), 2);
}

#[test]
fn no_branch_requirements_use_all_reported_checks_and_an_empty_rollup_is_neutral() {
    let optional: Check = serde_json::from_value(check("lint", "FAILURE", false)).unwrap();
    assert_eq!(
        summarize_checks(&[optional], HashSet::new()).status,
        PullRequestChecksStatus::Failure
    );
    assert_eq!(
        summarize_checks(&[], HashSet::new()),
        PullRequestChecks {
            status: PullRequestChecksStatus::Neutral,
            latest_check_at_unix_ms: None,
            unreported_required_checks: Vec::new(),
        },
    );
}

#[test]
fn failing_rollup_keeps_the_latest_timestamp_after_the_first_failure() {
    let mut failed = check("build", "FAILURE", true);
    failed["completedAt"] = json!("1970-01-01T00:00:20Z");
    let mut running = check("gate", "SUCCESS", true);
    running["status"] = json!("IN_PROGRESS");
    running["completedAt"] = json!("invalid");
    running["startedAt"] = json!("1970-01-01T00:00:25.125Z");
    let checks = serde_json::from_value::<Vec<Check>>(json!([failed, running])).unwrap();
    assert_eq!(
        summarize_checks(&checks, HashSet::new()),
        PullRequestChecks {
            status: PullRequestChecksStatus::Failure,
            latest_check_at_unix_ms: Some(25_125),
            unreported_required_checks: Vec::new(),
        },
    );
}
