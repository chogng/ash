use std::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SkillErrorKind {
    SourceUnavailable,
    DuplicateSource,
    SkillNotFound,
    ContentChanged,
    InvalidContent,
}

/// Sanitized catalog setup failure.
///
/// Messages do not expose source root paths or Skill content. Entry-local discovery failures are
/// represented by [`crate::SkillDiagnostic`] so one bad Skill does not fail the catalog.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillError {
    kind: SkillErrorKind,
    message: String,
}

impl SkillError {
    pub(crate) fn new(kind: SkillErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn kind(&self) -> SkillErrorKind {
        self.kind
    }
}

impl fmt::Display for SkillError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for SkillError {}
