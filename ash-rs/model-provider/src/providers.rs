use crate::ModelProviderError;
use ash_api::ApiEndpoint;
use ash_api::ModelRequest;
use ash_async_utils::CancellationToken;
use ash_client::OperationClient;
use ash_client::ResolvedApiTarget;
use ash_context_engine::ContextTokenMeasurementCapability;
use ash_context_engine::ContextTokenMeasurementOutcome;
use ash_model_provider_config::ApiProfile;
use ash_model_provider_config::NormalizedModelProviderConfig;
use ash_model_provider_config::ProviderAdapter as ProviderAdapterKind;
use std::sync::Arc;

mod anthropic;
mod deepseek;
mod google;
mod huggingface;
mod kimi;
pub(crate) mod measurement;
mod mimo;
mod minimax;
mod ollama;
mod openai;
mod openai_compatible;
mod qwen;
mod xai;
mod zai;

/// Supplies provider-specific endpoint, model-name, header and input-measurement choices.
///
/// Choices belong to one immutable runtime snapshot. Generation request execution belongs to
/// the shared runtime; request encoding and response decoding belong to `ash-api`.
pub(crate) trait ProviderAdapter: Send + Sync {
    fn endpoint(&self) -> ApiEndpoint;

    fn model_id<'a>(&self, model: &'a str) -> &'a str {
        model
    }

    /// Returns provider-owned non-secret headers applied to every direct API request.
    fn fixed_headers(&self) -> Vec<ash_http_client::HttpHeader> {
        Vec::new()
    }

    /// Reports whether this immutable adapter can measure canonical input locally or remotely.
    fn input_token_measurement_capability(&self, _: &str) -> ContextTokenMeasurementCapability {
        ContextTokenMeasurementCapability::Unavailable
    }

    /// Measures one fully assembled request using the adapter's declared tokenizer contract.
    fn measure_input(
        &self,
        _: &ResolvedApiTarget,
        _: &str,
        _: &ModelRequest,
        _: &dyn OperationClient,
        _: &CancellationToken,
    ) -> Result<ContextTokenMeasurementOutcome, ModelProviderError> {
        Ok(ContextTokenMeasurementOutcome::Unavailable)
    }
}

pub(crate) fn instantiate(
    adapter: ProviderAdapterKind,
    config: &NormalizedModelProviderConfig,
) -> Arc<dyn ProviderAdapter> {
    match adapter {
        ProviderAdapterKind::OpenAi => runtime_adapter(openai::OpenAiAdapter::new(config)),
        ProviderAdapterKind::OpenAiCompatible => {
            runtime_adapter(openai_compatible::OpenAiCompatibleAdapter::new(config))
        }
        ProviderAdapterKind::Anthropic => runtime_adapter(anthropic::AnthropicAdapter::new(config)),
        ProviderAdapterKind::Google => runtime_adapter(google::GoogleAdapter::new(config)),
        ProviderAdapterKind::Xai => runtime_adapter(xai::XaiAdapter::new(config)),
        ProviderAdapterKind::Qwen => runtime_adapter(qwen::QwenAdapter::new(config)),
        ProviderAdapterKind::Kimi => runtime_adapter(kimi::KimiAdapter::new(config)),
        ProviderAdapterKind::DeepSeek => runtime_adapter(deepseek::DeepSeekAdapter::new(config)),
        ProviderAdapterKind::Ollama => runtime_adapter(ollama::OllamaAdapter::new(config)),
        ProviderAdapterKind::HuggingFace => {
            runtime_adapter(huggingface::HuggingFaceAdapter::new(config))
        }
        ProviderAdapterKind::Zai => runtime_adapter(zai::ZaiAdapter::new(config)),
        ProviderAdapterKind::MiniMax => runtime_adapter(minimax::MiniMaxAdapter::new(config)),
        ProviderAdapterKind::Mimo => runtime_adapter(mimo::MimoAdapter::new(config)),
    }
}

fn runtime_adapter(adapter: impl ProviderAdapter + 'static) -> Arc<dyn ProviderAdapter> {
    Arc::new(adapter)
}

fn api_endpoint(profile: ApiProfile) -> ApiEndpoint {
    match profile {
        ApiProfile::OpenAiResponses => ApiEndpoint::OpenAiResponses,
        ApiProfile::OpenAiChatCompletions => ApiEndpoint::OpenAiChatCompletions,
        ApiProfile::AnthropicMessages => ApiEndpoint::AnthropicMessages,
    }
}
