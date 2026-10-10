use std::fmt;

/// Lifecycle failures preserve a transient stopping state independently of diagnostic wording.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LifecycleError {
    ServerShuttingDown,
    Operation(String),
}

impl fmt::Display for LifecycleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ServerShuttingDown => f.write_str("Local App Server daemon is stopping"),
            Self::Operation(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for LifecycleError {}

impl From<String> for LifecycleError {
    fn from(message: String) -> Self {
        Self::Operation(message)
    }
}

impl From<&str> for LifecycleError {
    fn from(message: &str) -> Self {
        Self::Operation(message.into())
    }
}

impl From<LifecycleError> for String {
    fn from(error: LifecycleError) -> Self {
        error.to_string()
    }
}
