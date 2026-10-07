//! Local semantic indexing for Directory-produced code chunks.
//!
//! The crate embeds exact chunks from `ash-codebase`, persists vectors in a rebuildable local
//! projection, owns vector recall and optional rerank ordering, and returns chunk references only.
//! It never scans a Directory or owns remote service deployment.

mod error;
mod memory_store;
mod service;
mod store;
mod types;

pub use error::CodebaseSemanticError;
pub use error::CodebaseVectorStoreError;
pub use memory_store::InMemoryCodebaseVectorStore;
pub use service::CodebaseSemanticService;
pub use store::CodebaseVectorStore;
pub use types::CodebaseModels;
pub use types::CodebaseSemanticMetric;
pub use types::CodebaseSemanticMetricsSink;
pub use types::CodebaseSemanticProgressSink;
pub use types::CodebaseSemanticQuery;
pub use types::CodebaseSemanticQueryResult;
pub use types::CodebaseSemanticSyncPhase;
pub use types::CodebaseSemanticSyncProgress;
pub use types::CodebaseSemanticSyncResult;
pub use types::EmbeddedCodeChunk;
pub use types::EmbeddingIndexKey;
pub use types::VectorSearchHit;

#[cfg(test)]
#[path = "semantic/service_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "semantic/key_tests.rs"]
mod key_tests;
