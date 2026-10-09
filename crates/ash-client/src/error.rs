use std::fmt;

/// A safe, provider-neutral failure from request execution or wire framing.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClientError {
    InvalidRequest(String),
    Cancelled(String),
    Transport(String),
    InvalidResponse(String),
    Framing(String),
}

impl fmt::Display for ClientError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRequest(message) => write!(formatter, "invalid client request: {message}"),
            Self::Cancelled(message) => write!(formatter, "client request cancelled: {message}"),
            Self::Transport(message) => write!(formatter, "HTTP client failed: {message}"),
            Self::InvalidResponse(message) => {
                write!(formatter, "invalid client response: {message}")
            }
            Self::Framing(message) => write!(formatter, "invalid response framing: {message}"),
        }
    }
}

impl std::error::Error for ClientError {}

impl From<ash_http_client::HttpClientError> for ClientError {
    fn from(error: ash_http_client::HttpClientError) -> Self {
        match error {
            ash_http_client::HttpClientError::InvalidRequest(message) => {
                Self::InvalidRequest(message)
            }
            ash_http_client::HttpClientError::InvalidConfiguration(message) => {
                Self::Transport(message)
            }
            ash_http_client::HttpClientError::Transport(message) => Self::Transport(message),
            ash_http_client::HttpClientError::Connection(failure) => {
                Self::Transport(failure.to_string())
            }
            ash_http_client::HttpClientError::ResponseTooLarge
            | ash_http_client::HttpClientError::RedirectLimitExceeded => {
                Self::Transport(error.to_string())
            }
        }
    }
}
