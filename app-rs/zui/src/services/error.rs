use std::error::Error;
use std::fmt;

/// Stable failure returned by an operating-system service capability.
#[derive(Debug)]
pub struct SystemServiceError {
    service: &'static str,
    code: SystemServiceErrorCode,
    source: Option<Box<dyn Error + Send + Sync>>,
}

/// Stable category for an operating-system capability failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SystemServiceErrorCode {
    /// The request violated a backend-independent capability invariant.
    InvalidInput,
    /// The requested operating-system capability is unavailable on this platform.
    Unsupported,
    /// The platform backend failed while performing a supported operation.
    Backend,
}

impl SystemServiceError {
    /// Wraps input rejected before the operating-system backend is called.
    pub fn invalid_input(
        service: &'static str,
        source: impl Error + Send + Sync + 'static,
    ) -> Self {
        Self {
            service,
            code: SystemServiceErrorCode::InvalidInput,
            source: Some(Box::new(source)),
        }
    }

    /// Creates a stable failure for a capability unavailable on the current platform.
    pub const fn unsupported(service: &'static str) -> Self {
        Self {
            service,
            code: SystemServiceErrorCode::Unsupported,
            source: None,
        }
    }

    /// Wraps a failure reported by an injected or platform service backend.
    pub fn backend(service: &'static str, source: impl Error + Send + Sync + 'static) -> Self {
        Self {
            service,
            code: SystemServiceErrorCode::Backend,
            source: Some(Box::new(source)),
        }
    }

    /// Returns the stable capability name that failed.
    pub const fn service(&self) -> &'static str {
        self.service
    }

    /// Returns the backend-independent failure category.
    pub const fn code(&self) -> SystemServiceErrorCode {
        self.code
    }

    /// Returns whether the current platform has no implementation for this capability.
    pub const fn is_unsupported(&self) -> bool {
        matches!(self.code, SystemServiceErrorCode::Unsupported)
    }

    /// Returns whether a backend-independent request invariant was violated.
    pub const fn is_invalid_input(&self) -> bool {
        matches!(self.code, SystemServiceErrorCode::InvalidInput)
    }
}

impl fmt::Display for SystemServiceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match (&self.code, &self.source) {
            (SystemServiceErrorCode::InvalidInput, Some(source)) => {
                write!(
                    formatter,
                    "{} rejected invalid input: {source}",
                    self.service
                )
            }
            (SystemServiceErrorCode::InvalidInput, None) => {
                write!(formatter, "{} rejected invalid input", self.service)
            }
            (SystemServiceErrorCode::Unsupported, _) => {
                write!(
                    formatter,
                    "{} is unsupported on this platform",
                    self.service
                )
            }
            (SystemServiceErrorCode::Backend, Some(source)) => {
                write!(formatter, "{} failed: {source}", self.service)
            }
            (SystemServiceErrorCode::Backend, None) => {
                write!(formatter, "{} failed", self.service)
            }
        }
    }
}

impl Error for SystemServiceError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.source.as_deref().map(|source| source as _)
    }
}
