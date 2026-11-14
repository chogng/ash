//! Rebuildable, directory-side declaration indexing and fuzzy symbol search.
//!
//! The crate consumes source identities and verified source text from `ash-codebase`; it does
//! not scan the filesystem or claim Language Server semantic facts.

mod error;
mod extractor;
mod index;
mod matcher;
mod memory_store;
mod projection;
mod store;
mod types;

pub use error::SymbolIndexError;
pub use index::SymbolIndex;
pub use store::SourceSymbol;
pub use store::SourceSymbols;
pub use store::StoredSymbolManifest;
pub use store::StoredSymbolProjection;
pub use store::SymbolIndexStore;
pub use store::SymbolProjectionUpdate;
pub use store::SymbolSourceSummary;
pub use types::IndexedSymbol;
pub use types::SymbolIndexLimits;
pub use types::SymbolIndexQuery;
pub use types::SymbolIndexRefreshOutcome;
pub use types::SymbolIndexSnapshot;
pub use types::SymbolKind;
pub use types::SymbolRange;
pub use types::SymbolReference;
pub use types::SymbolSearchHit;

#[cfg(test)]
#[path = "symbol/symbol_tests.rs"]
mod tests;
