//! Complete, directory-side code knowledge construction and retrieval.
//!
//! The crate owns source scanning, stable identities, local indexes, semantic model input,
//! candidate fusion, current-source verification, and retrieval budgets. Product hosts retain
//! directory authorization, watcher lifecycle, model construction, and transport adaptation.

mod chunker;
mod error;
mod index;
mod memory_store;
mod overlay;
mod retrieval;
mod scanner;
mod semantic;
mod store;
mod symbol;
mod types;

#[doc(hidden)]
pub use chunker::{CHUNKER_VERSION, PreparedChunk};
pub use error::CodebaseError;
pub use index::Codebase;
pub use retrieval::*;
#[doc(hidden)]
pub use scanner::{DirScan, PreparedFile};
pub use semantic::*;
pub use store::{CodebaseIndexStore, FileUpdate, StoredSource};
pub use symbol::*;
pub use types::ChunkContentHash;
pub use types::ChunkKey;
pub use types::ChunkReference;
pub use types::ChunkSpan;
pub use types::CodebaseLimits;
pub use types::CodebaseManifest;
pub use types::CodebaseOverlayDocument;
pub use types::CodebaseOverlaySnapshot;
pub use types::CodebaseQuery;
pub use types::CodebaseSnapshot;
pub use types::IndexRootId;
pub use types::IndexedChunkReference;
pub use types::IndexedLanguage;
pub use types::IndexedSourceReference;
pub use types::MaterializedChunk;
pub use types::MaterializedExcerpt;
pub use types::MaterializedOverlayDocument;
pub use types::MaterializedSource;
pub use types::RefreshOutcome;
pub use types::SearchHit;
pub use types::SourceExcerptReference;
pub use types::SourceRevision;

#[cfg(test)]
#[path = "codebase_tests.rs"]
mod tests;
