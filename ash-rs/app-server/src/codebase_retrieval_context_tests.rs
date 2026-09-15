use std::sync::Arc;

use ash_async_utils::CancellationSource;
use ash_codebase::Codebase;
use ash_codebase::CodebaseLimits;
use ash_codebase::CodebaseSemanticService;
use ash_codebase::EmbeddingIndexKey;
use ash_codebase::InMemoryCodebaseVectorStore;
use ash_config::CodebaseAutomaticContext;
use ash_config::CodebaseModelSelection;
use ash_config::ConfigCommandRequest;
use ash_config::ConfigRevision;
use ash_config::ConfigStore;
use ash_config::UserConfigCommand;
use ash_core::ContextSource;
use ash_core::ContextSourceRequest;
use ash_file_access::Dir;
use ash_model_provider::EmbeddingInvoker;
use ash_model_provider::EmbeddingRequest;
use ash_model_provider::EmbeddingResponse;
use ash_model_provider::EmbeddingVector;
use ash_model_provider::ModelProviderError;
use ash_model_provider_config::ModelProviderConfig;
use ash_protocol::CommandId;
use ash_protocol::ModelId;
use ash_protocol::ModelRef;
use ash_protocol::ProviderId;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use tempfile::TempDir;

use super::CodebaseRetrievalContextSource;

struct ConstantEmbedding;

impl EmbeddingInvoker for ConstantEmbedding {
    fn embed(&self, request: &EmbeddingRequest) -> Result<EmbeddingResponse, ModelProviderError> {
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
fn automatic_context_requires_explicit_opt_in() {
    let dir = dir();
    let root = Dir::open_local(dir.path()).expect("directory root");
    let index = Arc::new(Codebase::open_memory(root, CodebaseLimits::default()).expect("Codebase"));
    index.rebuild().expect("lexical index");
    let semantic = Arc::new(CodebaseSemanticService::new(
        Arc::clone(&index),
        EmbeddingIndexKey::new("test-embedding").expect("model id"),
        Arc::new(ConstantEmbedding),
        Arc::new(InMemoryCodebaseVectorStore::default()),
    ));
    semantic.sync().expect("semantic projection");
    let profile = tempfile::tempdir().expect("profile");
    let config =
        Arc::new(ConfigStore::open(profile.path().join("config.sqlite3")).expect("config"));
    let source = CodebaseRetrievalContextSource::new(
        ash_codebase::CodebaseRetrievalService::local(Arc::clone(&index)),
        None,
        Some(semantic),
        None,
        Some(Arc::clone(&config)),
    );
    let session_id = SessionId::new("session-1").expect("session id");
    let thread_id = ThreadId::new("thread-1").expect("thread id");
    let turn_id = TurnId::new("turn-1").expect("turn id");
    let request = ContextSourceRequest {
        session_id: &session_id,
        thread_id: &thread_id,
        turn_id: &turn_id,
        query: "find the target feature",
    };
    let cancellation = CancellationSource::new();

    assert!(
        source
            .collect(&request, &cancellation.token())
            .expect("default context")
            .is_empty()
    );

    let provider = ProviderId::new("openai-compatible").expect("provider");
    let configured_provider = config
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("configure-provider").expect("command id"),
            expected_revision: ConfigRevision::INITIAL,
            command: UserConfigCommand::ConfigureProvider {
                provider: provider.clone(),
                config: ModelProviderConfig::new(provider.clone()),
            },
        })
        .expect("configure provider");
    config
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("configure-semantic").expect("command id"),
            expected_revision: configured_provider.revision,
            command: UserConfigCommand::ConfigureCodebase {
                models: Some(CodebaseModelSelection {
                    embedding_model: ModelRef::new(
                        provider,
                        ModelId::new("embedding-v1").expect("model id"),
                    ),
                    rerank_model: None,
                }),
                automatic_context: CodebaseAutomaticContext::FirstInvocation,
            },
        })
        .expect("configure semantic context");
    let evidence = source
        .collect(&request, &cancellation.token())
        .expect("enabled context");

    assert_eq!(evidence.len(), 1);
    assert_eq!(evidence[0].source, "codebase");
    assert!(evidence[0].reference.starts_with("lib.rs:"));
    assert!(evidence[0].body.contains("target_feature"));
}

fn dir() -> TempDir {
    let dir = tempfile::tempdir().expect("directory");
    std::fs::create_dir(dir.path().join(".git")).expect("git marker");
    std::fs::write(
        dir.path().join("lib.rs"),
        "pub fn target_feature() -> bool { true }\n",
    )
    .expect("source");
    dir
}
