use std::num::NonZeroUsize;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use crate::ChunkReference;
use crate::Codebase;
use crate::CodebaseEnhancement;
use crate::CodebaseEnhancementError;
use crate::CodebaseLimits;
use crate::CodebaseOverlayDocument;
use crate::CodebaseQuery;
use crate::CodebaseSemanticService;
use crate::CodebaseVectorStore;
use crate::EmbeddingIndexKey;
use crate::InMemoryCodebaseVectorStore;
use crate::IndexRootId;
use crate::IndexedLanguage;
use crate::SymbolIndex;
use crate::SymbolIndexLimits;
use ash_file_access::Dir;
use ash_model_provider::EmbeddingInvoker;
use ash_model_provider::EmbeddingRequest;
use ash_model_provider::EmbeddingResponse;
use ash_model_provider::EmbeddingVector;
use ash_model_provider::ModelProviderError;
use tempfile::TempDir;

use crate::CodebaseRetrievalBudget;
use crate::CodebaseRetrievalDegradation;
use crate::CodebaseRetrievalOrigin;
use crate::CodebaseRetrievalQuery;
use crate::CodebaseRetrievalService;

struct QueryEnhancement {
    root_id: IndexRootId,
    published: Vec<ChunkReference>,
    fail_query: AtomicBool,
    reverse_query_order: AtomicBool,
}

struct SemanticEmbedding;

impl EmbeddingInvoker for SemanticEmbedding {
    fn embed(&self, request: &EmbeddingRequest) -> Result<EmbeddingResponse, ModelProviderError> {
        EmbeddingResponse::new(
            request
                .inputs()
                .iter()
                .map(|input| {
                    if input.contains("semantic_target") || input.contains("meaning query") {
                        EmbeddingVector::new(vec![1.0, 0.0])
                    } else {
                        EmbeddingVector::new(vec![0.0, 1.0])
                    }
                })
                .collect::<Result<Vec<_>, _>>()?,
        )
    }
}

impl QueryEnhancement {
    fn new(index: &Codebase) -> Self {
        Self {
            root_id: index.root_id().clone(),
            published: index
                .manifest()
                .expect("manifest")
                .chunks
                .into_iter()
                .map(|chunk| chunk.reference)
                .collect(),
            fail_query: AtomicBool::new(false),
            reverse_query_order: AtomicBool::new(false),
        }
    }
}

impl CodebaseEnhancement for QueryEnhancement {
    fn root_id(&self) -> &IndexRootId {
        &self.root_id
    }

    fn query(
        &self,
        _text: &str,
        result_limit: NonZeroUsize,
    ) -> Result<Vec<ChunkReference>, CodebaseEnhancementError> {
        if self.fail_query.load(Ordering::Relaxed) {
            return Err(CodebaseEnhancementError::unavailable());
        }
        let mut references = self.published.clone();
        if self.reverse_query_order.load(Ordering::Relaxed) {
            references.reverse();
        }
        Ok(references.into_iter().take(result_limit.get()).collect())
    }
}

#[test]
fn local_retrieval_returns_verified_source_excerpt() {
    let dir = dir("pub fn local_recall_marker() {}\n");
    let index = index(&dir);
    index.rebuild().expect("rebuild");
    let service = CodebaseRetrievalService::local(index);

    let result = service
        .retrieve(&query("local_recall_marker"))
        .expect("retrieve");

    assert_eq!(result.hits.len(), 1);
    assert_eq!(
        result.hits[0].origins,
        [CodebaseRetrievalOrigin::LocalLexical]
    );
    assert!(result.hits[0].content.contains("local_recall_marker"));
    assert!(result.degradations.is_empty());
}

#[test]
fn hybrid_retrieval_fuses_and_deduplicates_the_same_excerpt() {
    let dir = dir("pub fn shared_recall_marker() {}\n");
    let index = index(&dir);
    index.rebuild().expect("rebuild");
    let enhancement = Arc::new(QueryEnhancement::new(&index));
    let service = CodebaseRetrievalService::enhanced(index, enhancement).expect("enhanced");

    let result = service
        .retrieve(&query("shared_recall_marker"))
        .expect("retrieve");

    assert_eq!(result.hits.len(), 1);
    assert_eq!(
        result.hits[0].origins,
        [
            CodebaseRetrievalOrigin::LocalLexical,
            CodebaseRetrievalOrigin::CloudSemantic,
        ]
    );
    assert!(result.degradations.is_empty());
}

