use std::collections::BTreeSet;
use std::fmt;

use lsp_types::Uri;

use super::LanguageServerRouterError;
use super::error::{MAX_ID_BYTES, validate_id};
use crate::DocumentVersion;

/// Stable product identity for one configured language server.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct LanguageServerName(String);

impl LanguageServerName {
    pub fn new(value: impl Into<String>) -> Result<Self, LanguageServerRouterError> {
        let value = value.into();
        if validate_id(&value) {
            Ok(Self(value))
        } else {
            Err(LanguageServerRouterError::InvalidServerName {
                value,
                maximum_bytes: MAX_ID_BYTES,
            })
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for LanguageServerName {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// Static mapping from a configured server identity to its supported LSP language IDs.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageServerRoute {
    pub(super) name: LanguageServerName,
    pub(super) language_ids: BTreeSet<String>,
}

impl LanguageServerRoute {
    pub fn new<I, S>(
        name: LanguageServerName,
        language_ids: I,
    ) -> Result<Self, LanguageServerRouterError>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let mut validated = BTreeSet::new();
        for language_id in language_ids.into_iter().map(Into::into) {
            if !validate_id(&language_id) {
                return Err(LanguageServerRouterError::InvalidLanguageId {
                    value: language_id,
                    maximum_bytes: MAX_ID_BYTES,
                });
            }
            validated.insert(language_id);
        }
        if validated.is_empty() {
            return Err(LanguageServerRouterError::EmptyLanguageSet { server: name });
        }
        Ok(Self {
            name,
            language_ids: validated,
        })
    }

    pub fn name(&self) -> &LanguageServerName {
        &self.name
    }

    pub fn language_ids(&self) -> impl Iterator<Item = &str> {
        self.language_ids.iter().map(String::as_str)
    }
}

/// Product-owned revision of one authoritative editor document.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct EditorDocumentRevision(u64);

impl EditorDocumentRevision {
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    pub const fn value(self) -> u64 {
        self.0
    }
}

/// Full authoritative document snapshot supplied by an EditorHost.
#[derive(Clone, Debug)]
pub struct LanguageDocumentSnapshot {
    pub(super) uri: Uri,
    pub(super) language_id: String,
    pub(super) editor_revision: EditorDocumentRevision,
    pub(super) text: String,
}

impl LanguageDocumentSnapshot {
    pub fn new(
        uri: Uri,
        language_id: impl Into<String>,
        editor_revision: EditorDocumentRevision,
        text: impl Into<String>,
    ) -> Result<Self, LanguageServerRouterError> {
        let language_id = language_id.into();
        if !validate_id(&language_id) {
            return Err(LanguageServerRouterError::InvalidLanguageId {
                value: language_id,
                maximum_bytes: MAX_ID_BYTES,
            });
        }
        Ok(Self {
            uri,
            language_id,
            editor_revision,
            text: text.into(),
        })
    }

    pub fn uri(&self) -> &Uri {
        &self.uri
    }

    pub fn language_id(&self) -> &str {
        &self.language_id
    }

    pub const fn editor_revision(&self) -> EditorDocumentRevision {
        self.editor_revision
    }

    pub fn text(&self) -> &str {
        &self.text
    }
}

/// Incarnation of one configured server within a router.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct LanguageServerIncarnation(u64);

impl LanguageServerIncarnation {
    pub const INITIAL: Self = Self(1);

    pub const fn value(self) -> u64 {
        self.0
    }

    pub(super) fn next(
        self,
        server: &LanguageServerName,
    ) -> Result<Self, LanguageServerRouterError> {
        self.0.checked_add(1).map(Self).ok_or_else(|| {
            LanguageServerRouterError::IncarnationOverflow {
                server: server.clone(),
            }
        })
    }
}

/// Exact binding between one editor revision and one server document incarnation/version.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RoutedDocumentVersion {
    pub(super) editor_revision: EditorDocumentRevision,
    pub(super) server_incarnation: LanguageServerIncarnation,
    pub(super) server_version: DocumentVersion,
}

impl RoutedDocumentVersion {
    pub const fn editor_revision(self) -> EditorDocumentRevision {
        self.editor_revision
    }

    pub const fn server_incarnation(self) -> LanguageServerIncarnation {
        self.server_incarnation
    }

    pub const fn server_version(self) -> DocumentVersion {
        self.server_version
    }
}

/// Result of retiring the previous server after a successful replacement replay.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LanguageServerPreviousShutdown {
    Clean,
    Failed(String),
}

/// Successful replacement result for one server route.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageServerReplacement {
    pub incarnation: LanguageServerIncarnation,
    pub replayed_documents: usize,
    pub previous_shutdown: LanguageServerPreviousShutdown,
}

/// One server that failed during best-effort router shutdown.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageServerShutdownFailure {
    pub server: LanguageServerName,
    pub message: String,
}
