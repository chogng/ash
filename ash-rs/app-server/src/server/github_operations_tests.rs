use super::*;

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
