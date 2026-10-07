use crate::SkillSourceId;

/// Stable reason that a source or Skill was excluded from the catalog.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum SkillDiagnosticCode {
    SourceUnavailable,
    SourceLimitExceeded,
    SkillNotFound,
    InvalidFrontmatter,
    InvalidSkillName,
    DescriptionInvalid,
    PathEscapesRoot,
    UnsupportedFileType,
    ContentTooLarge,
}

/// Sanitized, metadata-only discovery diagnostic.
///
/// `subject` is a source-relative first-level name or `name/SKILL.md`; it never contains the
/// canonical host source root.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct SkillDiagnostic {
    source: SkillSourceId,
    subject: Option<String>,
    code: SkillDiagnosticCode,
    message: String,
}

impl SkillDiagnostic {
    pub(crate) fn new(
        source: SkillSourceId,
        subject: Option<String>,
        code: SkillDiagnosticCode,
        message: impl Into<String>,
    ) -> Self {
        Self {
            source,
            subject,
            code,
            message: message.into(),
        }
    }

    pub fn source(&self) -> &SkillSourceId {
        &self.source
    }

    pub fn subject(&self) -> Option<&str> {
        self.subject.as_deref()
    }

    pub fn code(&self) -> SkillDiagnosticCode {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}
