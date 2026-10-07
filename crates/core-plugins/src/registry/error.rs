use std::fmt;

use crate::MarketplaceErrorCode;

/// Stable failure category produced by the Marketplace remote client.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MarketplaceClientErrorKind {
    Unavailable,
    Protocol,
    Remote(MarketplaceErrorCode),
}

/// Sanitized client failure that does not expose remote-adapter implementation details.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketplaceClientError {
    kind: MarketplaceClientErrorKind,
    message: String,
    retryable: bool,
}

impl MarketplaceClientError {
    pub(crate) fn new(
        kind: MarketplaceClientErrorKind,
        message: impl Into<String>,
        retryable: bool,
    ) -> Self {
        Self {
            kind,
            message: message.into(),
            retryable,
        }
    }

    /// Creates a stable Marketplace business error without exposing implementation diagnostics.
    pub fn business(
        code: MarketplaceErrorCode,
        message: impl Into<String>,
        retryable: bool,
    ) -> Self {
        Self::new(MarketplaceClientErrorKind::Remote(code), message, retryable)
    }

    /// Creates a sanitized error for the product-local Manager's durable state.
    pub fn local_storage(message: impl Into<String>) -> Self {
        Self::business(MarketplaceErrorCode::StorageUnavailable, message, false)
    }

    pub(crate) fn invalid_request(message: impl Into<String>) -> Self {
        Self::business(MarketplaceErrorCode::InvalidRequest, message, false)
    }

    /// Creates a sanitized local cache or installation storage error.
    pub fn storage() -> Self {
        Self::business(
            MarketplaceErrorCode::StorageUnavailable,
            "Marketplace cache is unavailable",
            true,
        )
    }

    pub(crate) fn package_not_found() -> Self {
        Self::business(
            MarketplaceErrorCode::PackageNotFound,
            "Marketplace package was not found",
            false,
        )
    }

    pub(crate) fn version_not_found() -> Self {
        Self::business(
            MarketplaceErrorCode::VersionNotFound,
            "Marketplace package version was not found",
            false,
        )
    }

    /// Creates the stable failure used when signed package verification fails.
    pub fn package_untrusted() -> Self {
        Self::business(
            MarketplaceErrorCode::PackageUntrusted,
            "Marketplace package could not be verified",
            false,
        )
    }

    /// Creates a sanitized remote distribution availability failure.
    pub fn unavailable() -> Self {
        Self::new(
            MarketplaceClientErrorKind::Unavailable,
            "Marketplace distribution is unavailable",
            true,
        )
    }

    /// Returns the stable error category.
    pub fn kind(&self) -> MarketplaceClientErrorKind {
        self.kind
    }

    /// Reports whether retrying the operation may succeed.
    pub fn retryable(&self) -> bool {
        self.retryable
    }
}

impl fmt::Display for MarketplaceClientError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for MarketplaceClientError {}
