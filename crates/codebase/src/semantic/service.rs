use std::num::NonZeroUsize;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

use crate::Codebase;
use crate::MaterializedChunk;
use ash_async_utils::CancellationSource;
use ash_async_utils::CancellationToken;
use ash_model_provider::EmbeddingInvoker;
use ash_model_provider::EmbeddingRequest;
use ash_model_provider::RerankInvoker;
use ash_model_provider::RerankRequest;

use crate::CodebaseSemanticError;
use crate::CodebaseSemanticMetric;
use crate::CodebaseSemanticMetricsSink;
use crate::CodebaseSemanticProgressSink;
use crate::CodebaseSemanticQuery;
use crate::CodebaseSemanticQueryResult;
use crate::CodebaseSemanticSyncPhase;
use crate::CodebaseSemanticSyncProgress;
use crate::CodebaseSemanticSyncResult;
use crate::CodebaseVectorStore;
use crate::EmbeddedCodeChunk;
use crate::EmbeddingIndexKey;

const EMBEDDING_BATCH_SIZE: usize = 128;
const VECTOR_RECALL_MULTIPLIER: usize = 4;
const MAX_VECTOR_RECALL: usize = 400;

/// Owns semantic indexing, vector recall, optional rerank, and final candidate ordering.
pub struct CodebaseSemanticService {
    index: Arc<Codebase>,
    embedding_index_key: EmbeddingIndexKey,
    embedding: Arc<dyn EmbeddingInvoker>,
    rerank: Option<Arc<dyn RerankInvoker>>,
    store: Arc<dyn CodebaseVectorStore>,
    _storage_lease: Option<Arc<dyn Send + Sync>>,
    sync_operation: Mutex<()>,
    metrics: Option<Arc<dyn CodebaseSemanticMetricsSink>>,
}

impl CodebaseSemanticService {
    pub fn new(
        index: Arc<Codebase>,
        embedding_index_key: EmbeddingIndexKey,
        embedding: Arc<dyn EmbeddingInvoker>,
        store: Arc<dyn CodebaseVectorStore>,
    ) -> Self {
        Self {
            index,
            embedding_index_key,
            embedding,
            rerank: None,
            store,
            _storage_lease: None,
            sync_operation: Mutex::new(()),
            metrics: None,
        }
    }

    /// Adds a rerank model while keeping embedding-only construction unambiguous.
    pub fn with_rerank(mut self, rerank: Arc<dyn RerankInvoker>) -> Self {
        self.rerank = Some(rerank);
        self
    }

    /// Installs a privacy-safe metrics sink without changing indexing behavior.
    pub fn with_metrics(mut self, metrics: Arc<dyn CodebaseSemanticMetricsSink>) -> Self {
        self.metrics = Some(metrics);
        self
    }

    /// Keeps the external storage lifecycle lock alive for as long as this service can access it.
    pub fn with_storage_lease(mut self, lease: Arc<dyn Send + Sync>) -> Self {
        self._storage_lease = Some(lease);
        self
    }

    /// Returns the Directory identity bound to this semantic projection.
    pub fn root_id(&self) -> &crate::IndexRootId {
        self.index.root_id()
    }

    /// Returns the authoritative lexical generation this projection should eventually match.
    pub fn lexical_generation(&self) -> Result<u64, CodebaseSemanticError> {
        Ok(self.index.snapshot()?.generation)
    }

    /// Returns the generation currently published by the searchable semantic projection.
    pub fn published_generation(&self) -> Result<Option<u64>, CodebaseSemanticError> {
        self.store
            .published_generation(self.index.root_id(), &self.embedding_index_key)
            .map_err(Into::into)
    }

    /// Synchronizes the rebuildable semantic projection to the exact current lexical generation.
    pub fn sync(&self) -> Result<CodebaseSemanticSyncResult, CodebaseSemanticError> {
        self.sync_with_control(&CancellationSource::new().token(), None)
    }

