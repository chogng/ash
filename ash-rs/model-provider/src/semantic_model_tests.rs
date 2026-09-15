use super::*;
use ash_client::ClientError;
use ash_client::ClientRequest;
use ash_client::ClientResponse;
use ash_client::OperationClient;
use ash_model_provider_config::ModelProviderConfig;
use ash_model_provider_config::ProviderConfigRegistry;
use ash_secrets::MemorySecretStore;
use ash_secrets::SecretKey;
use ash_secrets::SecretStore;
use ash_secrets::SecretValue;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;
use std::sync::Mutex;

struct SemanticTransport {
    requests: Mutex<Vec<ClientRequest>>,
}

impl Default for SemanticTransport {
    fn default() -> Self {
        Self {
            requests: Mutex::new(Vec::new()),
        }
    }
}

impl OperationClient for SemanticTransport {
    fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
        self.requests.lock().unwrap().push(request.clone());
        let response: Value = if request.url().ends_with("/embeddings") {
            json!({"data": [{"index": 0, "embedding": [0.25, 0.75]}]})
        } else {
            json!({"results": [{"index": 0, "relevance_score": 0.9}]})
        };
        Ok(ClientResponse::new(
            200,
            Vec::new(),
            serde_json::to_vec(&response).unwrap(),
        ))
    }
}

fn semantic_model(provider: &str, model: &str) -> ModelRef {
    ModelRef::new(
        ProviderId::new(provider).unwrap(),
        ModelId::new(model).unwrap(),
    )
}

#[test]
fn embedding_response_rejects_inconsistent_dimensions_and_non_finite_values() {
    let first = EmbeddingVector::new(vec![1.0, 0.0]).expect("first vector");
    let second = EmbeddingVector::new(vec![1.0]).expect("second vector");
    assert_eq!(
        EmbeddingResponse::new(vec![first, second]),
        Err(ModelProviderError::InvalidResponse(
            "embedding response dimensions must be consistent".into()
        ))
    );
    assert_eq!(
        EmbeddingVector::new(vec![f32::NAN]),
        Err(ModelProviderError::InvalidResponse(
            "embedding vectors must be non-empty and finite".into()
        ))
    );
}

#[test]
fn rerank_contract_preserves_document_order_for_the_calling_service() {
    let request =
        RerankRequest::new("query", vec!["first".into(), "second".into()]).expect("rerank request");
    let response = RerankResponse::new(vec![0.25, 0.75]).expect("rerank response");

    assert_eq!(request.documents(), &["first", "second"]);
    assert_eq!(response.scores(), &[0.25, 0.75]);
}

#[test]
fn semantic_runtime_invokes_concrete_embedding_and_rerank_endpoints() {
    let transport = Arc::new(SemanticTransport::default());
    let runtime =
        ModelProviderRuntime::with_client(ProviderConfigRegistry::builtin(), transport.clone());
    let config = ModelProviderConfig::new(ProviderId::new("ollama").unwrap());
    let embedding = runtime
        .embedding_runtime(EmbeddingRuntimeRequest::new(
            semantic_model("ollama", "nomic-embed-text"),
            config.clone(),
        ))
        .unwrap();
    assert_eq!(
        embedding
            .embed(&EmbeddingRequest::new(vec!["source".into()]).unwrap())
            .unwrap()
            .vectors()[0]
            .values(),
        &[0.25, 0.75]
    );
    let mut rerank_config = ModelProviderConfig::new(ProviderId::new("openai-compatible").unwrap());
    rerank_config.base_url = Some("https://rerank.example.test/v1".into());
    let rerank = runtime
        .rerank_runtime(RerankRuntimeRequest::new(
            semantic_model("openai-compatible", "rerank-model"),
            rerank_config,
        ))
        .unwrap();
    assert_eq!(
        rerank
            .rerank(&RerankRequest::new("query", vec!["candidate".into()]).unwrap())
            .unwrap()
            .scores(),
        &[0.9]
    );

    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests[0].url(), "http://localhost:11434/v1/embeddings");
    assert_eq!(requests[1].url(), "https://rerank.example.test/v1/rerank");
}

#[test]
fn semantic_runtime_reports_loopback_endpoints_as_device_local() {
    let runtime = ModelProviderRuntime::with_client(
        ProviderConfigRegistry::builtin(),
        Arc::new(SemanticTransport::default()),
    );
    let ollama = EmbeddingRuntimeRequest::new(
        semantic_model("ollama", "nomic-embed-text"),
        ModelProviderConfig::new(ProviderId::new("ollama").unwrap()),
    );
    assert_eq!(
        runtime.embedding_runtime_location(&ollama).unwrap(),
        SemanticRuntimeLocation::Device
    );

    let provider = ProviderId::new("openai-compatible").unwrap();
    let mut network_config = ModelProviderConfig::new(provider.clone());
    network_config.base_url = Some("https://models.example.test/v1".into());
    let network = EmbeddingRuntimeRequest::new(
        semantic_model("openai-compatible", "embed-v1"),
        network_config,
    );
    assert_eq!(
        runtime.embedding_runtime_location(&network).unwrap(),
        SemanticRuntimeLocation::Network
    );
}

#[test]
fn openai_semantic_runtime_requires_and_materializes_its_secret() {
    let transport = Arc::new(SemanticTransport::default());
    let secrets = Arc::new(MemorySecretStore::default());
    let config = ModelProviderConfig::new(ProviderId::new("openai").unwrap());
    let request =
        EmbeddingRuntimeRequest::new(semantic_model("openai", "text-embedding-3-small"), config);
    let unavailable = ModelProviderRuntime::with_client_and_secrets(
        ProviderConfigRegistry::builtin(),
        transport.clone(),
        secrets.clone(),
    );
    assert!(matches!(
        unavailable.embedding_runtime(request.clone()),
        Err(ModelProviderError::Credential(_))
    ));

    secrets
        .store(
            &SecretKey::new("provider/openai/default/api-key").unwrap(),
            &SecretValue::new("test-secret"),
        )
        .unwrap();
    unavailable
        .embedding_runtime(request)
        .unwrap()
        .embed(&EmbeddingRequest::new(vec!["source".into()]).unwrap())
        .unwrap();
    let requests = transport.requests.lock().unwrap();
    assert!(requests[0].headers().iter().any(|header| {
        header.name() == "Authorization" && header.value() == "Bearer test-secret"
    }));
}
