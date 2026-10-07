use std::fmt;

/// Stable category used by host adapters to map OAuth failures without exposing secrets.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum McpOAuthErrorKind {
    ProviderUnavailable,
    InvalidRequest,
    StateMismatch,
    Expired,
    ProviderFailure,
    Credential,
}

/// Sanitized OAuth failure safe to classify at the host boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct McpOAuthError {
    kind: McpOAuthErrorKind,
    message: String,
}

impl McpOAuthError {
    pub fn new(kind: McpOAuthErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn kind(&self) -> McpOAuthErrorKind {
        self.kind
    }
}

impl fmt::Display for McpOAuthError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for McpOAuthError {}

pub(super) fn oauth_error(kind: McpOAuthErrorKind, message: impl Into<String>) -> McpOAuthError {
    McpOAuthError::new(kind, message)
}
