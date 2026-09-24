use ash_diff::{DiffDocument, DiffLine, LineEnding};

use crate::{CodeEditorDocument, CodeEditorLanguage, CodeEditorSyntaxToken};

use super::DiffEditorSide;
use super::DiffEditorState;
use super::unified::UnifiedDiffMetrics;

/// Retained document model for one read-only diff editor implementation.
///
/// Hosts provide the computed diff and selected language. The editor keeps both source texts,
/// parser revisions, and syntax-token projection private so callers never synchronize syntax
/// state for individual diff panes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiffEditorDocument {
    diff: DiffDocument,
    original: CodeEditorDocument,
    modified: CodeEditorDocument,
    unified_metrics: UnifiedDiffMetrics,
}

impl DiffEditorDocument {
    pub fn new(diff: DiffDocument, language: CodeEditorLanguage) -> Self {
        let unified_metrics = UnifiedDiffMetrics::new(&diff);
        let original = CodeEditorDocument::from_text_with_language(
            source_text(&diff, DiffEditorSide::Original),
            language,
        );
        let modified = CodeEditorDocument::from_text_with_language(
            source_text(&diff, DiffEditorSide::Modified),
            language,
        );
        Self {
            diff,
            original,
            modified,
            unified_metrics,
        }
    }

    pub const fn diff(&self) -> &DiffDocument {
        &self.diff
    }

    pub const fn language(&self) -> CodeEditorLanguage {
        self.original.language()
    }

    pub fn set_language(&mut self, language: CodeEditorLanguage) {
        self.original.set_language(language);
        self.modified.set_language(language);
    }

    pub(super) fn unified_row_count(&self, state: &DiffEditorState) -> usize {
        self.unified_metrics.row_count(state)
    }

    pub(super) fn syntax_tokens(
        &self,
        side: DiffEditorSide,
        line_number: usize,
    ) -> &[CodeEditorSyntaxToken] {
        let document = match side {
            DiffEditorSide::Original => &self.original,
            DiffEditorSide::Modified => &self.modified,
        };
        document.syntax_tokens_for_row(line_number.saturating_sub(1))
    }
}

fn source_text(diff: &DiffDocument, side: DiffEditorSide) -> String {
    let mut text = String::new();
    for line in diff.rows().iter().filter_map(|row| match side {
        DiffEditorSide::Original => row.old(),
        DiffEditorSide::Modified => row.new_line(),
    }) {
        append_line(&mut text, line);
    }
    text
}

fn append_line(text: &mut String, line: &DiffLine) {
    text.push_str(line.text());
    text.push_str(match line.ending() {
        LineEnding::Lf => "\n",
        LineEnding::CrLf => "\r\n",
        LineEnding::Cr => "\r",
        LineEnding::None => "",
    });
}

#[cfg(test)]
#[path = "document_tests.rs"]
mod tests;
