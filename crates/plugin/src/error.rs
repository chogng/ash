use std::error::Error;
use std::fmt;

/// Stable classification for local Plugin package validation failures.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PluginErrorKind {
    SourceUnavailable,
    PackageUnsafe,
    ManifestInvalid,
    ContributionInvalid,
    PackageConflict,
    AuthorityUnavailable,
    GenerationConflict,
    CommandConflict,
    PackageInUse,
    PackageRevoked,
}

/// Sanitized failure returned while parsing or discovering a local Plugin package.
///
/// Messages may include manifest-relative paths and Plugin identities, but do not include file
/// contents, environment values, credentials, or canonical host paths.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginError {
    kind: PluginErrorKind,
    message: String,
}

impl PluginError {
    pub fn new(kind: PluginErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn kind(&self) -> PluginErrorKind {
        self.kind
    }
}

impl fmt::Display for PluginError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for PluginError {}
