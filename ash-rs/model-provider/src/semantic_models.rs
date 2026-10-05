use crate::ModelProviderError;
use ash_async_utils::CancellationToken;

const MAX_BATCH_ITEMS: usize = 2_048;

/// Validated batch of text inputs for one immutable embedding model invocation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EmbeddingRequest {
    inputs: Vec<String>,
}

impl EmbeddingRequest {
    pub fn new(inputs: Vec<String>) -> Result<Self, ModelProviderError> {
        if inputs.is_empty() || inputs.len() > MAX_BATCH_ITEMS {
            return Err(ModelProviderError::InvalidRequest(
                "embedding batch must contain 1..=2048 inputs".into(),
            ));
        }
        Ok(Self { inputs })
    }

    pub fn inputs(&self) -> &[String] {
        &self.inputs
    }
}

/// One finite, non-empty embedding returned by a model adapter.
#[derive(Clone, Debug, PartialEq)]
pub struct EmbeddingVector {
    values: Vec<f32>,
}

impl EmbeddingVector {
    pub fn new(values: Vec<f32>) -> Result<Self, ModelProviderError> {
        if values.is_empty() || values.iter().any(|value| !value.is_finite()) {
            return Err(ModelProviderError::InvalidResponse(
                "embedding vectors must be non-empty and finite".into(),
            ));
        }
        Ok(Self { values })
    }

    pub fn values(&self) -> &[f32] {
        &self.values
    }
}

/// Ordered embedding output corresponding one-for-one with the request inputs.
#[derive(Clone, Debug, PartialEq)]
pub struct EmbeddingResponse {
    vectors: Vec<EmbeddingVector>,
}

impl EmbeddingResponse {
    pub fn new(vectors: Vec<EmbeddingVector>) -> Result<Self, ModelProviderError> {
        let Some(dimension) = vectors.first().map(|vector| vector.values.len()) else {
            return Err(ModelProviderError::InvalidResponse(
                "embedding response must contain at least one vector".into(),
            ));
        };
        if vectors
            .iter()
            .any(|vector| vector.values.len() != dimension)
        {
            return Err(ModelProviderError::InvalidResponse(
                "embedding response dimensions must be consistent".into(),
            ));
        }
        Ok(Self { vectors })
    }

    pub fn vectors(&self) -> &[EmbeddingVector] {
        &self.vectors
    }

    pub fn into_vectors(self) -> Vec<EmbeddingVector> {
        self.vectors
    }
}

/// Invokes one immutable provider/model selection through its embedding API.
///
/// Implementations adapt canonical inputs to provider transport and return vectors in input
/// order. They do not choose code chunks, persist vectors, retrieve candidates, or rank results.
pub trait EmbeddingInvoker: Send + Sync {
    fn embed(&self, request: &EmbeddingRequest) -> Result<EmbeddingResponse, ModelProviderError>;

    /// Invokes the model while observing a caller-owned cancellation domain.
    ///
    /// Implementations with cancellation-aware transports should override this method. The
    /// default preserves compatibility for local deterministic invokers.
    fn embed_with_cancellation(
        &self,
        request: &EmbeddingRequest,
        cancellation: &CancellationToken,
    ) -> Result<EmbeddingResponse, ModelProviderError> {
        cancellation
            .check()
            .map_err(|signal| ModelProviderError::Cancelled(signal.reason().to_string()))?;
        self.embed(request)
    }
}

/// Immutable provider/model/config binding used to construct one embedding invoker.
#[derive(Clone)]
pub struct EmbeddingRuntimeRequest {
    pub model: crate::ModelRef,
    pub config: model_provider_info::ModelProviderConfig,
}

impl EmbeddingRuntimeRequest {
    pub fn new(model: crate::ModelRef, config: model_provider_info::ModelProviderConfig) -> Self {
        Self { model, config }
    }
}

/// Stable, non-secret identity of the runtime that produces persisted embeddings.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EmbeddingRuntimeIdentity(String);

