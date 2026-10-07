use std::fmt;

/// Stable classification for Connector domain failures.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectorErrorKind {
    InvalidIdentity,
    InvalidDefinition,
    DuplicateIdentity,
    MissingConnector,
    StaleGeneration,
    InvalidTransition,
}

/// Sanitized failure returned by Connector validation and lifecycle transitions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConnectorError {
    kind: ConnectorErrorKind,
    message: String,
}

impl ConnectorError {
    pub(crate) fn new(kind: ConnectorErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn kind(&self) -> ConnectorErrorKind {
        self.kind
    }
}

impl fmt::Display for ConnectorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ConnectorError {}
