use std::ops::Range;

use ash_syntax::{
    DocumentRevision, SyntaxDocument, SyntaxEdit, SyntaxLanguage, SyntaxSnapshot, SyntaxTokenKind,
};

use super::{CodeEditorFoldingRange, CodeEditorSyntaxToken, CodeEditorTokenRole};

pub(super) struct CodeEditorAnalysisSnapshot {
    pub(super) syntax_tokens: Vec<Vec<CodeEditorSyntaxToken>>,
    pub(super) folding_ranges: Vec<CodeEditorFoldingRange>,
}

impl CodeEditorAnalysisSnapshot {
    fn plain_text(line_count: usize) -> Self {
        Self {
            syntax_tokens: vec![Vec::new(); line_count],
            folding_ranges: Vec::new(),
        }
    }
}

/// Language mode selected by a host for one [`super::CodeEditorDocument`].
///
/// CodeEditor implementations use the mode to own syntax analysis and token projection internally;
/// hosts do not construct parser documents or synchronize syntax revisions themselves.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum CodeEditorLanguage {
    #[default]
    PlainText,
    Shell,
    Json,
    Jsonc,
    Rust,
}

#[derive(Default)]
pub(super) struct CodeEditorAnalysis {
    language: CodeEditorLanguage,
    document: Option<SyntaxDocument>,
    revision: u64,
}

impl CodeEditorAnalysis {
    pub(super) const fn language(&self) -> CodeEditorLanguage {
        self.language
    }

    pub(super) fn set_language(&mut self, language: CodeEditorLanguage) {
        if self.language == language {
            return;
        }
        self.language = language;
        self.document = None;
        self.revision = 0;
    }

    pub(super) fn synchronize(
        &mut self,
        text: &str,
        line_ranges: &[Range<usize>],
    ) -> CodeEditorAnalysisSnapshot {
        let Some(language) = syntax_language(self.language) else {
            self.document = None;
            self.revision = 0;
            return CodeEditorAnalysisSnapshot::plain_text(line_ranges.len());
        };
        let next_revision = self.revision.saturating_add(1).max(1);
        let snapshot = match self.document.as_mut() {
            Some(document) if document.language() == language && document.text() == text => {
                document.snapshot()
            }
            Some(document) if document.language() == language => {
                let edit = replacement_between(document.text(), text);
                match document.apply_edit(DocumentRevision::new(next_revision), &edit) {
                    Ok(snapshot) => {
                        self.revision = next_revision;
                        snapshot
                    }
                    Err(_) => return self.reopen(language, text, line_ranges, next_revision),
                }
            }
            _ => return self.reopen(language, text, line_ranges, next_revision),
        };
        project_snapshot(line_ranges, &snapshot)
    }

    fn reopen(
        &mut self,
        language: SyntaxLanguage,
        text: &str,
        line_ranges: &[Range<usize>],
        revision: u64,
    ) -> CodeEditorAnalysisSnapshot {
        let Ok(document) = SyntaxDocument::open(language, DocumentRevision::new(revision), text)
        else {
            self.document = None;
            return CodeEditorAnalysisSnapshot::plain_text(line_ranges.len());
        };
        let snapshot = project_snapshot(line_ranges, &document.snapshot());
        self.document = Some(document);
        self.revision = revision;
        snapshot
    }
}

fn syntax_language(language: CodeEditorLanguage) -> Option<SyntaxLanguage> {
    match language {
        CodeEditorLanguage::PlainText => None,
        CodeEditorLanguage::Shell => Some(SyntaxLanguage::Shell),
        CodeEditorLanguage::Json => Some(SyntaxLanguage::Json),
        CodeEditorLanguage::Jsonc => Some(SyntaxLanguage::Jsonc),
        CodeEditorLanguage::Rust => Some(SyntaxLanguage::Rust),
    }
}

fn replacement_between(current: &str, next: &str) -> SyntaxEdit {
    let mut prefix = current
        .as_bytes()
        .iter()
        .zip(next.as_bytes())
        .take_while(|(left, right)| left == right)
        .count();
    while prefix > 0 && (!current.is_char_boundary(prefix) || !next.is_char_boundary(prefix)) {
        prefix -= 1;
    }
    let suffix = current[prefix..]
        .chars()
        .rev()
        .zip(next[prefix..].chars().rev())
        .take_while(|(left, right)| left == right)
        .map(|(character, _)| character.len_utf8())
        .sum::<usize>();
    SyntaxEdit::replace(
        prefix..current.len() - suffix,
        &next[prefix..next.len() - suffix],
    )
}

fn project_snapshot(
    line_ranges: &[Range<usize>],
    snapshot: &SyntaxSnapshot,
) -> CodeEditorAnalysisSnapshot {
    let mut lines = vec![Vec::new(); line_ranges.len()];
    for token in snapshot.tokens() {
        let mut line_index =
            line_ranges.partition_point(|line| line.end <= token.range.bytes.start);
        while let Some(line) = line_ranges.get(line_index) {
            if line.start >= token.range.bytes.end {
                break;
            }
            let start = token.range.bytes.start.max(line.start);
            let end = token.range.bytes.end.min(line.end);
            if start < end {
                lines[line_index].push(CodeEditorSyntaxToken::new(
                    start - line.start..end - line.start,
                    token_role(token.kind),
                ));
            }
            line_index += 1;
        }
    }
    let folding_ranges = snapshot
        .folding_ranges()
        .iter()
        .filter_map(|range| CodeEditorFoldingRange::new(range.range.start.row, range.range.end.row))
        .collect();
    CodeEditorAnalysisSnapshot {
        syntax_tokens: lines,
        folding_ranges,
    }
}

fn token_role(kind: SyntaxTokenKind) -> CodeEditorTokenRole {
    match kind {
        SyntaxTokenKind::Attribute => CodeEditorTokenRole::Attribute,
        SyntaxTokenKind::Comment => CodeEditorTokenRole::Comment,
        SyntaxTokenKind::Constant => CodeEditorTokenRole::Constant,
        SyntaxTokenKind::Constructor => CodeEditorTokenRole::Constructor,
        SyntaxTokenKind::Embedded => CodeEditorTokenRole::Embedded,
        SyntaxTokenKind::Function => CodeEditorTokenRole::Function,
        SyntaxTokenKind::Keyword => CodeEditorTokenRole::Keyword,
        SyntaxTokenKind::Label => CodeEditorTokenRole::Label,
        SyntaxTokenKind::Module => CodeEditorTokenRole::Module,
        SyntaxTokenKind::Number => CodeEditorTokenRole::Number,
        SyntaxTokenKind::Operator => CodeEditorTokenRole::Operator,
        SyntaxTokenKind::Property => CodeEditorTokenRole::Property,
        SyntaxTokenKind::Punctuation => CodeEditorTokenRole::Punctuation,
        SyntaxTokenKind::String => CodeEditorTokenRole::String,
        SyntaxTokenKind::Type => CodeEditorTokenRole::Type,
        SyntaxTokenKind::Variable => CodeEditorTokenRole::Variable,
    }
}

#[cfg(test)]
#[path = "analysis_tests.rs"]
mod tests;
