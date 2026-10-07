use std::num::NonZeroUsize;

use crate::ChunkReference;
use crate::IndexRootId;
use crate::IndexedLanguage;
use crate::SourceExcerptReference;

use crate::CodebaseRetrievalError;

const DEFAULT_MAX_ITEM_BYTES: usize = 32 * 1024;
const DEFAULT_MAX_TOTAL_BYTES: usize = 128 * 1024;

/// One optional Codebase enhancement that contributes already ranked chunk references.
///
/// Implementations may perform work outside this crate, but they can only return exact chunks
/// created by the Directory-owned Codebase.
pub trait CodebaseEnhancement: Send + Sync {
    fn root_id(&self) -> &IndexRootId;

    fn query(
        &self,
        text: &str,
        result_limit: NonZeroUsize,
    ) -> Result<Vec<ChunkReference>, CodebaseEnhancementError>;
}

/// Sanitized failure reported by a Codebase enhancement.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodebaseEnhancementError;

impl CodebaseEnhancementError {
    pub fn unavailable() -> Self {
        Self
    }
}

/// Literal query shared by local lexical and optional semantic candidate sources.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodebaseRetrievalQuery {
    text: String,
    result_limit: NonZeroUsize,
}

impl CodebaseRetrievalQuery {
    pub fn new(
        text: impl Into<String>,
        result_limit: NonZeroUsize,
    ) -> Result<Self, CodebaseRetrievalError> {
        let text = text.into();
        if text.trim().is_empty() {
            return Err(CodebaseRetrievalError::InvalidQuery(
                "query must contain non-whitespace text",
            ));
        }
        if text.len() > 8 * 1024 {
            return Err(CodebaseRetrievalError::InvalidQuery(
                "query exceeds the 8192-byte limit",
            ));
        }
        if result_limit.get() > 100 {
            return Err(CodebaseRetrievalError::InvalidQuery(
                "result limit must not exceed 100",
            ));
        }
        Ok(Self { text, result_limit })
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn result_limit(&self) -> NonZeroUsize {
        self.result_limit
    }
}

/// Content ceilings applied after candidate fusion and current-source verification.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodebaseRetrievalBudget {
    max_item_bytes: NonZeroUsize,
    max_total_bytes: NonZeroUsize,
}

impl CodebaseRetrievalBudget {
    pub fn with_max_item_bytes(mut self, value: NonZeroUsize) -> Self {
        self.max_item_bytes = value;
        self
    }

    pub fn with_max_total_bytes(mut self, value: NonZeroUsize) -> Self {
        self.max_total_bytes = value;
        self
    }

    pub(crate) fn max_item_bytes(&self) -> usize {
        self.max_item_bytes.get()
    }

    pub(crate) fn max_total_bytes(&self) -> usize {
        self.max_total_bytes.get()
    }
}

impl Default for CodebaseRetrievalBudget {
    fn default() -> Self {
        Self {
            max_item_bytes: NonZeroUsize::new(DEFAULT_MAX_ITEM_BYTES)
                .expect("default item budget is non-zero"),
            max_total_bytes: NonZeroUsize::new(DEFAULT_MAX_TOTAL_BYTES)
                .expect("default total budget is non-zero"),
        }
    }
}

/// Candidate source that contributed to one fused hit.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum CodebaseRetrievalOrigin {
    LocalSymbol,
    LocalLexical,
    LocalSemantic,
    CloudSemantic,
}

/// Non-fatal loss of one optional source or candidate set.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodebaseRetrievalDegradation {
    LocalSymbolQueryFailed,
    LocalSemanticQueryFailed,
    CloudQueryFailed,
    CandidateVerificationFailed { discarded: usize },
    ContentBudgetExceeded { discarded: usize },
}

/// One deduplicated, current-source-verified code excerpt.
#[derive(Clone, Debug, PartialEq)]
pub struct CodebaseRetrievalHit {
    pub reference: SourceExcerptReference,
    pub language: IndexedLanguage,
    pub content: String,
    pub rrf_score: f64,
    pub origins: Vec<CodebaseRetrievalOrigin>,
}

/// Fused hits plus explicit non-fatal degradation facts.
#[derive(Clone, Debug, PartialEq)]
pub struct CodebaseRetrievalResult {
    pub hits: Vec<CodebaseRetrievalHit>,
    pub degradations: Vec<CodebaseRetrievalDegradation>,
}
