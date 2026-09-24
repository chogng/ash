use std::error::Error;
use std::fmt;

use super::WindowId;

/// Failure while applying an operation through a non-owning window capability.
#[derive(Debug)]
pub enum WindowOperationError {
    /// The runtime released the native window before the operation was requested.
    Closed {
        window: WindowId,
        operation: &'static str,
    },
    /// A logical size supplied to the operation was invalid.
    InvalidSize {
        window: WindowId,
        operation: &'static str,
    },
    /// A logical screen position supplied to the operation was invalid.
    InvalidPosition {
        window: WindowId,
        operation: &'static str,
    },
    /// The selected native backend cannot represent the requested operation.
    Unsupported {
        window: WindowId,
        operation: &'static str,
    },
    /// The platform rejected an otherwise valid operation.
    Platform {
        window: WindowId,
        operation: &'static str,
        source: Box<dyn Error + Send + Sync>,
    },
    /// The application event loop exited before it could accept the operation.
    Disconnected {
        window: WindowId,
        operation: &'static str,
    },
}

impl WindowOperationError {
    /// Returns the stable identity of the operation target.
    pub const fn window(&self) -> WindowId {
        match self {
            Self::Closed { window, .. }
            | Self::InvalidSize { window, .. }
            | Self::InvalidPosition { window, .. }
            | Self::Unsupported { window, .. }
            | Self::Platform { window, .. }
            | Self::Disconnected { window, .. } => *window,
        }
    }

    /// Returns the stable name of the failed operation.
    pub const fn operation(&self) -> &'static str {
        match self {
            Self::Closed { operation, .. }
            | Self::InvalidSize { operation, .. }
            | Self::InvalidPosition { operation, .. }
            | Self::Unsupported { operation, .. }
            | Self::Platform { operation, .. }
            | Self::Disconnected { operation, .. } => operation,
        }
    }

    /// Returns whether the runtime no longer owns the target window.
    pub const fn is_closed(&self) -> bool {
        matches!(self, Self::Closed { .. })
    }

    /// Returns whether the application event loop stopped accepting commands.
    pub const fn is_disconnected(&self) -> bool {
        matches!(self, Self::Disconnected { .. })
    }

    /// Returns whether the active native backend cannot represent the operation.
    pub const fn is_unsupported(&self) -> bool {
        matches!(self, Self::Unsupported { .. })
    }
}

impl fmt::Display for WindowOperationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Closed { window, operation } => write!(
                formatter,
                "{operation} failed: window {} is closed",
                window.into_raw()
            ),
            Self::InvalidSize { operation, .. } => write!(
                formatter,
                "{operation} failed: logical size must be finite and positive"
            ),
            Self::InvalidPosition { operation, .. } => write!(
                formatter,
                "{operation} failed: logical position must contain finite coordinates"
            ),
            Self::Unsupported { operation, .. } => {
                write!(
                    formatter,
                    "{operation} is unsupported by the native backend"
                )
            }
            Self::Platform {
                operation, source, ..
            } => write!(formatter, "{operation} failed: {source}"),
            Self::Disconnected { operation, .. } => write!(
                formatter,
                "{operation} failed: application event loop has exited"
            ),
        }
    }
}

impl Error for WindowOperationError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Platform { source, .. } => Some(source.as_ref()),
            Self::Closed { .. }
            | Self::InvalidSize { .. }
            | Self::InvalidPosition { .. }
            | Self::Unsupported { .. }
            | Self::Disconnected { .. } => None,
        }
    }
}
