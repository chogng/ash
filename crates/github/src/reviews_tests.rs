use super::*;
use crate::tests::FakeHttp;
use crate::tests::github;
use crate::tests::pull_request;
use crate::tests::repository;
use std::sync::Arc;

#[tokio::test(flavor = "current_thread")]
async fn review_submits_inline_comments_on_the_selected_commit_and_rejects_a_changed_head() {
    let http = Arc::new(FakeHttp::default());
    http.push(200, serde_json::to_value(pull_request()).unwrap());
    http.push(200, json!({"id":1,"body":"Review","state":"COMMENTED","html_url":"https://github.com/team/repo/pull/7#review-1","commit_id":"a".repeat(40),"submitted_at":"now"}));
    let client = github(http.clone());
    let comments = vec![ReviewCommentInput {
        path: "src/a.rs".into(),
        line: 8,
        side: DiffSide::Right,
        body: "Explain this constraint".into(),
    }];
    client
        .review_pull_request(
            &repository(),
            7,
            &"a".repeat(40),
            crate::ReviewEvent::Comment,
            "Review",
            &comments,
        )
        .await
        .unwrap();
    let requests = http.requests.lock().unwrap();
    let body: serde_json::Value = serde_json::from_slice(&requests[1].body()).unwrap();
    assert_eq!(
        body,
        json!({"commit_id":"a".repeat(40),"event":"COMMENT","body":"Review","comments":[{"path":"src/a.rs","line":8,"side":"RIGHT","body":"Explain this constraint"}]})
    );
    drop(requests);
    http.push(200, serde_json::to_value(pull_request()).unwrap());
    assert!(matches!(
        client
            .review_pull_request(
                &repository(),
                7,
                &"b".repeat(40),
                crate::ReviewEvent::Approve,
                "",
                &[]
            )
            .await,
        Err(Error::Conflict(_))
    ));
    assert_eq!(http.requests.lock().unwrap().len(), 3);
}

#[tokio::test(flavor = "current_thread")]
async fn file_reads_pin_the_commit_encode_paths_and_classify_binary_and_large_content() {
    let http = Arc::new(FakeHttp::default());
    http.push(
        200,
        json!({"type":"file","size":5,"encoding":"base64","content":"aGVsbG8=\n"}),
    );
    http.push(
        200,
        json!({"type":"file","size":1,"encoding":"base64","content":"AA=="}),
    );
    http.push(200, json!({"type":"file","size":1048577}));
    let client = github(http.clone());
    assert_eq!(
        client
            .file_content(&repository(), &"a".repeat(40), "src/a b#?.rs")
            .await
            .unwrap(),
        FileContent::Text {
            text: "hello".into()
        }
    );
    assert_eq!(
        client
            .file_content(&repository(), &"a".repeat(40), "binary")
            .await
            .unwrap(),
        FileContent::Binary
    );
    assert_eq!(
        client
            .file_content(&repository(), &"a".repeat(40), "large")
            .await
            .unwrap(),
        FileContent::TooLarge
    );
    assert!(http.requests.lock().unwrap()[0].url().contains(&format!(
        "contents/src/a%20b%23%3F.rs?ref={}",
        "a".repeat(40)
    )));
    for path in ["../secret", "/absolute", "a//b", "a\\b"] {
        assert!(matches!(
            client
                .file_content(&repository(), &"a".repeat(40), path)
                .await,
            Err(Error::InvalidInput(_))
        ));
    }
    assert_eq!(http.requests.lock().unwrap().len(), 3);
}

