use std::num::NonZeroUsize;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use crate::Codebase;
use crate::CodebaseLimits;
use ash_file_access::Dir;
use ash_model_provider::EmbeddingInvoker;
use ash_model_provider::EmbeddingRequest;
use ash_model_provider::EmbeddingResponse;
use ash_model_provider::EmbeddingVector;
use ash_model_provider::ModelProviderError;
use ash_model_provider::RerankInvoker;
use ash_model_provider::RerankRequest;
use ash_model_provider::RerankResponse;
use tempfile::TempDir;

use super::*;

struct KeywordEmbedding;

impl EmbeddingInvoker for KeywordEmbedding {
    fn embed(&self, request: &EmbeddingRequest) -> Result<EmbeddingResponse, ModelProviderError> {
        EmbeddingResponse::new(
            request
                .inputs()
                .iter()
                .map(|input| {
                    if input.contains("alpha") {
                        EmbeddingVector::new(vec![1.0, 0.0])
                    } else {
                        EmbeddingVector::new(vec![0.0, 1.0])
                    }
                })
                .collect::<Result<Vec<_>, _>>()?,
        )
    }
}

struct PreferAlphaRerank;

impl RerankInvoker for PreferAlphaRerank {
    fn rerank(&self, request: &RerankRequest) -> Result<RerankResponse, ModelProviderError> {
        RerankResponse::new(
            request
                .documents()
                .iter()
                .map(|document| if document.contains("alpha") { 1.0 } else { 0.0 })
                .collect(),
        )
    }
}

struct WrongCardinalityEmbedding;

impl EmbeddingInvoker for WrongCardinalityEmbedding {
    fn embed(&self, _request: &EmbeddingRequest) -> Result<EmbeddingResponse, ModelProviderError> {
        EmbeddingResponse::new(vec![EmbeddingVector::new(vec![1.0, 0.0])?])
    }
}

struct CancellingBatchEmbedding {
    calls: AtomicUsize,
    cancellation: Mutex<Option<ash_async_utils::CancellationSource>>,
}

struct TransientOnceEmbedding {
    calls: AtomicUsize,
}

#[derive(Default)]
struct RecordingMetrics {
    metrics: Mutex<Vec<CodebaseSemanticMetric>>,
}

impl CodebaseSemanticMetricsSink for RecordingMetrics {
    fn record(&self, metric: CodebaseSemanticMetric) {
        self.metrics.lock().unwrap().push(metric);
    }
}

impl EmbeddingInvoker for TransientOnceEmbedding {
    fn embed(&self, request: &EmbeddingRequest) -> Result<EmbeddingResponse, ModelProviderError> {
        if self.calls.fetch_add(1, Ordering::Relaxed) == 0 {
            return Err(ModelProviderError::Api(ash_api::ApiError::Transport(
                "temporary".into(),
            )));
        }
        KeywordEmbedding.embed(request)
    }
}

impl EmbeddingInvoker for CancellingBatchEmbedding {
    fn embed(&self, request: &EmbeddingRequest) -> Result<EmbeddingResponse, ModelProviderError> {
        let call = self.calls.fetch_add(1, Ordering::Relaxed);
        if call == 0
            && let Some(cancellation) = self.cancellation.lock().unwrap().as_ref()
        {
            cancellation.cancel();
        }
        EmbeddingResponse::new(
            request
                .inputs()
                .iter()
                .map(|_| EmbeddingVector::new(vec![1.0, 0.0]))
                .collect::<Result<Vec<_>, _>>()?,
        )
    }
}

#[test]
fn local_vector_recall_returns_current_dir_chunk_references() {
    let dir = dir();
    let index = index(&dir);
    let service = service(Arc::clone(&index), None, memory_store());
    let synced = service.sync().expect("sync");

    let result = service.query(&query("find beta")).expect("semantic query");

    assert_eq!(
        synced.generation,
        index.snapshot().expect("snapshot").generation
    );
    assert_eq!(result.generation, synced.generation);
    assert_eq!(result.candidates.len(), 2);
    assert_eq!(
        result.candidates[0].relative_path,
        std::path::Path::new("beta.rs")
    );
}

#[test]
fn local_semantic_service_interprets_rerank_scores_and_owns_final_order() {
    let dir = dir();
    let index = index(&dir);
    let rerank: Arc<dyn RerankInvoker> = Arc::new(PreferAlphaRerank);
    let service = service(index, Some(rerank), memory_store());
    service.sync().expect("sync");

    let result = service.query(&query("find beta")).expect("semantic query");

    assert_eq!(
        result.candidates[0].relative_path,
        std::path::Path::new("alpha.rs")
    );
}