#[test]
fn local_semantic_retrieval_adds_dense_candidates_without_cloud() {
    let dir = dir("pub fn semantic_target() {}\n");
    std::fs::write(dir.path().join("other.rs"), "pub fn unrelated_code() {}\n")
        .expect("other source");
    let index = index(&dir);
    index.rebuild().expect("rebuild");
    let semantic = semantic_service(Arc::clone(&index));
    semantic.sync().expect("semantic sync");
    let service =
        CodebaseRetrievalService::local_semantic(index, semantic).expect("local semantic");

    let result = service.retrieve(&query("meaning query")).expect("retrieve");

    assert_eq!(result.hits.len(), 2);
    assert_eq!(
        result.hits[0].reference.relative_path,
        std::path::Path::new("lib.rs")
    );
    assert_eq!(
        result.hits[0].origins,
        [CodebaseRetrievalOrigin::LocalSemantic]
    );
    assert!(result.degradations.is_empty());
}

#[test]
fn hybrid_retrieval_preserves_cloud_provider_ranking() {
    let dir = dir("pub fn first_cloud_candidate() {}\n");
    std::fs::write(
        dir.path().join("second.rs"),
        "pub fn second_cloud_candidate() {}\n",
    )
    .expect("second source");
    let index = index(&dir);
    index.rebuild().expect("rebuild");
    let enhancement = Arc::new(QueryEnhancement::new(&index));
    enhancement
        .reverse_query_order
        .store(true, Ordering::Relaxed);
    let mut expected_paths = enhancement
        .published
        .iter()
        .map(|reference| reference.relative_path.clone())
        .collect::<Vec<_>>();
    expected_paths.reverse();
    let service = CodebaseRetrievalService::enhanced(index, enhancement).expect("enhanced");

    let result = service
        .retrieve(&query("cloud_only_query_without_lexical_hits"))
        .expect("retrieve");
    let actual_paths = result
        .hits
        .iter()
        .map(|hit| hit.reference.relative_path.clone())
        .collect::<Vec<_>>();

    assert_eq!(actual_paths, expected_paths);
    assert!(
        result
            .hits
            .iter()
            .all(|hit| hit.origins == [CodebaseRetrievalOrigin::CloudSemantic])
    );
}

#[test]
fn cloud_query_failure_falls_back_to_local_results() {
    let dir = dir("pub fn fallback_marker() {}\n");
    let index = index(&dir);
    index.rebuild().expect("rebuild");
    let enhancement = Arc::new(QueryEnhancement::new(&index));
    enhancement.fail_query.store(true, Ordering::Relaxed);
    let service = CodebaseRetrievalService::enhanced(index, enhancement).expect("enhanced");

    let result = service
        .retrieve(&query("fallback_marker"))
        .expect("retrieve");

    assert_eq!(result.hits.len(), 1);
    assert_eq!(
        result.degradations,
        [CodebaseRetrievalDegradation::CloudQueryFailed]
    );
}

#[test]
fn verification_and_content_budgets_discard_unusable_candidates() {
    let dir = dir("pub fn budget_marker() {}\n");
    let index = index(&dir);
    index.rebuild().expect("rebuild");
    let service = CodebaseRetrievalService::local(Arc::clone(&index)).with_budget(
        CodebaseRetrievalBudget::default()
            .with_max_item_bytes(NonZeroUsize::new(1).expect("item budget")),
    );
    let budgeted = service
        .retrieve(&query("budget_marker"))
        .expect("budgeted retrieve");
    assert!(budgeted.hits.is_empty());
    assert_eq!(
        budgeted.degradations,
        [CodebaseRetrievalDegradation::ContentBudgetExceeded { discarded: 1 }]
    );

    std::fs::write(dir.path().join("lib.rs"), "pub fn changed() {}\n").expect("mutate source");
    let stale = CodebaseRetrievalService::local(index)
        .retrieve(&query("budget_marker"))
        .expect("stale retrieve");
    assert!(stale.hits.is_empty());
    assert_eq!(
        stale.degradations,
        [CodebaseRetrievalDegradation::CandidateVerificationFailed { discarded: 1 }]
    );
}

#[test]
fn dirty_overlay_suppresses_old_disk_content_and_materializes_current_text() {
    let dir = dir("pub fn persisted_secret() {}\n");
    let index = index(&dir);
    index.rebuild().expect("rebuild");
    index
        .synchronize_overlay(CodebaseOverlayDocument {
            relative_path: "lib.rs".into(),
            editor_revision: 2,
            language: IndexedLanguage::Rust,
            content: "pub fn unsaved_current() {}\n".into(),
        })
        .expect("overlay");
    let service = CodebaseRetrievalService::local(index);

    assert!(
        service
            .retrieve(&query("persisted_secret"))
            .expect("old query")
            .hits
            .is_empty()
    );
    let current = service
        .retrieve(&query("unsaved_current"))
        .expect("current query");
    assert_eq!(current.hits.len(), 1);
    assert!(current.hits[0].content.contains("unsaved_current"));
}

