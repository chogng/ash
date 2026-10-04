use ash_login::LoginError;
use ash_login::LoginErrorKind;

/// Repository failures retain their category across transports and product adapters.
/// Remote error bodies are not diagnostics: they can contain private data or credentials.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
    InvalidInput(String),
    AuthenticationRequired,
    PermissionDenied,
    RateLimited,
    NotFound,
    Conflict(String),
    Unavailable(String),
    TimedOut,
    InvalidResponse(String),
    OperationFailed(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidInput(detail)
            | Self::Conflict(detail)
            | Self::Unavailable(detail)
            | Self::InvalidResponse(detail)
            | Self::OperationFailed(detail) => formatter.write_str(detail),
            Self::AuthenticationRequired => {
                formatter.write_str("GitHub authentication is required")
            }
            Self::PermissionDenied => formatter.write_str("GitHub permission is required"),
            Self::RateLimited => formatter.write_str("GitHub rate limit reached"),
            Self::NotFound => formatter.write_str("GitHub resource was not found"),
            Self::TimedOut => formatter.write_str("GitHub request timed out"),
        }
    }
}

impl std::error::Error for Error {}

impl From<LoginError> for Error {
    fn from(error: LoginError) -> Self {
        match error.kind() {
            LoginErrorKind::ExternalLoginRequired => Self::AuthenticationRequired,
            LoginErrorKind::Unavailable => {
                Self::Unavailable("GitHub account is unavailable".into())
            }
            LoginErrorKind::InvalidInput => {
                Self::InvalidInput("Invalid GitHub account input".into())
            }
            LoginErrorKind::NotFound => Self::NotFound,
            LoginErrorKind::Conflict => Self::Conflict("GitHub account changed".into()),
            LoginErrorKind::Driver => {
                Self::OperationFailed("GitHub account operation failed".into())
            }
        }
    }
}

pub(crate) fn validate_status<'a>(
    status: u16,
    headers: impl Iterator<Item = (&'a str, &'a str)>,
) -> Result<(), Error> {
    let throttled = headers.into_iter().any(|(name, value)| {
        (name.eq_ignore_ascii_case("x-ratelimit-remaining") && value.trim() == "0")
            || (name.eq_ignore_ascii_case("retry-after") && value.trim().parse::<u64>().is_ok())
    });
    match status {
        200..=299 => Ok(()),
        401 => Err(Error::AuthenticationRequired),
        403 if throttled => Err(Error::RateLimited),
        403 => Err(Error::PermissionDenied),
        404 => Err(Error::NotFound),
        409 => Err(Error::Conflict("GitHub resource changed".into())),
        422 => Err(Error::InvalidInput(
            "GitHub rejected the request parameters".into(),
        )),
        429 => Err(Error::RateLimited),
        _ => Err(Error::OperationFailed(format!(
            "GitHub request failed with HTTP {status}"
        ))),
    }
}

#[cfg(test)]
#[path = "error_tests.rs"]
mod tests;
