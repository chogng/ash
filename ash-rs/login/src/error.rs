use std::fmt;

/// Stable category for a redacted login-control-plane failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LoginErrorKind {
    InvalidInput,
    Unavailable,
    NotFound,
    Conflict,
    ExternalLoginRequired,
    Driver,
}

/// A login failure safe to expose without provider credential material.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LoginError {
    kind: LoginErrorKind,
    message: String,
}

impl LoginError {
    pub fn new(kind: LoginErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn kind(&self) -> LoginErrorKind {
        self.kind
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for LoginError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for LoginError {}
