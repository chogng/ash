use std::fmt;

/// A sanitized failure produced by WebSocket configuration or I/O.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WebSocketClientError {
    InvalidRequest(String),
    InvalidConfiguration(String),
    ConnectionFailed,
    HandshakeRejected(u16),
    ProtocolFailed,
    ConnectionClosed,
}

impl fmt::Display for WebSocketClientError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRequest(message) => {
                write!(formatter, "invalid WebSocket request: {message}")
            }
            Self::InvalidConfiguration(message) => {
                write!(
                    formatter,
                    "invalid WebSocket client configuration: {message}"
                )
            }
            Self::HandshakeRejected(status) => {
                write!(formatter, "WebSocket handshake rejected with HTTP {status}")
            }
            Self::ConnectionFailed => formatter.write_str("WebSocket connection failed"),
            Self::ProtocolFailed => formatter.write_str("WebSocket protocol failed"),
            Self::ConnectionClosed => formatter.write_str("WebSocket connection closed"),
        }
    }
}

impl std::error::Error for WebSocketClientError {}

impl From<ash_http_client::HttpClientError> for WebSocketClientError {
    fn from(error: ash_http_client::HttpClientError) -> Self {
        match error {
            ash_http_client::HttpClientError::InvalidRequest(message) => {
                Self::InvalidRequest(message)
            }
            ash_http_client::HttpClientError::InvalidConfiguration(message) => {
                Self::InvalidConfiguration(message)
            }
            ash_http_client::HttpClientError::Transport(_) => Self::ConnectionFailed,
            ash_http_client::HttpClientError::Connection(_) => Self::ConnectionFailed,
        }
    }
}
