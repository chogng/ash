use std::sync::Arc;

use ash_api::SemanticApiEndpoint;
use ash_client::OperationClient;
use ash_client::ResolvedApiTarget;
use ash_model_provider_config::ProviderAdapter;
use ash_model_provider_config::ProviderConfigRegistry;

use crate::EmbeddingInvoker;
use crate::EmbeddingRequest;
use crate::EmbeddingResponse;
use crate::EmbeddingRuntimeIdentity;
use crate::EmbeddingRuntimeRequest;
use crate::EmbeddingVector;
use crate::ModelProviderError;
use crate::ProviderCredentialService;
use crate::RerankInvoker;
use crate::RerankRequest;
use crate::RerankResponse;
use crate::RerankRuntimeRequest;
use crate::SemanticModelProvider;
use crate::SemanticRuntimeLocation;

pub(crate) struct SemanticRuntimeResolver {
    pub(crate) configs: ProviderConfigRegistry,
    pub(crate) client: Arc<dyn OperationClient>,
    pub(crate) credentials: Option<ProviderCredentialService>,
}

impl SemanticModelProvider for SemanticRuntimeResolver {
    fn embedding_runtime_identity(
        &self,
        request: &EmbeddingRuntimeRequest,
    ) -> Result<EmbeddingRuntimeIdentity, ModelProviderError> {
        let normalized = self
            .configs
            .normalize_for(&request.config, &request.model.provider)?;
        EmbeddingRuntimeIdentity::new(format!(
            "provider={};model={};endpoint={}",
            request.model.provider, request.model.model, normalized.base_url
        ))
    }

    fn embedding_runtime_location(
        &self,
        request: &EmbeddingRuntimeRequest,
    ) -> Result<SemanticRuntimeLocation, ModelProviderError> {
        self.runtime_location(&request.model.provider, &request.config)
    }

    fn rerank_runtime_location(
        &self,
        request: &RerankRuntimeRequest,
    ) -> Result<SemanticRuntimeLocation, ModelProviderError> {
        self.runtime_location(&request.model.provider, &request.config)
    }

    fn embedding_runtime(
        &self,
        request: EmbeddingRuntimeRequest,
    ) -> Result<Arc<dyn EmbeddingInvoker>, ModelProviderError> {
        let runtime = self.resolve(
            &request.model.provider,
            &request.config,
            SemanticOperation::Embedding,
        )?;
        Ok(Arc::new(ProviderEmbeddingInvoker {
            runtime,
            model: request.model.model.to_string(),
        }))
    }

    fn rerank_runtime(
        &self,
        request: RerankRuntimeRequest,
    ) -> Result<Arc<dyn RerankInvoker>, ModelProviderError> {
        let runtime = self.resolve(
            &request.model.provider,
            &request.config,
            SemanticOperation::Rerank,
        )?;
        Ok(Arc::new(ProviderRerankInvoker {
            runtime,
            model: request.model.model.to_string(),
        }))
    }
}

impl SemanticRuntimeResolver {
    fn runtime_location(
        &self,
        provider: &ash_protocol::ProviderId,
        config: &ash_model_provider_config::ModelProviderConfig,
    ) -> Result<SemanticRuntimeLocation, ModelProviderError> {
        let normalized = self.configs.normalize_for(config, provider)?;
        let url = url::Url::parse(&normalized.base_url).map_err(|error| {
            ModelProviderError::Unavailable(format!(
                "provider '{provider}' has an invalid semantic endpoint: {error}"
            ))
        })?;
        let device = url.host_str().is_some_and(|host| {
            host.eq_ignore_ascii_case("localhost")
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|address| address.is_loopback())
        });
        Ok(if device {
            SemanticRuntimeLocation::Device
        } else {
            SemanticRuntimeLocation::Network
        })
    }

    fn resolve(
        &self,
        provider: &ash_protocol::ProviderId,
        config: &ash_model_provider_config::ModelProviderConfig,
        operation: SemanticOperation,
    ) -> Result<SemanticHttpRuntime, ModelProviderError> {
        let normalized = self.configs.normalize_for(config, provider)?;
        let definition = self
            .configs
            .get(provider)
            .expect("normalization only succeeds for registered providers");
        let supported = match operation {
            SemanticOperation::Embedding => matches!(
                definition.adapter,
                ProviderAdapter::OpenAi
                    | ProviderAdapter::OpenAiCompatible
                    | ProviderAdapter::Ollama
            ),
            SemanticOperation::Rerank => definition.adapter == ProviderAdapter::OpenAiCompatible,
        };
        if !supported {
            return Err(ModelProviderError::Unavailable(format!(
                "provider '{provider}' does not expose the configured {} endpoint",
                operation.label()
            )));
        }
        let headers = self
            .credentials
            .as_ref()
            .map(|credentials| credentials.request_headers(provider))
            .transpose()
            .map_err(|error| ModelProviderError::Credential(error.to_string()))?
            .unwrap_or_default();
        Ok(SemanticHttpRuntime {
            target: ResolvedApiTarget::new(normalized.base_url, headers),
            endpoint: SemanticApiEndpoint::OpenAiCompatible,
            client: Arc::clone(&self.client),
        })
    }
}

#[derive(Clone, Copy)]
enum SemanticOperation {
    Embedding,
    Rerank,
}

impl SemanticOperation {
    fn label(self) -> &'static str {
        match self {
            Self::Embedding => "embedding",
            Self::Rerank => "rerank",
        }
    }
}

#[derive(Clone)]
struct SemanticHttpRuntime {
    target: ResolvedApiTarget,
    endpoint: SemanticApiEndpoint,
    client: Arc<dyn OperationClient>,
}

struct ProviderEmbeddingInvoker {
    runtime: SemanticHttpRuntime,
    model: String,
}

impl EmbeddingInvoker for ProviderEmbeddingInvoker {
    fn embed(&self, request: &EmbeddingRequest) -> Result<EmbeddingResponse, ModelProviderError> {
        self.embed_with_cancellation(request, &ash_async_utils::CancellationSource::new().token())
    }

    fn embed_with_cancellation(
        &self,
        request: &EmbeddingRequest,
        cancellation: &ash_async_utils::CancellationToken,
    ) -> Result<EmbeddingResponse, ModelProviderError> {
        self.runtime
            .endpoint
            .embed_with_client_and_cancellation(
                &self.runtime.target,
                &self.model,
                request.inputs(),
                self.runtime.client.as_ref(),
                cancellation,
            )?
            .into_iter()
            .map(EmbeddingVector::new)
            .collect::<Result<Vec<_>, _>>()
            .and_then(EmbeddingResponse::new)
    }
}

struct ProviderRerankInvoker {
    runtime: SemanticHttpRuntime,
    model: String,
}

impl RerankInvoker for ProviderRerankInvoker {
    fn rerank(&self, request: &RerankRequest) -> Result<RerankResponse, ModelProviderError> {
        self.rerank_with_cancellation(request, &ash_async_utils::CancellationSource::new().token())
    }

    fn rerank_with_cancellation(
        &self,
        request: &RerankRequest,
        cancellation: &ash_async_utils::CancellationToken,
    ) -> Result<RerankResponse, ModelProviderError> {
        self.runtime
            .endpoint
            .rerank_with_client_and_cancellation(
                &self.runtime.target,
                &self.model,
                request.query(),
                request.documents(),
                self.runtime.client.as_ref(),
                cancellation,
            )
            .map_err(Into::into)
            .and_then(RerankResponse::new)
    }
}
