use std::num::NonZeroUsize;
use std::sync::Arc;

use crate::ChunkReference;
use crate::IndexedLanguage;
use ash_model_provider::EmbeddingVector;
use ash_model_provider::{EmbeddingInvoker, RerankInvoker};
use sha2::{Digest, Sha256};

use crate::CodebaseSemanticError;

macro_rules! text_identity {
    ($name:ident, $message:literal) => {
        #[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, CodebaseSemanticError> {
                let value = value.into();
                if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
                    return Err(CodebaseSemanticError::InvalidInput($message));
                }
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
    };
}

text_identity!(
    EmbeddingIndexKey,
    "embedding model identity must be 1..=256 bytes without control characters"
);

impl EmbeddingIndexKey {
    /// Derives the persistent vector identity from the document encoder and model runtime.
    pub fn for_device_model(
        provider_id: &str,
        model_id: &str,
        runtime_identity: &str,
    ) -> Result<Self, CodebaseSemanticError> {
        let mut digest = Sha256::new();
        for value in [
            "ash-codebase-document-v1",
            provider_id,
            model_id,
            runtime_identity,
        ] {
            digest.update(value.len().to_le_bytes());
            digest.update(value.as_bytes());
        }
        Self::new(format!("semantic:sha256:{:x}", digest.finalize()))
    }
}

/// Device-side model runtime selected for optional semantic Codebase indexing and query.
#[derive(Clone)]
pub struct CodebaseModels {
    embedding_index_key: EmbeddingIndexKey,
    embedding: Arc<dyn EmbeddingInvoker>,
    rerank: Option<Arc<dyn RerankInvoker>>,
}

impl CodebaseModels {
    pub fn new(
        embedding_index_key: EmbeddingIndexKey,
        embedding: Arc<dyn EmbeddingInvoker>,
    ) -> Self {
        Self {
            embedding_index_key,
            embedding,
            rerank: None,
        }
    }

    pub fn with_rerank(mut self, rerank: Arc<dyn RerankInvoker>) -> Self {
        self.rerank = Some(rerank);
        self
    }

    pub fn embedding_index_key(&self) -> &EmbeddingIndexKey {
        &self.embedding_index_key
    }

    pub fn embedding(&self) -> Arc<dyn EmbeddingInvoker> {
        Arc::clone(&self.embedding)
    }

    pub fn rerank(&self) -> Option<Arc<dyn RerankInvoker>> {
        self.rerank.clone()
    }
}

/// Bounded semantic query against the current local Directory generation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodebaseSemanticQuery {
    text: String,
    result_limit: NonZeroUsize,
}

impl CodebaseSemanticQuery {
    pub fn new(
        text: impl Into<String>,
        result_limit: NonZeroUsize,
    ) -> Result<Self, CodebaseSemanticError> {
        let text = text.into();
        if text.trim().is_empty() || text.len() > 8 * 1024 {
            return Err(CodebaseSemanticError::InvalidInput(
                "query must contain 1..=8192 bytes of non-whitespace text",
            ));
        }
        if result_limit.get() > 100 {
            return Err(CodebaseSemanticError::InvalidInput(
                "query result limit must not exceed 100",
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

/// Final locally ranked references for one exact semantic generation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodebaseSemanticQueryResult {
    pub generation: u64,
    pub candidates: Vec<ChunkReference>,
}

/// Result of synchronizing the local semantic projection to the lexical index generation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodebaseSemanticSyncResult {
    pub generation: u64,
    pub indexed_chunk_count: usize,
    pub reused_embedding_count: usize,
    pub retry_count: usize,
}

/// Stable phase of one semantic synchronization operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CodebaseSemanticSyncPhase {
    Preparing,
    Embedding,
    Publishing,
    Complete,
}

/// Content-free progress counters for one exact lexical generation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodebaseSemanticSyncProgress {
    pub phase: CodebaseSemanticSyncPhase,
    pub generation: u64,
    pub total_chunk_count: usize,
    pub processed_chunk_count: usize,
    pub reused_embedding_count: usize,
    pub embedded_chunk_count: usize,
    pub completed_batch_count: usize,
    pub total_batch_count: usize,
    pub retry_count: usize,
}

/// Receives bounded, content-free semantic synchronization progress.
pub trait CodebaseSemanticProgressSink: Send + Sync {
    fn report(&self, progress: &CodebaseSemanticSyncProgress);
}

/// Privacy-safe operational measurement emitted by the semantic pipeline.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodebaseSemanticMetric {
    SyncCompleted {
        chunk_count: usize,
        reused_count: usize,
        embedded_count: usize,
        retry_count: usize,
        elapsed_millis: u64,
    },
    SyncCancelled {
        processed_count: usize,
    },
    SyncFailed,
    QueryCompleted {
        candidate_count: usize,
        retry_count: usize,
        elapsed_millis: u64,
    },
    QueryDegraded,
}

/// Receives metrics that intentionally exclude source text, paths, queries, endpoints, and secrets.
pub trait CodebaseSemanticMetricsSink: Send + Sync {
    fn record(&self, metric: CodebaseSemanticMetric);
}

/// One Directory-produced chunk plus its model embedding stored by the local projection.
#[derive(Clone, Debug, PartialEq)]
pub struct EmbeddedCodeChunk {
    pub reference: ChunkReference,
    pub language: IndexedLanguage,
    pub content: String,
    pub embedding: EmbeddingVector,
}

/// One vector-recall candidate in vector-store relevance order.
#[derive(Clone, Debug, PartialEq)]
pub struct VectorSearchHit {
    pub chunk: EmbeddedCodeChunk,
    pub similarity: f32,
}