#[test]
fn symbol_retrieval_returns_the_exact_declaration_with_provenance() {
    let dir = dir(
        "const PREFIX: &str = \"outside\";\n\npub fn precise_symbol() {\n    let local = 1;\n}\n",
    );
    let index = index(&dir);
    index.rebuild().expect("rebuild");
    let symbols = Arc::new(
        SymbolIndex::open_memory(Arc::clone(&index), SymbolIndexLimits::default())
            .expect("symbol index"),
    );
    symbols.reconcile().expect("symbol reconcile");
    let service = CodebaseRetrievalService::local(index)
        .with_symbol_index(symbols)
        .expect("matching symbol root");

    let result = service
        .retrieve(&query("precise_symbol"))
        .expect("retrieve");
    let hit = result
        .hits
        .iter()
        .find(|hit| hit.origins.contains(&CodebaseRetrievalOrigin::LocalSymbol))
        .expect("symbol hit");

    assert!(hit.content.starts_with("pub fn precise_symbol"));
    assert!(!hit.content.contains("PREFIX"));
    assert_eq!(hit.reference.span.start_line, 2);
    assert!(result.degradations.is_empty());
}

fn dir(content: &str) -> TempDir {
    let dir = tempfile::tempdir().expect("dir");
    std::fs::create_dir(dir.path().join(".git")).expect("git marker");
    std::fs::write(dir.path().join("lib.rs"), content).expect("source");
    dir
}

fn index(dir: &TempDir) -> Arc<Codebase> {
    Arc::new(
        Codebase::open_memory(
            Dir::open_local(dir.path()).expect("root"),
            CodebaseLimits::default(),
        )
        .expect("index"),
    )
}

fn semantic_service(index: Arc<Codebase>) -> Arc<CodebaseSemanticService> {
    let embedding: Arc<dyn EmbeddingInvoker> = Arc::new(SemanticEmbedding);
    let store: Arc<dyn CodebaseVectorStore> = Arc::new(InMemoryCodebaseVectorStore::default());
    Arc::new(CodebaseSemanticService::new(
        index,
        EmbeddingIndexKey::new("semantic-test-v1").expect("model id"),
        embedding,
        store,
    ))
}

fn query(text: &str) -> CodebaseRetrievalQuery {
    CodebaseRetrievalQuery::new(text, NonZeroUsize::new(10).expect("result limit")).expect("query")
}

#[test]
fn grep_candidates_use_owned_current_chunks_and_reject_backend_content() {
    struct Candidates(std::sync::atomic::AtomicUsize);
    impl grep::Search for Candidates {
        fn search(
            &self,
            _: &ash_file_access::Dir,
            query: &grep::Query,
            _: &ash_async_utils::CancellationToken,
        ) -> Result<grep::SearchResult, grep::Error> {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            assert_eq!(query.pattern, grep::Pattern::Literal);
            Ok(grep::SearchResult {
                matches: vec![grep::Match {
                    path: "source.rs".into(),
                    line_number: 1,
                    content: "untrusted backend text".into(),
                    ranges: Vec::new(),
                }],
                limit_hit: false,
                freshness: grep::Freshness::Indexed,
            })
        }
    }
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("source.rs"), "fn prefixneedlepost() {}\n").unwrap();
    let search = std::sync::Arc::new(Candidates(std::sync::atomic::AtomicUsize::new(0)));
    let index = Codebase::open_memory(
        ash_file_access::Dir::open_local(dir.path()).unwrap(),
        CodebaseLimits::default(),
    )
    .unwrap();
    let index = std::sync::Arc::new(index);
    let retrieval = CodebaseRetrievalService::local(index.clone()).with_grep(search.clone());
    let cancellation = ash_async_utils::CancellationSource::new();
    index.rebuild().unwrap();
    let hits = retrieval
        .search(&CodebaseQuery::new("needle"), &cancellation.token())
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].content, "fn prefixneedlepost() {}\n");
    assert_eq!(search.0.load(std::sync::atomic::Ordering::SeqCst), 1);
    index
        .synchronize_overlay(CodebaseOverlayDocument {
            relative_path: "source.rs".into(),
            editor_revision: 1,
            language: crate::IndexedLanguage::Rust,
            content: "fn unsaved_only() {}\n".into(),
        })
        .unwrap();
    assert!(
        retrieval
            .search(&CodebaseQuery::new("needle"), &cancellation.token())
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        retrieval
            .search(&CodebaseQuery::new("unsaved_only"), &cancellation.token())
            .unwrap()
            .len(),
        1
    );
    index
        .close_overlay(std::path::Path::new("source.rs"))
        .unwrap();
    std::fs::write(dir.path().join("source.rs"), "fn replaced() {}\n").unwrap();
    index.rebuild().unwrap();
    assert!(
        retrieval
            .search(&CodebaseQuery::new("needle"), &cancellation.token())
            .unwrap()
            .is_empty()
    );
}
