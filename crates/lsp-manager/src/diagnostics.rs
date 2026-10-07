use std::ops::Range;
use std::path::{Path, PathBuf};

use crate::LanguageDocumentRevision;

/// Product-neutral diagnostic severity independent from LSP presentation types.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LanguageDiagnosticSeverity {
    Error,
    Warning,
    Information,
    Hint,
}

/// UTF-8 byte range in the authoritative editor document snapshot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageTextRange(Range<usize>);

impl LanguageTextRange {
    pub const fn new(range: Range<usize>) -> Self {
        Self(range)
    }

    pub fn byte_range(&self) -> Range<usize> {
        self.0.clone()
    }
}

/// One product-neutral language diagnostic ready for editor presentation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageDiagnostic {
    pub range: LanguageTextRange,
    pub severity: LanguageDiagnosticSeverity,
    pub message: String,
    pub source: Option<String>,
    pub code: Option<String>,
}

/// Fresh diagnostics bound to one exact editor document revision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageDiagnostics {
    path: PathBuf,
    revision: LanguageDocumentRevision,
    diagnostics: Vec<LanguageDiagnostic>,
}

impl LanguageDiagnostics {
    pub(crate) fn new(
        path: PathBuf,
        revision: LanguageDocumentRevision,
        diagnostics: Vec<LanguageDiagnostic>,
    ) -> Self {
        Self {
            path,
            revision,
            diagnostics,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub const fn revision(&self) -> LanguageDocumentRevision {
        self.revision
    }

    pub fn diagnostics(&self) -> &[LanguageDiagnostic] {
        &self.diagnostics
    }
}
