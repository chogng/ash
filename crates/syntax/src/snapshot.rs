use std::ops::Range;

use crate::DocumentRevision;

/// Resource limits applied when deriving a syntax snapshot.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AnalysisLimits {
    pub max_document_bytes: usize,
    pub max_tokens: usize,
    pub max_folding_ranges: usize,
    /// Maximum number of enclosing syntax ranges returned for one selection query.
    pub max_selection_ranges: usize,
    pub max_symbols: usize,
    pub max_diagnostics: usize,
}

impl Default for AnalysisLimits {
    fn default() -> Self {
        Self {
            max_document_bytes: 4 * 1024 * 1024,
            max_tokens: 200_000,
            max_folding_ranges: 20_000,
            max_selection_ranges: 64,
            max_symbols: 50_000,
            max_diagnostics: 10_000,
        }
    }
}

/// Zero-based tree-sitter position whose column is a UTF-8 byte offset within the row.
#[derive(Clone, Copy, Debug, Default, Eq, Ord, PartialEq, PartialOrd)]
pub struct SyntaxPoint {
    pub row: usize,
    pub column: usize,
}

/// UTF-8 byte range and its corresponding zero-based row/byte-column positions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SyntaxRange {
    pub bytes: Range<usize>,
    pub start: SyntaxPoint,
    pub end: SyntaxPoint,
}

/// Stable, language-neutral syntax highlighting category.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum SyntaxTokenKind {
    Attribute,
    Comment,
    Constant,
    Constructor,
    Embedded,
    Function,
    Keyword,
    Label,
    Module,
    Number,
    Operator,
    Property,
    Punctuation,
    String,
    Type,
    Variable,
}

/// One ordered tree-sitter highlight capture.
///
/// Captures may overlap when a grammar assigns a general category to a parent and a more specific
/// category to a child. Consumers should apply later, narrower captures over earlier ones.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SyntaxToken {
    pub range: SyntaxRange,
    pub kind: SyntaxTokenKind,
}

/// One structurally foldable source range.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FoldingRange {
    pub range: SyntaxRange,
}

/// One named parser node that can participate in structural selection expansion.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectionRange {
    pub range: SyntaxRange,
}

/// Language-neutral kind for a syntactically declared document symbol.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum DocumentSymbolKind {
    Constant,
    Enum,
    Field,
    Function,
    Macro,
    Method,
    Module,
    Static,
    Struct,
    Trait,
    Type,
    Variable,
}

/// One syntactically declared symbol in the current document.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DocumentSymbol {
    pub name: String,
    pub kind: DocumentSymbolKind,
    pub range: SyntaxRange,
    pub selection_range: SyntaxRange,
}

/// Recoverable parser error or missing construct in a syntax tree.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum SyntaxDiagnosticKind {
    Error,
    Missing,
}

/// Recoverable parser diagnostic derived from a syntax tree.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SyntaxDiagnostic {
    pub range: SyntaxRange,
    pub kind: SyntaxDiagnosticKind,
}

/// Immutable derived analysis for one exact document revision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SyntaxSnapshot {
    revision: DocumentRevision,
    has_errors: bool,
    tokens: Vec<SyntaxToken>,
    folding_ranges: Vec<FoldingRange>,
    symbols: Vec<DocumentSymbol>,
    diagnostics: Vec<SyntaxDiagnostic>,
}

impl SyntaxSnapshot {
    pub(crate) fn new(
        revision: DocumentRevision,
        has_errors: bool,
        tokens: Vec<SyntaxToken>,
        folding_ranges: Vec<FoldingRange>,
        symbols: Vec<DocumentSymbol>,
        diagnostics: Vec<SyntaxDiagnostic>,
    ) -> Self {
        Self {
            revision,
            has_errors,
            tokens,
            folding_ranges,
            symbols,
            diagnostics,
        }
    }

    pub const fn revision(&self) -> DocumentRevision {
        self.revision
    }

    pub fn tokens(&self) -> &[SyntaxToken] {
        &self.tokens
    }

    pub fn folding_ranges(&self) -> &[FoldingRange] {
        &self.folding_ranges
    }

    pub fn symbols(&self) -> &[DocumentSymbol] {
        &self.symbols
    }

    pub fn diagnostics(&self) -> &[SyntaxDiagnostic] {
        &self.diagnostics
    }

    pub const fn has_errors(&self) -> bool {
        self.has_errors
    }
}
