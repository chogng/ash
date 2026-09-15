use ash_client::ClientError;
use std::fmt;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OllamaError {
    InvalidEndpoint(String),
    InvalidRequest(String),
    Cancelled(String),
    Unavailable(String),
    HttpStatus(u16),
    InvalidResponse(String),
    PullFailed(String),
    ProgressRejected(String),
}

impl OllamaError {
    pub fn is_cancelled(&self) -> bool {
        matches!(self, Self::Cancelled(_))
    }

    pub fn status(&self) -> Option<u16> {
        match self {
            Self::HttpStatus(status) => Some(*status),
            _ => None,
        }
    }
}

impl fmt::Display for OllamaError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidEndpoint(message) => {
                write!(formatter, "invalid Ollama endpoint: {message}")
            }
            Self::InvalidRequest(message) => write!(formatter, "invalid Ollama request: {message}"),
            Self::Cancelled(message) => write!(formatter, "Ollama request cancelled: {message}"),
            Self::Unavailable(message) => formatter.write_str(message),
            Self::HttpStatus(status) => write!(formatter, "Ollama returned HTTP {status}"),
            Self::InvalidResponse(message) => {
                write!(formatter, "invalid Ollama response: {message}")
            }
            Self::PullFailed(message) => {
                write!(formatter, "Ollama model download failed: {message}")
            }
            Self::ProgressRejected(message) => {
                write!(formatter, "Ollama progress receiver stopped: {message}")
            }
        }
    }
}

impl std::error::Error for OllamaError {}

impl From<ClientError> for OllamaError {
    fn from(error: ClientError) -> Self {
        match error {
            ClientError::InvalidRequest(message) => Self::InvalidRequest(message),
            ClientError::Cancelled(message) => Self::Cancelled(message),
            ClientError::Transport(_) => Self::Unavailable(
                "Ollama is not reachable; start it with `ollama serve` and try again".into(),
            ),
            ClientError::InvalidResponse(message) | ClientError::Framing(message) => {
                Self::InvalidResponse(message)
            }
        }
    }
}
