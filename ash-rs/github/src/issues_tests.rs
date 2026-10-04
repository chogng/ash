use super::*;

#[cfg(unix)]
fn fixture() -> (tempfile::TempDir, GitHub, Repository) {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("gh");
    std::fs::write(&script, r#"#!/usr/bin/env python3
import json,sys
from pathlib import Path
from urllib.parse import unquote
root=Path(__file__).parent
path=root/'issue.json'
issue=json.loads(path.read_text())
method,endpoint=sys.argv[5:7]
if method=='GET':
    result=[issue] if '/issues?' in endpoint else issue
else:
    if endpoint.endswith('/assignees'):
        owners=json.load(sys.stdin)['assignees']
        issue['assignees']=([owner for owner in issue['assignees'] if owner['login'] not in owners] if method=='DELETE' else [{'login':owner} for owner in owners])
    elif '/labels/' in endpoint:
        name=unquote(endpoint.rsplit('/',1)[1])
        issue['labels']=[label for label in issue['labels'] if label['name']!=name]
    elif endpoint.endswith('/labels'):
        if (root/'fail-add').exists():
            (root/'fail-add').unlink()
            raise SystemExit(9)
        for name in json.load(sys.stdin)['labels']:
            if not any(label['name']==name for label in issue['labels']): issue['labels'].append({'name':name,'color':'123456','node_id':name})
    else: raise SystemExit(10)
    path.write_text(json.dumps(issue))
    result=issue if endpoint.endswith('/assignees') else issue['labels']
print(json.dumps(result))
"#).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(dir.path().join("issue.json"), serde_json::json!({"number":18,"node_id":"issue18","title":"Implement","body":"requirements","html_url":"https://github.com/team/repo/issues/18","updated_at":"now","state":"open","labels":[{"name":"bug","color":"123456","node_id":"bug"},{"name":"queued","color":"123456","node_id":"queued"}],"assignees":[{"login":"me"}]}).to_string()).unwrap();
    (
        dir,
        crate::tests::github(script),
        Repository::new("github.com".into(), "team".into(), "repo".into()).unwrap(),
    )
}

#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn stage_sync_preserves_unmanaged_labels_and_retries_a_partial_remote_write() {
    let (dir, github, repository) = fixture();
    let managed = ["queued", "progress", "review"].map(str::to_owned);
    std::fs::write(dir.path().join("fail-add"), "fail").unwrap();
    assert!(
        github
            .sync_issue_labels(
                &repository,
                18,
                &managed,
                Some("progress"),
                &["queued".into()]
            )
            .await
            .is_err()
    );
    let midpoint = github.issue_metadata(&repository, 18).await.unwrap();
    assert_eq!(
        midpoint
            .issue
            .labels
            .iter()
            .map(|label| label.name.as_str())
            .collect::<Vec<_>>(),
        vec!["bug"]
    );
    assert_eq!(
        github
            .sync_issue_labels(
                &repository,
                18,
                &managed,
                Some("progress"),
                &["queued".into()]
            )
            .await
            .unwrap(),
        vec!["progress"]
    );
    let after = github.issue_metadata(&repository, 18).await.unwrap();
    assert_eq!(
        after
            .issue
            .labels
            .iter()
            .map(|label| label.name.as_str())
            .collect::<Vec<_>>(),
        vec!["bug", "progress"]
    );
    assert!(
        github
            .sync_issue_labels(
                &repository,
                18,
                &managed,
                Some("review"),
                &["queued".into()]
            )
            .await
            .unwrap_err()
            .contains("outside")
    );
}

#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn assignment_refuses_other_owners_and_releases_only_the_requested_account() {
    let (dir, github, repository) = fixture();
    assert!(github.assign_issue(&repository, 18, "other").await.is_err());
    let path = dir.path().join("issue.json");
    let mut value: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    value["assignees"] = serde_json::json!([{"login":"me"},{"login":"other"}]);
    std::fs::write(&path, value.to_string()).unwrap();
    assert!(
        github
            .automatic_issue_candidates(&repository, &["bug".into()], Some("me"), 1)
            .await
            .unwrap()
            .is_empty()
    );
    github.unassign_issue(&repository, 18, "me").await.unwrap();
    github.unassign_issue(&repository, 18, "me").await.unwrap();
    assert_eq!(
        github
            .issue_metadata(&repository, 18)
            .await
            .unwrap()
            .issue
            .assignees,
        vec![IssueAssignee {
            login: "other".into()
        }]
    );
}
