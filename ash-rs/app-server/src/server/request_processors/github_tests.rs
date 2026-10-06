use super::*;

#[test]
fn review_threads_map_nullable_lines_and_reply_pagination_to_the_frontend_contract() {
    let thread: github::ReviewThread = serde_json::from_value(serde_json::json!({
        "id":"thread", "path":"a.rs", "line":null, "diffSide":"LEFT", "isResolved":false,
        "isOutdated":true, "viewerCanResolve":false, "comments":{"nodes":[{
            "id":"comment", "body":"Review", "url":"https://github.com/team/repo/pull/7",
            "author":null, "viewerCanUpdate":false, "viewerCanDelete":false
        }], "pageInfo":{"hasNextPage":true,"endCursor":"next"}}
    }))
    .unwrap();
    let dto = review_thread(thread).unwrap();
    assert_eq!(dto.line, None);
    assert_eq!(dto.side, GitHubDiffSide::Left);
    assert!(dto.outdated);
    assert_eq!(dto.comments.next_cursor.as_deref(), Some("next"));
    assert_eq!(dto.comments.comments[0].author, None);
    assert!(next_review_cursor(true, None).is_err());
    assert!(next_review_cursor(true, Some(String::new())).is_err());
    assert_eq!(
        next_review_cursor(false, Some("last".into())).unwrap(),
        None
    );
}

#[test]
fn github_pull_request_branches_keep_fork_identity_and_deleted_sources() {
    for (head_repository, expected) in [
        (
            serde_json::json!({ "full_name": "contributor/fork" }),
            Some("contributor/fork"),
        ),
        (serde_json::Value::Null, None),
    ] {
        let response: github::PullRequest = serde_json::from_value(serde_json::json!({
            "number": 7, "node_id": "PR_7", "title": "Fix links", "body": "Details",
            "html_url": "https://github.com/team/repo/pull/7", "state": "open", "draft": false,
            "merged_at": null, "auto_merge": null,
            "head": { "sha": "a".repeat(40), "ref": "feature/links", "repo": head_repository },
            "base": { "sha": "b".repeat(40), "ref": "main", "repo": { "full_name": "team/repo" } }
        }))
        .unwrap();
        let result = pull_request(response);
        assert_eq!(result.head_repository.as_deref(), expected);
        assert_eq!(result.head_branch, "feature/links");
    }
}

#[test]
fn github_error_categories_are_independent_of_product_reporter_errors() {
    for (error, name, code) in [
        (
            github::Error::InvalidInput("invalid page".into()),
            AppServerErrorName::InvalidParams,
            -32602,
        ),
        (
            github::Error::AuthenticationRequired,
            AppServerErrorName::AccountAuthenticationRequired,
            -32030,
        ),
        (
            github::Error::PermissionDenied,
            AppServerErrorName::GitHubPermissionDenied,
            -32070,
        ),
        (
            github::Error::RateLimited,
            AppServerErrorName::GitHubRateLimited,
            -32070,
        ),
        (
            github::Error::NotFound,
            AppServerErrorName::GitHubNotFound,
            -32070,
        ),
        (
            github::Error::Conflict("changed".into()),
            AppServerErrorName::GitHubConflict,
            -32070,
        ),
        (
            github::Error::Unavailable("network unavailable".into()),
            AppServerErrorName::GitHubUnavailable,
            -32070,
        ),
        (
            github::Error::TimedOut,
            AppServerErrorName::GitHubTimedOut,
            -32070,
        ),
        (
            github::Error::InvalidResponse("invalid JSON".into()),
            AppServerErrorName::GitHubOperationFailed,
            -32070,
        ),
        (
            github::Error::OperationFailed("request failed".into()),
            AppServerErrorName::GitHubOperationFailed,
            -32070,
        ),
        (
            github::Error::Cancelled,
            AppServerErrorName::RequestCancelled,
            -32800,
        ),
        (
            github::Error::SubmissionUncertain,
            AppServerErrorName::GitHubSubmissionUncertain,
            -32070,
        ),
    ] {
        let diagnostic = error.to_string();
        let result = github_error(error);
        assert_eq!(result.message, name);
        assert_eq!(result.code, code);
        assert_eq!(result.detail.as_deref(), Some(diagnostic.as_str()));
    }
}

#[test]
fn every_registered_github_repository_method_has_network_execution() {
    use ash_app_server_protocol::protocol::registry::CLIENT_METHODS;
    for method in CLIENT_METHODS
        .iter()
        .filter(|method| method.method.starts_with("github/"))
    {
        match method.kind {
            ClientMethod::GitHubCancel
            | ClientMethod::GitHubAccountList
            | ClientMethod::GitHubAccountConnect => {}
            method => assert!(
                GitHubRequestProcessor::handles(method),
                "{} has no network execution",
                method.as_str()
            ),
        }
    }
}