    /// Synchronizes with cooperative cancellation and content-free progress reporting.
    pub fn sync_with_control(
        &self,
        cancellation: &CancellationToken,
        progress: Option<&dyn CodebaseSemanticProgressSink>,
    ) -> Result<CodebaseSemanticSyncResult, CodebaseSemanticError> {
        let started = Instant::now();
        let tracking = TrackingProgressSink {
            downstream: progress,
            processed_chunk_count: AtomicUsize::new(0),
        };
        let result = self.sync_inner(cancellation, Some(&tracking));
        if let Some(metrics) = &self.metrics {
            match &result {
                Ok(result) => metrics.record(CodebaseSemanticMetric::SyncCompleted {
                    chunk_count: result.indexed_chunk_count,
                    reused_count: result.reused_embedding_count,
                    embedded_count: result
                        .indexed_chunk_count
                        .saturating_sub(result.reused_embedding_count),
                    retry_count: result.retry_count,
                    elapsed_millis: elapsed_millis(started),
                }),
                Err(CodebaseSemanticError::Cancelled) => {
                    metrics.record(CodebaseSemanticMetric::SyncCancelled {
                        processed_count: tracking.processed_chunk_count.load(Ordering::Relaxed),
                    })
                }
                Err(_) => metrics.record(CodebaseSemanticMetric::SyncFailed),
            }
        }
        result
    }

    fn sync_inner(
        &self,
        cancellation: &CancellationToken,
        progress: Option<&dyn CodebaseSemanticProgressSink>,
    ) -> Result<CodebaseSemanticSyncResult, CodebaseSemanticError> {
        let _operation = self
            .sync_operation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        check_cancelled(cancellation)?;
        let manifest = self.index.manifest()?;
        if manifest.snapshot.generation == 0 {
            return Err(CodebaseSemanticError::IndexNotReady);
        }
        let chunks = self.index.materialize_chunks(&manifest.chunks)?;
        report(
            progress,
            CodebaseSemanticSyncProgress {
                phase: CodebaseSemanticSyncPhase::Preparing,
                generation: manifest.snapshot.generation,
                total_chunk_count: chunks.len(),
                processed_chunk_count: 0,
                reused_embedding_count: 0,
                embedded_chunk_count: 0,
                completed_batch_count: 0,
                total_batch_count: 0,
                retry_count: 0,
            },
        );
        let mut embeddings = self.store.reusable_embeddings(
            self.index.root_id(),
            &self.embedding_index_key,
            &chunks,
        )?;
        if embeddings.len() != chunks.len() {
            return Err(crate::CodebaseVectorStoreError::new(
                "vector store reuse count does not match the synchronized chunk count",
            )
            .into());
        }
        let missing = embeddings
            .iter()
            .enumerate()
            .filter_map(|(index, embedding)| embedding.is_none().then_some(index))
            .collect::<Vec<_>>();
        let reused_embedding_count = chunks.len().saturating_sub(missing.len());
        let total_batch_count = missing.len().div_ceil(EMBEDDING_BATCH_SIZE);
        let mut completed_batch_count = 0usize;
        let mut embedded_chunk_count = 0usize;
        let mut retry_count = 0usize;
        let mut current = CodebaseSemanticSyncProgress {
            phase: CodebaseSemanticSyncPhase::Embedding,
            generation: manifest.snapshot.generation,
            total_chunk_count: chunks.len(),
            processed_chunk_count: reused_embedding_count,
            reused_embedding_count,
            embedded_chunk_count,
            completed_batch_count,
            total_batch_count,
            retry_count,
        };
        report(progress, current.clone());
        for batch in missing.chunks(EMBEDDING_BATCH_SIZE) {
            check_cancelled(cancellation)?;
            let inputs = batch
                .iter()
                .map(|index| code_document(&chunks[*index]))
                .collect::<Vec<_>>();
            let response = invoke_with_retry(cancellation, 3, &mut retry_count, || {
                self.embedding
                    .embed_with_cancellation(&EmbeddingRequest::new(inputs.clone())?, cancellation)
            })?;
            if response.vectors().len() != batch.len() {
                return Err(CodebaseSemanticError::InvalidModelResponse(
                    "embedding count does not match the synchronized chunk count",
                ));
            }
            let mut cached = Vec::with_capacity(batch.len());
            for (index, embedding) in batch.iter().copied().zip(response.into_vectors()) {
                cached.push(EmbeddedCodeChunk {
                    reference: chunks[index].reference.clone(),
                    language: chunks[index].language,
                    content: chunks[index].content.clone(),
                    embedding: embedding.clone(),
                });
                embeddings[index] = Some(embedding);
            }
            self.store.cache_embeddings(
                self.index.root_id(),
                &self.embedding_index_key,
                &cached,
            )?;
            completed_batch_count = completed_batch_count.saturating_add(1);
            embedded_chunk_count = embedded_chunk_count.saturating_add(batch.len());
            current.processed_chunk_count = reused_embedding_count + embedded_chunk_count;
            current.embedded_chunk_count = embedded_chunk_count;
            current.completed_batch_count = completed_batch_count;
            current.retry_count = retry_count;
            report(progress, current.clone());
        }
        check_cancelled(cancellation)?;
        let mut embedded = Vec::with_capacity(chunks.len());
        for (chunk, embedding) in chunks.iter().cloned().zip(embeddings) {
            embedded.push(EmbeddedCodeChunk {
                reference: chunk.reference,
                language: chunk.language,
                content: chunk.content,
                embedding: embedding.expect("missing embeddings were populated"),
            });
        }
        current.phase = CodebaseSemanticSyncPhase::Publishing;
        report(progress, current.clone());
        self.store.replace_generation(
            self.index.root_id(),
            manifest.snapshot.generation,
            &self.embedding_index_key,
            embedded,
        )?;
        current.phase = CodebaseSemanticSyncPhase::Complete;
        report(progress, current);
        Ok(CodebaseSemanticSyncResult {
            generation: manifest.snapshot.generation,
            indexed_chunk_count: chunks.len(),
            reused_embedding_count,
            retry_count,
        })
    }

