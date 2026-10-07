use ash_client::ClientError;
use std::fmt;
use std::time::Instant;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ApiError {
    InvalidRequest(String),
    ContextOverflow(String),
    AuthFailed(String),
    Cancelled(String),
    Transport(String),
    RateLimited { retry_at: Option<Instant> },
    UsageLimited,
    Overloaded,
    HttpStatus(u16),
    InvalidResponse(String),
}

impl fmt::Display for ApiError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRequest(message) => write!(formatter, "invalid model request: {message}"),
            Self::ContextOverflow(message) => {
                write!(formatter, "model context window exceeded: {message}")
            }
            Self::AuthFailed(message) => {
                write!(formatter, "model provider authentication failed: {message}")
            }
            Self::Cancelled(message) => write!(formatter, "model request cancelled: {message}"),
            Self::Transport(message) => write!(formatter, "model transport failed: {message}"),
            Self::RateLimited { retry_at } => match retry_at {
                Some(deadline) => write!(
                    formatter,
                    "model API rate limited; retry after {} ms",
                    deadline
                        .saturating_duration_since(Instant::now())
                        .as_millis()
                ),
                None => formatter.write_str("model API rate limited"),
            },
            Self::UsageLimited => formatter.write_str("model provider usage limit reached"),
            Self::Overloaded => formatter.write_str("model API is overloaded"),
            Self::HttpStatus(status) => write!(formatter, "model API returned HTTP {status}"),
            Self::InvalidResponse(message) => {
                write!(formatter, "invalid model response: {message}")
            }
        }
    }
}

impl std::error::Error for ApiError {}

impl From<ClientError> for ApiError {
    fn from(error: ClientError) -> Self {
        match error {
            ClientError::InvalidRequest(message) => Self::InvalidRequest(message),
            ClientError::Cancelled(message) => Self::Cancelled(message),
            ClientError::Transport(message) => Self::Transport(message),
            ClientError::InvalidResponse(message) | ClientError::Framing(message) => {
                Self::InvalidResponse(message)
            }
        }
    }
}
