use std::error::Error;

use thiserror::Error;

/// Fatal failure crossing the reusable native application runtime boundary.
#[derive(Debug, Error)]
#[error("{operation} failed: {source}")]
pub struct ApplicationError {
    operation: &'static str,
    #[source]
    source: Box<dyn Error + Send + Sync>,
}

impl ApplicationError {
    pub(crate) fn window(source: impl Error + Send + Sync + 'static) -> Self {
        Self {
            operation: "native window creation",
            source: Box::new(source),
        }
    }

    pub(crate) fn window_options(source: impl Error + Send + Sync + 'static) -> Self {
        Self {
            operation: "native window configuration",
            source: Box::new(source),
        }
    }

    pub(crate) fn renderer(source: impl Error + Send + Sync + 'static) -> Self {
        Self {
            operation: "renderer initialization",
            source: Box::new(source),
        }
    }

    /// Wraps a fatal application-host or platform-service failure with a stable operation label.
    pub fn host(operation: &'static str, source: impl Error + Send + Sync + 'static) -> Self {
        Self {
            operation,
            source: Box::new(source),
        }
    }

    /// Returns the stable operation label attached at the runtime boundary.
    pub const fn operation(&self) -> &'static str {
        self.operation
    }
}