impl EmbeddingRuntimeIdentity {
    pub fn new(value: impl Into<String>) -> Result<Self, ModelProviderError> {
        let value = value.into();
        if value.is_empty() || value.len() > 4096 || value.chars().any(char::is_control) {
            return Err(ModelProviderError::InvalidRequest(
                "embedding runtime identity must be 1..=4096 bytes without control characters"
                    .into(),
            ));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Query and candidate texts sent to one immutable rerank model invocation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RerankRequest {
    query: String,
    documents: Vec<String>,
}

impl RerankRequest {
    pub fn new(
        query: impl Into<String>,
        documents: Vec<String>,
    ) -> Result<Self, ModelProviderError> {
        let query = query.into();
        if query.trim().is_empty() {
            return Err(ModelProviderError::InvalidRequest(
                "rerank query must contain non-whitespace text".into(),
            ));
        }
        if documents.is_empty() || documents.len() > MAX_BATCH_ITEMS {
            return Err(ModelProviderError::InvalidRequest(
                "rerank batch must contain 1..=2048 documents".into(),
            ));
        }
        Ok(Self { query, documents })
    }

    pub fn query(&self) -> &str {
        &self.query
    }

    pub fn documents(&self) -> &[String] {
        &self.documents
    }
}

/// Model scores corresponding one-for-one with the request documents.
///
/// The response preserves input order. The model adapter does not sort, filter, or truncate the
/// candidates; that policy belongs to the calling Codebase service.
#[derive(Clone, Debug, PartialEq)]
pub struct RerankResponse {
    scores: Vec<f32>,
}

impl RerankResponse {
    pub fn new(scores: Vec<f32>) -> Result<Self, ModelProviderError> {
        if scores.is_empty() || scores.iter().any(|score| !score.is_finite()) {
            return Err(ModelProviderError::InvalidResponse(
                "rerank scores must be non-empty and finite".into(),
            ));
        }
        Ok(Self { scores })
    }

    pub fn scores(&self) -> &[f32] {
        &self.scores
    }
}

/// Invokes one immutable provider/model selection through its rerank API.
///
/// Implementations return one score per input document in the same order. Candidate construction,
/// score interpretation, sorting, filtering, and truncation remain with the Codebase service.
pub trait RerankInvoker: Send + Sync {
    fn rerank(&self, request: &RerankRequest) -> Result<RerankResponse, ModelProviderError>;

    /// Invokes the reranker while observing a caller-owned cancellation domain.
    fn rerank_with_cancellation(
        &self,
        request: &RerankRequest,
        cancellation: &CancellationToken,
    ) -> Result<RerankResponse, ModelProviderError> {
        cancellation
            .check()
            .map_err(|signal| ModelProviderError::Cancelled(signal.reason().to_string()))?;
        self.rerank(request)
    }
}

/// Immutable provider/model/config binding used to construct one rerank invoker.
#[derive(Clone)]
pub struct RerankRuntimeRequest {
    pub model: crate::ModelRef,
    pub config: model_provider_info::ModelProviderConfig,
}

/// Where one semantic model invocation executes relative to the user's device.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SemanticRuntimeLocation {
    Device,
    Network,
}

impl RerankRuntimeRequest {
    pub fn new(model: crate::ModelRef, config: model_provider_info::ModelProviderConfig) -> Self {
        Self { model, config }
    }
}

/// Resolves configured semantic models into immutable provider invokers.
///
/// Implementations own provider transport and credential materialization only. Code chunking,
/// vector persistence, recall, candidate sorting, and fusion remain with codebase crates.
pub trait SemanticModelProvider: Send + Sync {
    fn embedding_runtime_identity(
        &self,
        request: &EmbeddingRuntimeRequest,
    ) -> Result<EmbeddingRuntimeIdentity, ModelProviderError>;

    fn embedding_runtime_location(
        &self,
        request: &EmbeddingRuntimeRequest,
    ) -> Result<SemanticRuntimeLocation, ModelProviderError>;

    fn rerank_runtime_location(
        &self,
        request: &RerankRuntimeRequest,
    ) -> Result<SemanticRuntimeLocation, ModelProviderError>;

    fn embedding_runtime(
        &self,
        request: EmbeddingRuntimeRequest,
    ) -> Result<std::sync::Arc<dyn EmbeddingInvoker>, ModelProviderError>;

    fn rerank_runtime(
        &self,
        request: RerankRuntimeRequest,
    ) -> Result<std::sync::Arc<dyn RerankInvoker>, ModelProviderError>;
}