#[test]
fn stale_semantic_generation_is_rejected_after_lexical_refresh() {
    let dir = dir();
    let index = index(&dir);
    let service = service(Arc::clone(&index), None, memory_store());
    service.sync().expect("sync");
    std::fs::write(
        dir.path().join("beta.rs"),
        "pub fn changed_beta_feature() {}\n",
    )
    .expect("change source");
    index.rebuild().expect("rebuild");

    assert!(matches!(
        service.query(&query("find beta")),
        Err(CodebaseSemanticError::VectorStore(_))
    ));
}

#[test]
fn sync_rejects_model_output_that_does_not_match_dir_chunks() {
    let dir = dir();
    let index = index(&dir);
    let embedding: Arc<dyn EmbeddingInvoker> = Arc::new(WrongCardinalityEmbedding);
    let service = CodebaseSemanticService::new(index, model_id(), embedding, memory_store());

    assert!(matches!(
        service.sync(),
        Err(CodebaseSemanticError::InvalidModelResponse(
            "embedding count does not match the synchronized chunk count"
        ))
    ));
}

#[test]
fn cancelled_sync_reuses_completed_batches_on_retry() {
    let dir = tempfile::tempdir().expect("dir");
    std::fs::create_dir(dir.path().join(".git")).expect("git marker");
    for index in 0..140 {
        std::fs::write(
            dir.path().join(format!("file-{index}.rs")),
            format!("pub fn item_{index}() {{}}\n"),
        )
        .expect("source");
    }
    let index = index(&dir);
    let source = ash_async_utils::CancellationSource::new();
    let embedding = Arc::new(CancellingBatchEmbedding {
        calls: AtomicUsize::new(0),
        cancellation: Mutex::new(Some(source.clone())),
    });
    let store: Arc<dyn CodebaseVectorStore> = Arc::new(InMemoryCodebaseVectorStore::default());
    let service = CodebaseSemanticService::new(index, model_id(), embedding.clone(), store);

    assert!(matches!(
        service.sync_with_control(&source.token(), None),
        Err(CodebaseSemanticError::Cancelled)
    ));
    *embedding.cancellation.lock().unwrap() = None;
    let retried = service.sync().expect("retry");

    assert_eq!(retried.indexed_chunk_count, 140);
    assert_eq!(retried.reused_embedding_count, 128);
    assert_eq!(embedding.calls.load(Ordering::Relaxed), 2);
}

#[test]
fn transient_embedding_failure_is_retried_and_reported() {
    let dir = dir();
    let index = index(&dir);
    let embedding = Arc::new(TransientOnceEmbedding {
        calls: AtomicUsize::new(0),
    });
    let metrics = Arc::new(RecordingMetrics::default());
    let service =
        CodebaseSemanticService::new(index, model_id(), embedding.clone(), memory_store())
            .with_metrics(metrics.clone());

    let synced = service.sync().expect("retry succeeds");

    assert_eq!(synced.retry_count, 1);
    assert_eq!(embedding.calls.load(Ordering::Relaxed), 2);
    assert!(matches!(
        metrics.metrics.lock().unwrap().as_slice(),
        [CodebaseSemanticMetric::SyncCompleted { retry_count: 1, .. }]
    ));
}

fn service(
    index: Arc<Codebase>,
    rerank: Option<Arc<dyn RerankInvoker>>,
    store: Arc<dyn CodebaseVectorStore>,
) -> CodebaseSemanticService {
    let embedding: Arc<dyn EmbeddingInvoker> = Arc::new(KeywordEmbedding);
    let service = CodebaseSemanticService::new(index, model_id(), embedding, store);
    match rerank {
        Some(rerank) => service.with_rerank(rerank),
        None => service,
    }
}

fn memory_store() -> Arc<dyn CodebaseVectorStore> {
    Arc::new(InMemoryCodebaseVectorStore::default())
}

fn model_id() -> EmbeddingIndexKey {
    EmbeddingIndexKey::new("keyword-embedding-v1").expect("model id")
}

fn query(text: &str) -> CodebaseSemanticQuery {
    CodebaseSemanticQuery::new(text, NonZeroUsize::new(10).expect("limit")).expect("query")
}

fn index(dir: &TempDir) -> Arc<Codebase> {
    let index = Arc::new(
        Codebase::open_memory(
            Dir::open_local(dir.path()).expect("root"),
            CodebaseLimits::default(),
        )
        .expect("index"),
    );
    index.rebuild().expect("rebuild");
    index
}

fn dir() -> TempDir {
    let dir = tempfile::tempdir().expect("dir");
    std::fs::create_dir(dir.path().join(".git")).expect("git marker");
    std::fs::write(dir.path().join("alpha.rs"), "pub fn alpha_feature() {}\n")
        .expect("alpha source");
    std::fs::write(dir.path().join("beta.rs"), "pub fn beta_feature() {}\n").expect("beta source");
    dir
}
