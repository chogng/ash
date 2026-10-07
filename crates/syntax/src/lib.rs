//! Incremental, presentation-independent source syntax analysis.

mod document;
mod error;
mod language;
mod snapshot;

pub use document::{DocumentRevision, SyntaxDocument, SyntaxEdit};
pub use error::SyntaxError;
pub use language::SyntaxLanguage;
pub use snapshot::{
    AnalysisLimits, DocumentSymbol, DocumentSymbolKind, FoldingRange, SelectionRange,
    SyntaxDiagnostic, SyntaxDiagnosticKind, SyntaxPoint, SyntaxRange, SyntaxSnapshot, SyntaxToken,
    SyntaxTokenKind,
};

/// Identity of the persisted syntax-fact contract consumed by rebuildable projections.
///
/// Grammar or structural-query changes that can alter document symbols, folding ranges, or other
/// stored facts must change this value so consumers do not reuse incompatible projections.
pub const SYNTAX_FACTS_VERSION: &str = "ash-syntax-facts-v1";

#[cfg(test)]
#[path = "syntax_tests.rs"]
mod tests;
