use std::collections::BTreeMap;
use std::num::NonZeroUsize;
use std::sync::Mutex;

use crate::MaterializedChunk;
use ash_model_provider::EmbeddingVector;

use crate::CodebaseVectorStore;
use crate::CodebaseVectorStoreError;
use crate::EmbeddedCodeChunk;
use crate::EmbeddingIndexKey;
use crate::VectorSearchHit;

#[derive(Default)]
pub struct InMemoryCodebaseVectorStore {
    collections: Mutex<BTreeMap<String, StoredGeneration>>,
    cache: Mutex<BTreeMap<CacheIdentity, EmbeddingVector>>,
}

#[derive(Clone, Eq, Ord, PartialEq, PartialOrd)]
struct CacheIdentity {
    root: String,
    model: String,
    path: std::path::PathBuf,
    language: String,
    chunk_key: String,
    content_hash: String,
}

struct StoredGeneration {
    id: u64,
    embedding_index_key: EmbeddingIndexKey,
    chunks: Vec<EmbeddedCodeChunk>,
}

impl CodebaseVectorStore for InMemoryCodebaseVectorStore {
    fn reusable_embeddings(
        &self,
        root_id: &crate::IndexRootId,
        embedding_index_key: &EmbeddingIndexKey,
        chunks: &[MaterializedChunk],
    ) -> Result<Vec<Option<EmbeddingVector>>, CodebaseVectorStoreError> {
        let collections = self
            .collections
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let stored = collections
            .get(root_id.as_str())
            .filter(|stored| &stored.embedding_index_key == embedding_index_key);
        let cache = self
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Ok(chunks
            .iter()
            .map(|chunk| {
                stored
                    .and_then(|stored| {
                        stored
                            .chunks
                            .iter()
                            .find(|stored| reusable_identity_matches(stored, chunk))
                            .map(|stored| stored.embedding.clone())
                    })
                    .or_else(|| {
                        cache
                            .get(&cache_identity(root_id, embedding_index_key, chunk))
                            .cloned()
                    })
            })
            .collect())
    }

    fn cache_embeddings(
        &self,
        root_id: &crate::IndexRootId,
        embedding_index_key: &EmbeddingIndexKey,
        chunks: &[EmbeddedCodeChunk],
    ) -> Result<(), CodebaseVectorStoreError> {
        let mut cache = self
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for chunk in chunks {
            cache.insert(
                CacheIdentity {
                    root: root_id.as_str().to_owned(),
                    model: embedding_index_key.as_str().to_owned(),
                    path: chunk.reference.relative_path.clone(),
                    language: chunk.language.id().to_owned(),
                    chunk_key: chunk.reference.key.as_str().to_owned(),
                    content_hash: chunk.reference.content_hash.as_str().to_owned(),
                },
                chunk.embedding.clone(),
            );
        }
        Ok(())
    }

    fn published_generation(
        &self,
        root_id: &crate::IndexRootId,
        embedding_index_key: &EmbeddingIndexKey,
    ) -> Result<Option<u64>, CodebaseVectorStoreError> {
        Ok(self
            .collections
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(root_id.as_str())
            .filter(|stored| &stored.embedding_index_key == embedding_index_key)
            .map(|stored| stored.id))
    }

    fn replace_generation(
        &self,
        root_id: &crate::IndexRootId,
        generation: u64,
        embedding_index_key: &EmbeddingIndexKey,
        chunks: Vec<EmbeddedCodeChunk>,
    ) -> Result<(), CodebaseVectorStoreError> {
        let dimension = chunks.first().map(|chunk| chunk.embedding.values().len());
        if dimension.is_some_and(|dimension| {
            chunks
                .iter()
                .any(|chunk| chunk.embedding.values().len() != dimension)
        }) {
            return Err(CodebaseVectorStoreError::new(
                "stored embedding dimensions are inconsistent",
            ));
        }
        self.cache_embeddings(root_id, embedding_index_key, &chunks)?;
        self.collections
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                root_id.as_str().to_owned(),
                StoredGeneration {
                    id: generation,
                    embedding_index_key: embedding_index_key.clone(),
                    chunks,
                },
            );
        Ok(())
    }

    fn search(
        &self,
        root_id: &crate::IndexRootId,
        generation: u64,
        embedding_index_key: &EmbeddingIndexKey,
        query: &EmbeddingVector,
        result_limit: NonZeroUsize,
    ) -> Result<Vec<VectorSearchHit>, CodebaseVectorStoreError> {
        let collections = self
            .collections
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let stored = collections
            .get(root_id.as_str())
            .ok_or_else(|| CodebaseVectorStoreError::new("semantic index does not exist"))?;
        if stored.id != generation {
            return Err(CodebaseVectorStoreError::new(
                "requested generation is not current",
            ));
        }
        if &stored.embedding_index_key != embedding_index_key {
            return Err(CodebaseVectorStoreError::new(
                "requested embedding model is not current",
            ));
        }
        let mut hits = stored
            .chunks
            .iter()
            .cloned()
            .map(|chunk| {
                let similarity = cosine_similarity(query.values(), chunk.embedding.values())?;
                Ok(VectorSearchHit { chunk, similarity })
            })
            .collect::<Result<Vec<_>, CodebaseVectorStoreError>>()?;
        hits.sort_by(|left, right| {
            right
                .similarity
                .total_cmp(&left.similarity)
                .then_with(|| left.chunk.reference.cmp(&right.chunk.reference))
        });
        hits.truncate(result_limit.get());
        Ok(hits)
    }

    fn delete_index(&self, root_id: &crate::IndexRootId) -> Result<(), CodebaseVectorStoreError> {
        self.collections
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(root_id.as_str());
        self.cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .retain(|identity, _| identity.root != root_id.as_str());
        Ok(())
    }
}

fn cache_identity(
    root_id: &crate::IndexRootId,
    embedding_index_key: &EmbeddingIndexKey,
    chunk: &MaterializedChunk,
) -> CacheIdentity {
    CacheIdentity {
        root: root_id.as_str().to_owned(),
        model: embedding_index_key.as_str().to_owned(),
        path: chunk.reference.relative_path.clone(),
        language: chunk.language.id().to_owned(),
        chunk_key: chunk.reference.key.as_str().to_owned(),
        content_hash: chunk.reference.content_hash.as_str().to_owned(),
    }
}

fn reusable_identity_matches(stored: &EmbeddedCodeChunk, current: &MaterializedChunk) -> bool {
    stored.reference.relative_path == current.reference.relative_path
        && stored.reference.key == current.reference.key
        && stored.language == current.language
}

fn cosine_similarity(left: &[f32], right: &[f32]) -> Result<f32, CodebaseVectorStoreError> {
    if left.len() != right.len() {
        return Err(CodebaseVectorStoreError::new(
            "query and stored embedding dimensions differ",
        ));
    }
    let dot = left
        .iter()
        .zip(right)
        .map(|(left, right)| left * right)
        .sum::<f32>();
    let left_norm = left.iter().map(|value| value * value).sum::<f32>().sqrt();
    let right_norm = right.iter().map(|value| value * value).sum::<f32>().sqrt();
    if left_norm == 0.0 || right_norm == 0.0 {
        Ok(0.0)
    } else {
        Ok(dot / (left_norm * right_norm))
    }
}