    pub fn query(
        &self,
        query: &CodebaseSemanticQuery,
    ) -> Result<CodebaseSemanticQueryResult, CodebaseSemanticError> {
        self.query_with_cancellation(query, &CancellationSource::new().token())
    }

    pub fn query_with_cancellation(
        &self,
        query: &CodebaseSemanticQuery,
        cancellation: &CancellationToken,
    ) -> Result<CodebaseSemanticQueryResult, CodebaseSemanticError> {
        let started = Instant::now();
        let mut retry_count = 0usize;
        let result = self.query_inner(query, cancellation, &mut retry_count);
        if let Some(metrics) = &self.metrics {
            match &result {
                Ok(result) => metrics.record(CodebaseSemanticMetric::QueryCompleted {
                    candidate_count: result.candidates.len(),
                    retry_count,
                    elapsed_millis: elapsed_millis(started),
                }),
                Err(_) => metrics.record(CodebaseSemanticMetric::QueryDegraded),
            }
        }
        result
    }

    fn query_inner(
        &self,
        query: &CodebaseSemanticQuery,
        cancellation: &CancellationToken,
        retry_count: &mut usize,
    ) -> Result<CodebaseSemanticQueryResult, CodebaseSemanticError> {
        check_cancelled(cancellation)?;
        let snapshot = self.index.snapshot()?;
        if snapshot.generation == 0 {
            return Err(CodebaseSemanticError::IndexNotReady);
        }
        let request = EmbeddingRequest::new(vec![query.text().to_owned()])?;
        let response = invoke_with_retry(cancellation, 1, retry_count, || {
            self.embedding
                .embed_with_cancellation(&request, cancellation)
        })?;
        let mut vectors = response.into_vectors();
        if vectors.len() != 1 {
            return Err(CodebaseSemanticError::InvalidModelResponse(
                "query embedding response must contain exactly one vector",
            ));
        }
        let recall_limit = query
            .result_limit()
            .get()
            .saturating_mul(VECTOR_RECALL_MULTIPLIER)
            .min(MAX_VECTOR_RECALL);
        let recall_limit = NonZeroUsize::new(recall_limit).expect("query result limit is non-zero");
        let mut candidates = self.store.search(
            self.index.root_id(),
            snapshot.generation,
            &self.embedding_index_key,
            &vectors.remove(0),
            recall_limit,
        )?;
        if let Some(rerank) = &self.rerank
            && !candidates.is_empty()
        {
            let documents = candidates
                .iter()
                .map(|candidate| {
                    code_document_from_parts(
                        &candidate.chunk.reference.relative_path,
                        candidate.chunk.language,
                        &candidate.chunk.content,
                    )
                })
                .collect();
            let request = RerankRequest::new(query.text(), documents)?;
            let response = invoke_with_retry(cancellation, 1, retry_count, || {
                rerank.rerank_with_cancellation(&request, cancellation)
            })?;
            if response.scores().len() != candidates.len() {
                return Err(CodebaseSemanticError::InvalidModelResponse(
                    "rerank score count does not match the recalled candidate count",
                ));
            }
            let mut reranked = candidates
                .into_iter()
                .zip(response.scores().iter().copied())
                .enumerate()
                .collect::<Vec<_>>();
            reranked.sort_by(|left, right| {
                right
                    .1
                    .1
                    .total_cmp(&left.1.1)
                    .then_with(|| left.0.cmp(&right.0))
                    .then_with(|| left.1.0.chunk.reference.cmp(&right.1.0.chunk.reference))
            });
            candidates = reranked
                .into_iter()
                .map(|(_, (candidate, _))| candidate)
                .collect();
        }
        candidates.truncate(query.result_limit().get());
        Ok(CodebaseSemanticQueryResult {
            generation: snapshot.generation,
            candidates: candidates
                .into_iter()
                .map(|candidate| candidate.chunk.reference)
                .collect(),
        })
    }

