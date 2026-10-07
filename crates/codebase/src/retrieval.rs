//! Policy-neutral orchestration of local lexical, local semantic, and optional remote recall.
//!
//! This crate owns candidate fan-out, reciprocal-rank fusion, identity deduplication, current
//! source verification, graceful source fallback, and content budgets. Lexical indexing remains in
//! `ash-codebase`, local dense recall in `ash-codebase`, and grant and
//! remote-generation authority in `ash-cloud-codebase`.

mod error;
mod service;
mod types;

pub use error::CodebaseRetrievalError;
pub use service::CodebaseRetrievalService;
pub use types::CodebaseEnhancement;
pub use types::CodebaseEnhancementError;
pub use types::CodebaseRetrievalBudget;
pub use types::CodebaseRetrievalDegradation;
pub use types::CodebaseRetrievalHit;
pub use types::CodebaseRetrievalOrigin;
pub use types::CodebaseRetrievalQuery;
pub use types::CodebaseRetrievalResult;

#[cfg(test)]
#[path = "retrieval/retrieval_tests.rs"]
mod tests;
