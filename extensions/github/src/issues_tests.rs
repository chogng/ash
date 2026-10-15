use super::*;
use crate::tests::FakeHttp;
use crate::tests::github;
use crate::tests::issue;
use crate::tests::repository;
use std::sync::Arc;

fn metadata(labels: &[&str], owners: &[&str]) -> serde_json::Value {
    let mut value = issue(18);
    value["labels"] = json!(
        labels
            .iter()
            .map(|name| json!({"name":name,"color":"123456","node_id":name}))
            .collect::<Vec<_>>()
    );
    value["assignees"] = json!(
        owners
            .iter()
            .map(|login| json!({"login":login}))
            .collect::<Vec<_>>()
    );
    value
}

#[tokio::test(flavor = "current_thread")]
async fn stage_sync_preserves_unmanaged_labels_and_resumes_an_explicit_partial_write() {
    let http = Arc::new(FakeHttp::default());
    http.push(200, metadata(&["bug", "queued"], &[]));
    http.push(
        200,
        json!([{"name":"bug","color":"123456","node_id":"bug"}]),
    );
    http.push(500, json!({"message":"failed"}));
    http.push(200, metadata(&["bug"], &[]));
    http.push(200,json!([{"name":"bug","color":"123456","node_id":"bug"},{"name":"progress","color":"123456","node_id":"progress"}]));
    http.push(200, metadata(&["bug", "progress"], &[]));
    http.push(200, metadata(&["bug", "progress"], &[]));
    let client = github(http.clone());
    let managed = ["queued", "progress", "review"].map(str::to_owned);
    assert_eq!(
        client
            .sync_issue_labels(
                &repository(),
                18,
                &managed,
                Some("progress"),
                &["queued".into()]
            )
            .await,
        Err(Error::SubmissionUncertain)
    );
    assert_eq!(
        client
            .sync_issue_labels(
                &repository(),
                18,
                &managed,
                Some("progress"),
                &["queued".into()]
            )
            .await
            .unwrap(),
        vec!["progress"]
    );
    assert!(matches!(
        client
            .sync_issue_labels(
                &repository(),
                18,
                &managed,
                Some("review"),
                &["queued".into()]
            )
            .await,
        Err(Error::Conflict(_))
    ));
    let requests = http.requests.lock().unwrap();
    let additions = serde_json::from_slice::<serde_json::Value>(requests[4].body()).unwrap();
    assert_eq!(additions, json!({"labels":["progress"]}));
    assert!(
        requests
            .iter()
            .all(|request| !request.url().ends_with("labels/bug"))
    );
}

#[tokio::test(flavor = "current_thread")]
async fn assignment_refuses_other_owners_and_releases_only_the_requested_account() {
    let http = Arc::new(FakeHttp::default());
    http.push(200, metadata(&["bug"], &["me"]));
    http.push(200, json!([metadata(&["bug"], &["me", "other"])]));
    http.push(200, metadata(&["bug"], &["me", "other"]));
    http.push(200, metadata(&["bug"], &["other"]));
    http.push(200, metadata(&["bug"], &["other"]));
    let client = github(http.clone());
    assert!(matches!(
        client.assign_issue(&repository(), 18, "other").await,
        Err(Error::Conflict(_))
    ));
    assert!(
        client
            .automatic_issue_candidates(&repository(), &["bug".into()], Some("me"), 1)
            .await
            .unwrap()
            .is_empty()
    );
    client
        .unassign_issue(&repository(), 18, "me")
        .await
        .unwrap();
    client
        .unassign_issue(&repository(), 18, "me")
        .await
        .unwrap();
    let requests = http.requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.method() == HttpMethod::Delete)
            .count(),
        1
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(requests[3].body()).unwrap(),
        json!({"assignees":["me"]})
    );
}

#[tokio::test(flavor = "current_thread")]
async fn issue_creation_editing_closure_and_comment_lifecycle_use_typed_http() {
    let http = Arc::new(FakeHttp::default());
    http.push(201, issue(18));
    http.push(200, issue(18));
    let mut closed = issue(18);
    closed["state"] = json!("closed");
    closed["title"] = json!("Updated");
    http.push(200, closed);
    let comment = json!({"id":42,"body":"Details","html_url":"https://github.com/team/repo/issues/18#issuecomment-42","updated_at":"now"});
    http.push(201, comment.clone());
    http.push(200, comment);
    http.push(204, serde_json::Value::Null);
    let client = github(http.clone());
    assert_eq!(
        client
            .create_issue(
                &repository(),
                CreateIssue {
                    title: "Fix it",
                    body: "Details",
                    labels: &[],
                    assignees: &[]
                }
            )
            .await
            .unwrap()
            .number,
        18
    );
    let updated = client
        .update_issue(
            &repository(),
            18,
            UpdateIssue {
                title: Some("Updated"),
                body: None,
                state: Some(super::super::IssueState::Closed),
                labels: None,
                assignees: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(updated.state, "closed");
    assert_eq!(
        client
            .create_comment(&repository(), 18, "Details")
            .await
            .unwrap()
            .id,
        42
    );
    assert_eq!(
        client
            .update_comment(&repository(), 42, "Details")
            .await
            .unwrap()
            .id,
        42
    );
    client.delete_comment(&repository(), 42).await.unwrap();
    let requests = http.requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .map(|request| request.method())
            .collect::<Vec<_>>(),
        [
            HttpMethod::Post,
            HttpMethod::Get,
            HttpMethod::Patch,
            HttpMethod::Post,
            HttpMethod::Patch,
            HttpMethod::Delete
        ]
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(requests[2].body()).unwrap(),
        json!({"title":"Updated","state":"closed"})
    );
}