    pub fn delete_index(&self) -> Result<(), CodebaseSemanticError> {
        self.store.delete_index(self.index.root_id())?;
        Ok(())
    }
}

struct TrackingProgressSink<'a> {
    downstream: Option<&'a dyn CodebaseSemanticProgressSink>,
    processed_chunk_count: AtomicUsize,
}

impl CodebaseSemanticProgressSink for TrackingProgressSink<'_> {
    fn report(&self, progress: &CodebaseSemanticSyncProgress) {
        self.processed_chunk_count
            .store(progress.processed_chunk_count, Ordering::Relaxed);
        if let Some(downstream) = self.downstream {
            downstream.report(progress);
        }
    }
}

fn report(sink: Option<&dyn CodebaseSemanticProgressSink>, progress: CodebaseSemanticSyncProgress) {
    if let Some(sink) = sink {
        sink.report(&progress);
    }
}

fn check_cancelled(cancellation: &CancellationToken) -> Result<(), CodebaseSemanticError> {
    cancellation
        .check()
        .map_err(|_| CodebaseSemanticError::Cancelled)
}

fn invoke_with_retry<T>(
    cancellation: &CancellationToken,
    maximum_retries: usize,
    retry_count: &mut usize,
    mut invoke: impl FnMut() -> Result<T, ash_model_provider::ModelProviderError>,
) -> Result<T, CodebaseSemanticError> {
    let mut attempt = 0usize;
    loop {
        check_cancelled(cancellation)?;
        match invoke() {
            Ok(value) => return Ok(value),
            Err(ash_model_provider::ModelProviderError::Cancelled(_)) => {
                return Err(CodebaseSemanticError::Cancelled);
            }
            Err(error) if error.is_transient() && attempt < maximum_retries => {
                attempt += 1;
                *retry_count = retry_count.saturating_add(1);
                let deadline = error.retry_after_deadline().unwrap_or_else(|| {
                    Instant::now() + Duration::from_millis(50u64.saturating_mul(1 << (attempt - 1)))
                });
                let deadline = deadline.min(Instant::now() + Duration::from_secs(60));
                loop {
                    check_cancelled(cancellation)?;
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        break;
                    }
                    std::thread::sleep(remaining.min(Duration::from_millis(10)));
                }
            }
            Err(error) => return Err(error.into()),
        }
    }
}

fn elapsed_millis(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

fn code_document(chunk: &MaterializedChunk) -> String {
    code_document_from_parts(
        &chunk.reference.relative_path,
        chunk.language,
        &chunk.content,
    )
}

fn code_document_from_parts(
    path: &std::path::Path,
    language: crate::IndexedLanguage,
    content: &str,
) -> String {
    format!(
        "path: {}\nlanguage: {language:?}\n\n{content}",
        path.display()
    )
}