#[tokio::test(flavor = "current_thread")]
async fn thread_mutations_validate_repository_identity_before_writing() {
    let http = Arc::new(FakeHttp::default());
    http.push(200, json!({"data":{"node":{"pullRequest":{"number":7,"repository":{"name":"other","owner":{"login":"team"}}}}}}));
    let client = github(http.clone());
    assert!(matches!(
        client
            .reply_review_thread(&repository(), 7, "thread1", "Reply")
            .await,
        Err(Error::PermissionDenied)
    ));
    assert_eq!(http.requests.lock().unwrap().len(), 1);
    http.push(200, json!({"data":{"node":{"pullRequest":{"number":7,"repository":{"name":"repo","owner":{"login":"team"}}}}}}));
    http.push(
        200,
        json!({"data":{"resolveReviewThread":{"thread":{"id":"thread1","isResolved":true}}}}),
    );
    client
        .resolve_review_thread(&repository(), 7, "thread1", ThreadState::Resolved)
        .await
        .unwrap();
    let requests = http.requests.lock().unwrap();
    let body: serde_json::Value = serde_json::from_slice(&requests[2].body()).unwrap();
    assert_eq!(body["variables"], json!({"input":{"threadId":"thread1"}}));
}

#[tokio::test(flavor = "current_thread")]
async fn threads_expose_both_thread_and_reply_pagination_without_discarding_cursors() {
    let http = Arc::new(FakeHttp::default());
    http.push(200, json!({"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"id":"thread1","path":"a.rs","line":4,"diffSide":"LEFT","isResolved":false,"isOutdated":true,"viewerCanResolve":true,"comments":{"nodes":[{"id":"comment1","body":"body","url":"https://github.com/team/repo/pull/7","author":null,"viewerCanUpdate":false,"viewerCanDelete":false}],"pageInfo":{"hasNextPage":true,"endCursor":"replies"}}}],"pageInfo":{"hasNextPage":true,"endCursor":"threads"}}}}}}));
    let result = github(http)
        .review_threads(&repository(), 7, Some("previous"))
        .await
        .unwrap();
    assert_eq!(
        (
            result.page_info.end_cursor.as_deref(),
            result.nodes[0].comments.page_info.end_cursor.as_deref(),
            result.nodes[0].is_outdated
        ),
        (Some("threads"), Some("replies"), true)
    );
}

#[tokio::test(flavor = "current_thread")]
async fn review_diff_uses_the_merge_base_and_rejects_a_head_change_during_file_listing() {
    let http = Arc::new(FakeHttp::default());
    let initial = pull_request();
    for changed in [false, true] {
        http.push(200, serde_json::to_value(&initial).unwrap());
        http.push(200, json!({"merge_base_commit":{"sha":"c".repeat(40)}}));
        http.push(200, json!([{ "filename":"a.rs", "status":"modified", "additions":1,"deletions":1,"changes":2,"patch":"@@ -1 +1 @@\n-old\n+new" }]));
        let mut after = initial.clone();
        if changed {
            after.head.sha = "d".repeat(40);
        }
        http.push(200, serde_json::to_value(after).unwrap());
    }
    let client = github(http.clone());
    let result = client
        .review_diff(&repository(), 7, &initial.head.sha, 1)
        .await
        .unwrap();
    assert_eq!(result.base_commit, "c".repeat(40));
    assert_eq!(result.files.files[0].filename, "a.rs");
    assert!(matches!(
        client
            .review_diff(&repository(), 7, &initial.head.sha, 1)
            .await,
        Err(Error::Conflict(_))
    ));
    assert!(http.requests.lock().unwrap()[1].url().ends_with(&format!(
        "compare/{}...{}",
        initial.base.sha, initial.head.sha
    )));
    assert!(matches!(
        client
            .review_diff(&repository(), 7, &initial.head.sha, 0)
            .await,
        Err(Error::InvalidInput(_))
    ));
    assert_eq!(http.requests.lock().unwrap().len(), 8);
}

#[tokio::test(flavor = "current_thread")]
async fn reviewer_requests_and_removals_use_users_and_team_slugs_and_verify_the_pr() {
    let http = Arc::new(FakeHttp::default());
    http.push(
        200,
        json!({"users":[{"login":"alice"}],"teams":[{"slug":"maintainers"}]}),
    );
    http.push(201, json!({"number":7,"requested_reviewers":[{"login":"alice"}],"requested_teams":[{"slug":"maintainers"}]}));
    http.push(
        200,
        json!({"number":7,"requested_reviewers":[],"requested_teams":[]}),
    );
    let client = github(http.clone());
    assert_eq!(
        client
            .requested_reviewers(&repository(), 7)
            .await
            .unwrap()
            .teams[0]
            .slug,
        "maintainers"
    );
    client
        .change_reviewers(
            &repository(),
            7,
            ReviewerChange::Request,
            &["alice".into()],
            &["maintainers".into()],
        )
        .await
        .unwrap();
    assert!(
        client
            .change_reviewers(
                &repository(),
                7,
                ReviewerChange::Remove,
                &["alice".into()],
                &["maintainers".into()]
            )
            .await
            .unwrap()
            .users
            .is_empty()
    );
    let requests = http.requests.lock().unwrap();
    assert_eq!(requests[1].method(), HttpMethod::Post);
    assert_eq!(requests[2].method(), HttpMethod::Delete);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(requests[1].body()).unwrap(),
        json!({"reviewers":["alice"],"team_reviewers":["maintainers"]})
    );
    drop(requests);
    assert!(matches!(
        client
            .change_reviewers(&repository(), 7, ReviewerChange::Request, &[], &[])
            .await,
        Err(Error::InvalidInput(_))
    ));
    http.push(
        200,
        json!({"number":8,"requested_reviewers":[],"requested_teams":[]}),
    );
    assert!(matches!(
        client
            .change_reviewers(
                &repository(),
                7,
                ReviewerChange::Request,
                &["alice".into()],
                &[]
            )
            .await,
        Err(Error::SubmissionUncertain)
    ));
}

#[tokio::test(flavor = "current_thread")]
async fn review_comment_edits_and_deletes_validate_parent_and_acknowledgement() {
    let http = Arc::new(FakeHttp::default());
    let parent = json!({"data":{"node":{"pullRequest":{"number":7,"repository":{"name":"repo","owner":{"login":"team"}}}}}});
    http.push(200, parent.clone());
    http.push(200, json!({"data":{"updatePullRequestReviewComment":{"pullRequestReviewComment":{"id":"comment","body":"Updated","url":"https://github.com/team/repo/pull/7","author":{"login":"alice"},"viewerCanUpdate":true,"viewerCanDelete":true}}}}));
    http.push(200, parent.clone());
    http.push(
        200,
        json!({"data":{"deletePullRequestReviewComment":{"clientMutationId":"comment"}}}),
    );
    let client = github(http.clone());
    assert_eq!(
        client
            .update_review_comment(&repository(), 7, "comment", "Updated")
            .await
            .unwrap()
            .body,
        "Updated"
    );
    client
        .delete_review_comment(&repository(), 7, "comment")
        .await
        .unwrap();
    let requests = http.requests.lock().unwrap();
    let edited: serde_json::Value = serde_json::from_slice(requests[1].body()).unwrap();
    assert_eq!(
        edited["variables"]["input"],
        json!({"pullRequestReviewCommentId":"comment","body":"Updated"})
    );
    assert!(
        edited["query"]
            .as_str()
            .unwrap()
            .contains("pullRequestReviewComment")
    );
    drop(requests);
    http.push(200, parent);
    http.push(
        200,
        json!({"data":{"deletePullRequestReviewComment":{"clientMutationId":"other"}}}),
    );
    assert!(matches!(
        client
            .delete_review_comment(&repository(), 7, "comment")
            .await,
        Err(Error::SubmissionUncertain)
    ));
    http.push(200, json!({"data":{"node":{"pullRequest":{"number":8,"repository":{"name":"repo","owner":{"login":"team"}}}}}}));
    assert!(matches!(
        client
            .update_review_comment(&repository(), 7, "comment", "Updated")
            .await,
        Err(Error::PermissionDenied)
    ));
    assert_eq!(http.requests.lock().unwrap().len(), 7);
}
