use std::num::NonZeroUsize;
use std::path::PathBuf;

use crate::IndexRootId;
use crate::IndexedLanguage;
use crate::SourceRevision;

const DEFAULT_MAX_SYMBOLS_PER_SOURCE: usize = 50_000;
const DEFAULT_MAX_TOTAL_SYMBOLS: usize = 1_000_000;
const DEFAULT_MAX_QUERY_BYTES: usize = 8 * 1024;
const DEFAULT_MAX_RESULTS: usize = 100;
const DEFAULT_MATCHER_THREADS: usize = 2;

/// Language-neutral kind of one syntactically declared directory symbol.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum SymbolKind {
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

impl SymbolKind {
    #[doc(hidden)]
    pub const fn id(self) -> &'static str {
        match self {
            Self::Constant => "constant",
            Self::Enum => "enum",
            Self::Field => "field",
            Self::Function => "function",
            Self::Macro => "macro",
            Self::Method => "method",
            Self::Module => "module",
            Self::Static => "static",
            Self::Struct => "struct",
            Self::Trait => "trait",
            Self::Type => "type",
            Self::Variable => "variable",
        }
    }

    #[doc(hidden)]
    pub fn from_id(value: &str) -> Option<Self> {
        match value {
            "constant" => Some(Self::Constant),
            "enum" => Some(Self::Enum),
            "field" => Some(Self::Field),
            "function" => Some(Self::Function),
            "macro" => Some(Self::Macro),
            "method" => Some(Self::Method),
            "module" => Some(Self::Module),
            "static" => Some(Self::Static),
            "struct" => Some(Self::Struct),
            "trait" => Some(Self::Trait),
            "type" => Some(Self::Type),
            "variable" => Some(Self::Variable),
            _ => None,
        }
    }
}

/// Exact UTF-8 byte range and zero-based row/byte-column positions for one symbol fact.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct SymbolRange {
    pub start_byte: usize,
    pub end_byte: usize,
    pub start_line: usize,
    pub start_column: usize,
    pub end_line: usize,
    pub end_column: usize,
}

/// Revision-bound location of one declaration extracted from a verified directory source.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct SymbolReference {
    pub root_id: IndexRootId,
    pub relative_path: PathBuf,
    pub source_revision: SourceRevision,
    pub language: IndexedLanguage,
    pub source_bytes: usize,
    pub ordinal: usize,
    pub declaration_range: SymbolRange,
    pub selection_range: SymbolRange,
}

/// One syntactically declared directory symbol.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IndexedSymbol {
    pub reference: SymbolReference,
    pub name: String,
    pub kind: SymbolKind,
    pub container_name: Option<String>,
}

/// One local fuzzy symbol match ordered by descending matcher score.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SymbolSearchHit {
    pub symbol: IndexedSymbol,
    pub score: u32,
    pub matched_indices: Vec<u32>,
}

/// Literal directory-symbol query and requested result bound.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SymbolIndexQuery {
    text: String,
    result_limit: NonZeroUsize,
}

impl SymbolIndexQuery {
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            result_limit: NonZeroUsize::new(50).expect("50 is non-zero"),
        }
    }

    pub fn with_result_limit(mut self, result_limit: NonZeroUsize) -> Self {
        self.result_limit = result_limit;
        self
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn result_limit(&self) -> NonZeroUsize {
        self.result_limit
    }
}

/// Resource limits applied while reconciling and querying one symbol index.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SymbolIndexLimits {
    pub(crate) max_symbols_per_source: usize,
    pub(crate) max_total_symbols: usize,
    pub(crate) max_query_bytes: usize,
    pub(crate) max_results: usize,
    pub(crate) matcher_threads: usize,
}

impl SymbolIndexLimits {
    pub fn with_max_symbols_per_source(mut self, value: NonZeroUsize) -> Self {
        self.max_symbols_per_source = value.get();
        self
    }

    pub fn with_max_total_symbols(mut self, value: NonZeroUsize) -> Self {
        self.max_total_symbols = value.get();
        self
    }

    pub fn with_max_results(mut self, value: NonZeroUsize) -> Self {
        self.max_results = value.get();
        self
    }

    pub fn with_matcher_threads(mut self, value: NonZeroUsize) -> Self {
        self.matcher_threads = value.get();
        self
    }
}

impl Default for SymbolIndexLimits {
    fn default() -> Self {
        Self {
            max_symbols_per_source: DEFAULT_MAX_SYMBOLS_PER_SOURCE,
            max_total_symbols: DEFAULT_MAX_TOTAL_SYMBOLS,
            max_query_bytes: DEFAULT_MAX_QUERY_BYTES,
            max_results: DEFAULT_MAX_RESULTS,
            matcher_threads: DEFAULT_MATCHER_THREADS,
        }
    }
}

/// Immutable publication summary for one symbol-index generation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SymbolIndexSnapshot {
    pub root_id: IndexRootId,
    pub generation: u64,
    pub source_generation: u64,
    pub indexed_source_count: usize,
    pub indexed_symbol_count: usize,
    pub symbol_limit_hit: bool,
}

/// Observable result of reconciling against the current Codebase manifest.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SymbolIndexRefreshOutcome {
    NoChange,
    Published(SymbolIndexSnapshot),
}
