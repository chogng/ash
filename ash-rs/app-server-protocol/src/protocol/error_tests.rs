use super::AppServerError;
use super::AppServerErrorName;

#[test]
fn error_kind_is_structured_separately_from_diagnostic_message() {
    let error = AppServerError::new(-32013, AppServerErrorName::ResourceNotFound);

    assert_eq!(
        serde_json::to_value(error).unwrap(),
        serde_json::json!({
            "code": -32013,
            "message": "ResourceNotFound",
            "data": { "kind": "ResourceNotFound" },
        })
    );
}

#[test]
fn external_login_required_has_a_stable_redacted_error_kind() {
    let error = AppServerError::new(-32030, AppServerErrorName::AccountExternalLoginRequired);
    let encoded = serde_json::to_value(&error).unwrap();
    assert_eq!(
        encoded,
        serde_json::json!({
            "code":-32030,"message":"AccountExternalLoginRequired",
            "data":{"kind":"AccountExternalLoginRequired"}
        })
    );
    assert_eq!(
        serde_json::from_value::<AppServerError>(encoded).unwrap(),
        error
    );
}

#[test]
fn github_errors_serialize_and_round_trip_without_product_reporter_names() {
    for (name, kind) in [
        (
            AppServerErrorName::GitHubPermissionDenied,
            "GitHubPermissionDenied",
        ),
        (AppServerErrorName::GitHubRateLimited, "GitHubRateLimited"),
        (AppServerErrorName::GitHubNotFound, "GitHubNotFound"),
        (AppServerErrorName::GitHubConflict, "GitHubConflict"),
        (AppServerErrorName::GitHubUnavailable, "GitHubUnavailable"),
        (AppServerErrorName::GitHubTimedOut, "GitHubTimedOut"),
        (
            AppServerErrorName::GitHubSubmissionUncertain,
            "GitHubSubmissionUncertain",
        ),
        (
            AppServerErrorName::GitHubOperationFailed,
            "GitHubOperationFailed",
        ),
    ] {
        let error = AppServerError::new(-32070, name);
        let encoded = serde_json::to_value(&error).unwrap();
        assert_eq!(
            encoded,
            serde_json::json!({"code":-32070,"message":kind,"data":{"kind":kind}})
        );
        assert_eq!(
            serde_json::from_value::<AppServerError>(encoded).unwrap(),
            error
        );
    }
}
