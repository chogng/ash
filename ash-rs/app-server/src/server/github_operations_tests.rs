use super::*;

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
