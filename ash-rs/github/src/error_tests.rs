use super::*;

#[test]
fn http_refusals_preserve_categories_without_remote_error_text() {
    for (status, expected) in [
        (401, Error::AuthenticationRequired),
        (403, Error::PermissionDenied),
        (404, Error::NotFound),
        (409, Error::Conflict("GitHub resource changed".into())),
        (
            422,
            Error::InvalidInput("GitHub rejected the request parameters".into()),
        ),
        (429, Error::RateLimited),
        (
            503,
            Error::OperationFailed("GitHub request failed with HTTP 503".into()),
        ),
    ] {
        assert_eq!(validate_status(status, std::iter::empty()), Err(expected));
    }
    assert_eq!(validate_status(201, std::iter::empty()), Ok(()));
}

#[test]
fn forbidden_requires_quota_evidence_to_be_classified_as_rate_limited() {
    for headers in [
        vec![("X-RateLimit-Remaining", "0")],
        vec![("Retry-After", "60")],
    ] {
        assert_eq!(
            validate_status(403, headers.into_iter()),
            Err(Error::RateLimited)
        );
    }
    for headers in [
        vec![("x-ratelimit-remaining", "10")],
        vec![("retry-after", "unknown")],
        vec![],
    ] {
        assert_eq!(
            validate_status(403, headers.into_iter()),
            Err(Error::PermissionDenied)
        );
    }
}

#[test]
fn account_errors_keep_categories_and_do_not_copy_provider_diagnostics() {
    for (kind, expected) in [
        (
            LoginErrorKind::ExternalLoginRequired,
            Error::AuthenticationRequired,
        ),
        (
            LoginErrorKind::Unavailable,
            Error::Unavailable("GitHub account is unavailable".into()),
        ),
        (
            LoginErrorKind::InvalidInput,
            Error::InvalidInput("Invalid GitHub account input".into()),
        ),
        (LoginErrorKind::NotFound, Error::NotFound),
        (
            LoginErrorKind::Conflict,
            Error::Conflict("GitHub account changed".into()),
        ),
        (
            LoginErrorKind::Driver,
            Error::OperationFailed("GitHub account operation failed".into()),
        ),
    ] {
        let error = Error::from(LoginError::new(kind, "private-token"));
        assert_eq!(error, expected);
        assert!(!error.to_string().contains("private-token"));
    }
}
