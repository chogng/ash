use std::fmt;

use crate::ExtensionsErrorCode;

/// Stable failure category produced by the Extensions remote client.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExtensionsClientErrorKind {
    Unavailable,
    Protocol,
    Remote(ExtensionsErrorCode),
}

/// Sanitized client failure that does not expose remote-adapter implementation details.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExtensionsClientError {
    kind: ExtensionsClientErrorKind,
    message: String,
    retryable: bool,
}

impl ExtensionsClientError {
    pub(crate) fn new(
        kind: ExtensionsClientErrorKind,
        message: impl Into<String>,
        retryable: bool,
    ) -> Self {
        Self {
            kind,
            message: message.into(),
            retryable,
        }
    }

    /// Creates a stable Extensions business error without exposing implementation diagnostics.
    pub fn business(
        code: ExtensionsErrorCode,
        message: impl Into<String>,
        retryable: bool,
    ) -> Self {
        Self::new(ExtensionsClientErrorKind::Remote(code), message, retryable)
    }

    /// Creates a sanitized error for the product-local Manager's durable state.
    pub fn local_storage(message: impl Into<String>) -> Self {
        Self::business(ExtensionsErrorCode::StorageUnavailable, message, false)
    }

    pub(crate) fn invalid_request(message: impl Into<String>) -> Self {
        Self::business(ExtensionsErrorCode::InvalidRequest, message, false)
    }

    /// Creates a sanitized local cache or installation storage error.
    pub fn storage() -> Self {
        Self::business(
            ExtensionsErrorCode::StorageUnavailable,
            "Extensions cache is unavailable",
            true,
        )
    }

    pub(crate) fn package_not_found() -> Self {
        Self::business(
            ExtensionsErrorCode::PackageNotFound,
            "Extensions package was not found",
            false,
        )
    }

    pub(crate) fn version_not_found() -> Self {
        Self::business(
            ExtensionsErrorCode::VersionNotFound,
            "Extensions package version was not found",
            false,
        )
    }

    /// Creates the stable failure used when signed package verification fails.
    pub fn package_untrusted() -> Self {
        Self::business(
            ExtensionsErrorCode::PackageUntrusted,
            "Extensions package could not be verified",
            false,
        )
    }

    /// Creates a sanitized remote distribution availability failure.
    pub fn unavailable() -> Self {
        Self::new(
            ExtensionsClientErrorKind::Unavailable,
            "Extensions distribution is unavailable",
            true,
        )
    }

    /// Returns the stable error category.
    pub fn kind(&self) -> ExtensionsClientErrorKind {
        self.kind
    }

    /// Reports whether retrying the operation may succeed.
    pub fn retryable(&self) -> bool {
        self.retryable
    }
}

impl fmt::Display for ExtensionsClientError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ExtensionsClientError {}
