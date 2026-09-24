use std::error::Error;
use std::fmt;

/// Failure while querying the pointer's global physical screen position.
#[derive(Debug)]
pub enum CursorPositionError {
    /// The active window-system backend does not expose global pointer coordinates.
    Unsupported,
    /// The platform rejected or could not complete the query.
    Platform {
        source: Box<dyn Error + Send + Sync>,
    },
}

impl CursorPositionError {
    pub(super) fn platform(source: impl Error + Send + Sync + 'static) -> Self {
        Self::Platform {
            source: Box::new(source),
        }
    }

    /// Returns whether the active backend cannot expose global pointer coordinates.
    pub const fn is_unsupported(&self) -> bool {
        matches!(self, Self::Unsupported)
    }
}

impl fmt::Display for CursorPositionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsupported => formatter.write_str(
                "global cursor position is unsupported by the active window-system backend",
            ),
            Self::Platform { source } => {
                write!(formatter, "global cursor position query failed: {source}")
            }
        }
    }
}

impl Error for CursorPositionError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Unsupported => None,
            Self::Platform { source } => Some(source.as_ref()),
        }
    }
}

#[cfg(test)]
#[path = "cursor_tests.rs"]
mod tests;
