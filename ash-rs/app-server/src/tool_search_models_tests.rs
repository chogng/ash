use super::*;
use ash_model_provider::EmbeddingInvoker;
use ash_model_provider::EmbeddingRequest;
use ash_model_provider::EmbeddingResponse;
use ash_model_provider::EmbeddingRuntimeIdentity;
use ash_model_provider::EmbeddingVector;
use ash_model_provider::ModelProviderError;
use ash_model_provider::RerankInvoker;
use ash_model_provider::RerankRuntimeRequest;
use ash_model_provider::SemanticRuntimeLocation;
use ash_protocol::ModelId;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

struct ReadyEmbedding;

impl EmbeddingInvoker for ReadyEmbedding {
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

struct TestSemanticModelProvider {
    resolutions: AtomicUsize,
}

impl SemanticModelProvider for TestSemanticModelProvider {
    fn embedding_runtime_identity(
        &self,
        _: &EmbeddingRuntimeRequest,
    ) -> Result<EmbeddingRuntimeIdentity, ModelProviderError> {
        EmbeddingRuntimeIdentity::new("test-tool-search-embedding")
    }

    fn embedding_runtime_location(
        &self,
        _: &EmbeddingRuntimeRequest,
    ) -> Result<SemanticRuntimeLocation, ModelProviderError> {
        Ok(SemanticRuntimeLocation::Device)
    }

    fn rerank_runtime_location(
        &self,
        _: &RerankRuntimeRequest,
    ) -> Result<SemanticRuntimeLocation, ModelProviderError> {
        Ok(SemanticRuntimeLocation::Device)
    }

    fn embedding_runtime(
        &self,
        _: EmbeddingRuntimeRequest,
    ) -> Result<Arc<dyn EmbeddingInvoker>, ModelProviderError> {
        self.resolutions.fetch_add(1, Ordering::SeqCst);
        Ok(Arc::new(ReadyEmbedding))
    }

    fn rerank_runtime(
        &self,
        _: RerankRuntimeRequest,
    ) -> Result<Arc<dyn RerankInvoker>, ModelProviderError> {
        Err(ModelProviderError::Unavailable("rerank is unused".into()))
    }
}

fn hybrid_config() -> (ToolSearchConfig, BTreeMap<ProviderId, ModelProviderConfig>) {
    let provider = ProviderId::new("test-provider").unwrap();
    let model = ModelRef::new(provider.clone(), ModelId::new("embedding-v1").unwrap());
    (
        ToolSearchConfig {
            mode: ToolSearchModeConfig::HybridEmbedding,
            embedding_model: Some(model),
        },
        BTreeMap::from([(provider.clone(), ModelProviderConfig::new(provider))]),
    )
}

#[test]
fn hybrid_resolution_uses_the_selected_model_and_passes_the_probe() {
    let (config, providers) = hybrid_config();
    let provider = Arc::new(TestSemanticModelProvider {
        resolutions: AtomicUsize::new(0),
    });
    let semantic_provider: Arc<dyn SemanticModelProvider> = provider.clone();

    let resolution = resolve_tool_search(&config, &providers, Some(&semantic_provider));

    assert_eq!(provider.resolutions.load(Ordering::SeqCst), 1);
    assert_eq!(
        resolution.status,
        ToolSearchEmbeddingStatus::Ready {
            model: config.embedding_model.unwrap(),
        }
    );
}

#[test]
fn missing_runtime_is_unavailable_without_enabling_lexical_fallback() {
    let (config, providers) = hybrid_config();

    let resolution = resolve_tool_search(&config, &providers, None);

    assert_eq!(
        resolution.status,
        ToolSearchEmbeddingStatus::Unavailable {
            model: config.embedding_model,
            reason: "this App Server host does not provide semantic model invocation".into(),
        }
    );
    assert_eq!(
        resolution.options.mode(),
        ToolSearchModeConfig::HybridEmbedding
    );
}
