use std::path::{Path, PathBuf};

use ash_language::LanguageId;

use crate::LspManagerError;

/// Monotonic product revision of one authoritative editor document.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct LanguageDocumentRevision(u64);

impl LanguageDocumentRevision {
    pub const INITIAL: Self = Self(1);

    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    pub const fn value(self) -> u64 {
        self.0
    }
}

/// Full editor-owned document snapshot accepted by the language-service boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LspDocumentSnapshot {
    path: PathBuf,
    language_id: LanguageId,
    revision: LanguageDocumentRevision,
    text: String,
}

impl LspDocumentSnapshot {
    pub fn new(
        path: impl Into<PathBuf>,
        language_id: impl Into<String>,
        revision: LanguageDocumentRevision,
        text: impl Into<String>,
    ) -> Result<Self, LspManagerError> {
        let path = path.into();
        if path.as_os_str().is_empty() {
            return Err(LspManagerError::InvalidDocumentPath);
        }
        let language_id = language_id.into();
        let language_id = LanguageId::parse(&language_id)
            .map_err(|_| LspManagerError::InvalidLanguageId(language_id))?;
        Ok(Self {
            path,
            language_id,
            revision,
            text: text.into(),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn language_id(&self) -> &str {
        self.language_id.as_str()
    }

    pub const fn revision(&self) -> LanguageDocumentRevision {
        self.revision
    }

    pub fn text(&self) -> &str {
        &self.text
    }
}
