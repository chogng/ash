use std::num::NonZeroUsize;

use crate::MaterializedChunk;
use ash_model_provider::EmbeddingVector;

use crate::CodebaseVectorStoreError;
use crate::EmbeddedCodeChunk;
use crate::EmbeddingIndexKey;
use crate::VectorSearchHit;

/// Exact-generation vector persistence and nearest-neighbor primitive used by Codebase.
///
/// Implementations must atomically replace one Directory generation, never merge references
/// across generations or embedding models, preserve Directory chunk identities, and make deletion idempotent.
/// Similarity search returns candidates in descending relevance order; final rerank policy remains
/// with [`crate::CodebaseSemanticService`].
pub trait CodebaseVectorStore: Send + Sync {
    /// Loads reusable embeddings for stable chunks in input order.
    ///
    /// Implementations may reuse a vector only when the Directory root, embedding model, relative
    /// path, language, and stable chunk key match. A generation mismatch alone must not prevent
    /// reuse because lexical generations advance after restart and rebuild.
    fn reusable_embeddings(
        &self,
        root_id: &crate::IndexRootId,
        embedding_index_key: &EmbeddingIndexKey,
        chunks: &[MaterializedChunk],
    ) -> Result<Vec<Option<EmbeddingVector>>, CodebaseVectorStoreError>;

    /// Saves completed embedding batches before a generation is published.
    ///
    /// Implementations must key cached vectors by the exact root, model, path, language, stable
    /// chunk identity, and content identity. Cached vectors are rebuildable and must never make a
    /// partial generation searchable.
    fn cache_embeddings(
        &self,
        root_id: &crate::IndexRootId,
        embedding_index_key: &EmbeddingIndexKey,
        chunks: &[EmbeddedCodeChunk],
    ) -> Result<(), CodebaseVectorStoreError>;

    /// Returns the currently published searchable generation, if any.
    fn published_generation(
        &self,
        root_id: &crate::IndexRootId,
        embedding_index_key: &EmbeddingIndexKey,
    ) -> Result<Option<u64>, CodebaseVectorStoreError>;

    /// Atomically publishes all chunks for one exact lexical generation.
    fn replace_generation(
        &self,
        root_id: &crate::IndexRootId,
        generation: u64,
        embedding_index_key: &EmbeddingIndexKey,
        chunks: Vec<EmbeddedCodeChunk>,
    ) -> Result<(), CodebaseVectorStoreError>;

    /// Returns descending-similarity candidates only for the exact root, generation, and model.
    fn search(
        &self,
        root_id: &crate::IndexRootId,
        generation: u64,
        embedding_index_key: &EmbeddingIndexKey,
        query: &EmbeddingVector,
        result_limit: NonZeroUsize,
    ) -> Result<Vec<VectorSearchHit>, CodebaseVectorStoreError>;

    /// Deletes the rebuildable projection for the given root and succeeds when it is already gone.
    fn delete_index(&self, root_id: &crate::IndexRootId) -> Result<(), CodebaseVectorStoreError>;
}
