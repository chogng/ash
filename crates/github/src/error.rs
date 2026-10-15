use ash_login::LoginError;
use ash_login::LoginErrorKind;

/// Repository failures retain their category across transports and product adapters.
/// Remote error bodies are not diagnostics: they can contain private data or credentials.
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum Error {
    InvalidInput(String),
    AuthenticationRequired,
    PermissionDenied,
    RateLimited,
    NotFound,
    Conflict(String),
    Unavailable(String),
    TimedOut,
    Cancelled,
    SubmissionUncertain,
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
            Self::Cancelled => formatter.write_str("GitHub request cancelled"),
            Self::SubmissionUncertain => formatter.write_str(
                "GitHub may have applied the change; check the repository before retrying",
            ),
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
