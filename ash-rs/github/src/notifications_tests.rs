use super::*;
use crate::tests::FakeHttp;
use crate::tests::github;
use std::sync::Arc;

fn row(id: &str) -> Value {
    json!({"id":id,"unread":true,"reason":"mention","updated_at":"2026-10-05T00:00:00Z","repository":{"full_name":"team/repo"},"subject":{"title":"Review this","type":"PullRequest","url":"https://api.github.com/repos/team/repo/pulls/7"}})
}

#[tokio::test(flavor = "current_thread")]
async fn notifications_paginate_and_validate_browser_destinations_without_repository_input() {
    let http = Arc::new(FakeHttp::default());
    http.push(
        200,
        json!((1..=50).map(|id| row(&id.to_string())).collect::<Vec<_>>()),
    );
    let client = github(http.clone());
    let page = client
        .notifications(NotificationFilter::Participating, 1)
        .await
        .unwrap();
    assert_eq!(
        (
            page.notifications.len(),
            page.next_page,
            page.notifications[0].url.as_str()
        ),
        (50, Some(2), "https://github.com/team/repo/pull/7")
    );
    let mut malicious = row("101");
    malicious["subject"]["url"] = json!("https://other.example/repos/team/repo/pulls/7");
    http.push(200, json!([malicious]));
    let page = client
        .notifications(NotificationFilter::All, 2)
        .await
        .unwrap();
    assert_eq!(
        (page.next_page, page.notifications[0].url.as_str()),
        (None, "https://github.com/notifications")
    );
    assert_eq!(
        http.requests.lock().unwrap()[0].url(),
        "https://api.github.com/notifications?all=false&participating=true&per_page=50&page=1"
    );
    assert!(matches!(
        client.notifications(NotificationFilter::Unread, 0).await,
        Err(Error::InvalidInput(_))
    ));
}

#[tokio::test(flavor = "current_thread")]
async fn notification_writes_accept_empty_responses_and_reject_thread_path_injection() {
    let http = Arc::new(FakeHttp::default());
    http.responses
        .lock()
        .unwrap()
        .push_back(Ok(ash_http_client::HttpResponse::new(205, vec![], vec![])));
    http.responses
        .lock()
        .unwrap()
        .push_back(Ok(ash_http_client::HttpResponse::new(205, vec![], vec![])));
    let client = github(http.clone());
    client
        .mark_notification_read("700000000000000001")
        .await
        .unwrap();
    client.mark_notifications_read().await.unwrap();
    for id in ["../7", "0", "", "7?x=y"] {
        assert!(matches!(
            client.mark_notification_read(id).await,
            Err(Error::InvalidInput(_))
        ));
    }
    let requests = http.requests.lock().unwrap();
    assert_eq!(
        (requests[0].method(), requests[1].method()),
        (HttpMethod::Patch, HttpMethod::Put)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(requests[1].body()).unwrap(),
        json!({"read":true})
    );
}

#[tokio::test(flavor = "current_thread")]
async fn failed_notification_write_is_not_retried() {
    let http = Arc::new(FakeHttp::default());
    http.push(503, json!({"message":"private"}));
    assert_eq!(
        github(http.clone())
            .mark_notifications_read()
            .await
            .unwrap_err(),
        Error::SubmissionUncertain
    );
    assert_eq!(http.requests.lock().unwrap().len(), 1);
}
