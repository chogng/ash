//! Presentation-independent text diff data shared by Native and TUI.
//!
//! This crate owns deterministic line matching, original/modified line mapping, inline changed
//! ranges, hunk grouping, input limits, and cancellation. It does not own file I/O, Git commands,
//! syntax highlighting, editor state, terminal rendering, or UI lifecycle.

mod engine;
mod error;
mod inline;
mod model;
mod myers;
mod options;

pub use engine::{DiffCancellation, DiffEngine, NeverCancel};
pub use error::{DiffError, DiffSide};
pub use model::{DiffDocument, DiffHunk, DiffLine, DiffRow, DiffRowKind, InlineChange, LineEnding};
pub use options::{
    CaseSensitivity, DiffLimits, DiffOptions, InlineDiffMode, LineEndingPolicy, WhitespacePolicy,
};

impl DiffDocument {
    /// Computes an exact line diff with the default limits and three context lines.
    pub fn from_text(original: &str, modified: &str) -> Result<Self, DiffError> {
        DiffEngine::default().compute(original, modified)
    }

    /// Computes a line diff with explicit comparison, inline, context, and limit policy.
    pub fn with_options(
        original: &str,
        modified: &str,
        options: DiffOptions,
    ) -> Result<Self, DiffError> {
        DiffEngine::new(options).compute(original, modified)
    }
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;
