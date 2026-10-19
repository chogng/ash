use super::*;
use crate::tests::FakeHttp;
use crate::tests::github;
use crate::tests::pull_request;
use crate::tests::repository;
use ash_http_client::HttpHeader;
use ash_http_client::HttpResponse;
use serde_json::json;
use std::sync::Arc;

fn context(http: &FakeHttp, details: &str) {
    http.push(200, serde_json::to_value(pull_request()).unwrap());
    http.push(200, json!({"id":9,"head_sha":"a".repeat(40),"status":"completed", "details_url":details,
        "app":{"slug":"github-actions"},"output":{"title":"Build","summary":"Failure","text":"Compiler output"}}));
}
fn job(http: &FakeHttp, check_url: &str) {
    http.push(
        200,
        json!({"id":45,"head_sha":"a".repeat(40),"status":"completed","check_run_url":check_url}),
    );
}
#[tokio::test(flavor = "current_thread")]
async fn annotations_keep_locations_and_pagination_without_following_external_urls() {
    let http = Arc::new(FakeHttp::default());
    context(&http, "https://github.com/team/repo/actions/runs/7/job/45");
    http.push(200, json!([{"path":"src/main.rs","start_line":3,"end_line":4,"annotation_level":"failure","message":"Compiler error","title":null}]));
    let details = github(http.clone())
        .check_details(&repository(), 7, &"a".repeat(40), 9, 2)
        .await
        .unwrap();
    assert!(details.actions_job);
    assert_eq!(details.annotations[0].start_line, 3);
    assert_eq!(details.next_page, None);
    let requests = http.requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert!(
        requests[2]
            .url()
            .ends_with("check-runs/9/annotations?per_page=100&page=2")
    );
}
#[tokio::test(flavor = "current_thread")]
async fn rerun_posts_only_to_the_verified_actions_job_and_accepts_an_empty_created_response() {
    let http = Arc::new(FakeHttp::default());
    context(&http, "https://github.com/team/repo/actions/runs/7/job/45");
    job(&http, "https://api.github.com/repos/team/repo/check-runs/9");
    http.responses
        .lock()
        .unwrap()
        .push_back(Ok(HttpResponse::new(201, vec![], vec![])));
    github(http.clone())
        .rerun_check(&repository(), 7, &"a".repeat(40), 9)
        .await
        .unwrap();
    let requests = http.requests.lock().unwrap();
    assert_eq!(requests.len(), 4);
    assert_eq!(
        requests[3].url(),
        "https://api.github.com/repos/team/repo/actions/jobs/45/rerun"
    );
    assert_eq!(requests[3].method(), HttpMethod::Post);
}
#[tokio::test(flavor = "current_thread")]
async fn moved_heads_foreign_jobs_and_external_hosts_never_dispatch_a_mutation() {
    for invalid in ["head", "host", "port", "job"] {
        let http = Arc::new(FakeHttp::default());
        if invalid == "head" {
            let mut pull = pull_request();
            pull.head.sha = "b".repeat(40);
            http.push(200, serde_json::to_value(pull).unwrap());
        } else {
            context(
                &http,
                if invalid == "host" {
                    "https://evil.example/team/repo/actions/runs/7/job/45"
                } else if invalid == "port" {
                    "https://github.com:4443/team/repo/actions/runs/7/job/45"
                } else {
                    "https://github.com/team/repo/actions/runs/7/job/45"
                },
            );
            if invalid == "job" {
                job(
                    &http,
                    "https://api.github.com/repos/another/repo/check-runs/9",
                );
            }
        }
        assert!(
            github(http.clone())
                .rerun_check(&repository(), 7, &"a".repeat(40), 9)
                .await
                .is_err()
        );
        assert!(
            http.requests
                .lock()
                .unwrap()
                .iter()
                .all(|request| request.method() == HttpMethod::Get)
        );
    }
}
#[tokio::test(flavor = "current_thread")]
async fn log_links_are_short_lived_https_capabilities_without_cross_host_bearer_requests() {
    for (location, valid) in [
        (
            "https://productionresults.blob.core.windows.net/logs?sig=private",
            true,
        ),
        ("http://productionresults.blob.core.windows.net/logs", false),
        ("https://evil.example/logs", false),
        (
            "https://productionresults.blob.core.windows.net:4443/logs",
            false,
        ),
        (
            "https://user:password@productionresults.blob.core.windows.net/logs",
            false,
        ),
    ] {
        let http = Arc::new(FakeHttp::default());
        context(&http, "https://github.com/team/repo/actions/runs/7/job/45");
        job(&http, "https://api.github.com/repos/team/repo/check-runs/9");
        http.responses
            .lock()
            .unwrap()
            .push_back(Ok(HttpResponse::new(
                302,
                vec![HttpHeader::new("Location", location)],
                vec![],
            )));
        let result = github(http.clone())
            .check_log(&repository(), 7, &"a".repeat(40), 9)
            .await;
        assert_eq!(result.is_ok(), valid);
        let requests = http.requests.lock().unwrap();
        assert_eq!(requests.len(), 4);
        assert!(requests.iter().all(
            |request| request.url().starts_with("https://api.github.com/")
                && request.rejects_redirects()
        ));
    }
}
#[tokio::test(flavor = "current_thread")]
async fn rerun_refusal_and_lost_reply_keep_distinct_outcomes_without_retry() {
    for (status, expected) in [
        (403, Error::PermissionDenied),
        (502, Error::SubmissionUncertain),
    ] {
        let http = Arc::new(FakeHttp::default());
        context(&http, "https://github.com/team/repo/actions/runs/7/job/45");
        job(&http, "https://api.github.com/repos/team/repo/check-runs/9");
        http.push(status, json!({"message":"private server response"}));
        assert_eq!(
            github(http.clone())
                .rerun_check(&repository(), 7, &"a".repeat(40), 9)
                .await,
            Err(expected)
        );
        assert_eq!(http.requests.lock().unwrap().len(), 4);
    }
}

#[tokio::test(flavor = "current_thread")]
async fn a_full_final_annotation_page_reports_the_limit_without_inventing_page_101() {
    let http = Arc::new(FakeHttp::default());
    context(&http, "https://github.com/team/repo/actions/runs/7/job/45");
    let annotation = json!({"path":"src/main.rs","start_line":1,"end_line":1,"annotation_level":"failure","message":"Error","title":null});
    http.push(200, json!(vec![annotation; 100]));
    assert!(matches!(
        github(http)
            .check_details(&repository(), 7, &"a".repeat(40), 9, 100)
            .await,
        Err(Error::InvalidResponse(_))
    ));
}
