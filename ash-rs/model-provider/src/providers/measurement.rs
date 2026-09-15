use crate::ModelProviderError;
use ash_api::InputTokenCount;
use ash_api::InputTokenCountEndpoint;
use ash_api::ModelRequest;
use ash_async_utils::CancellationToken;
use ash_client::OperationClient;
use ash_client::ResolvedApiTarget;
use ash_context_engine::ContextTokenCount;
use ash_context_engine::ContextTokenMeasurement;
use ash_context_engine::ContextTokenMeasurementOutcome;
use ash_context_engine::ContextTokenMeasurementSource;
use ash_model_provider_config::InputTokenCountModelPolicy;
use ash_model_provider_config::InputTokenCountProfile;
use ash_model_provider_config::ModelId;
use ash_model_provider_config::NormalizedModelProviderConfig;
use ash_model_provider_config::ProviderId;
use ash_model_tokenizer::LocalTokenCount;
use ash_model_tokenizer::LocalTokenizationOutcome;
use ash_model_tokenizer::LocalTokenizerService;
use ash_protocol::ModelRef;
use std::sync::Arc;

pub(crate) struct ProviderInputTokenCounter {
    endpoint: InputTokenCountEndpoint,
    base_url: String,
    models: InputTokenCountModelPolicy,
}

#[derive(Clone)]
pub(crate) struct LocalInputTokenCounter {
    provider: ProviderId,
    tokenizers: Arc<dyn LocalTokenizerService>,
}

impl LocalInputTokenCounter {
    pub(crate) fn new(provider: ProviderId, tokenizers: Arc<dyn LocalTokenizerService>) -> Self {
        Self {
            provider,
            tokenizers,
        }
    }

    pub(crate) fn supports(&self, model: &str) -> bool {
        model_ref(&self.provider, model).is_some_and(|model| self.tokenizers.supports(&model))
    }

    pub(crate) fn count(
        &self,
        model: &str,
        request: &ModelRequest,
        cancellation: &CancellationToken,
    ) -> Result<ContextTokenMeasurementOutcome, ModelProviderError> {
        check_cancellation(cancellation)?;
        let Some(model) = model_ref(&self.provider, model) else {
            return Ok(ContextTokenMeasurementOutcome::Unavailable);
        };
        let outcome = self.tokenizers.count_input_tokens(&model, request)?;
        check_cancellation(cancellation)?;
        match outcome {
            LocalTokenizationOutcome::UnsupportedRequest
            | LocalTokenizationOutcome::Preparing
            | LocalTokenizationOutcome::Unavailable => {
                Ok(ContextTokenMeasurementOutcome::Unavailable)
            }
            LocalTokenizationOutcome::Count(count) => estimated_local_measurement(count),
        }
    }
}

impl ProviderInputTokenCounter {
    pub(crate) fn from_config(
        config: &NormalizedModelProviderConfig,
        expected_profile: InputTokenCountProfile,
    ) -> Option<Self> {
        let count = config.input_token_count.as_ref()?;
        if count.profile != expected_profile {
            return None;
        }
        Some(Self {
            endpoint: endpoint(count.profile),
            base_url: count.base_url.clone(),
            models: count.models.clone(),
        })
    }

    pub(crate) fn supports(&self, model: &str) -> bool {
        ModelId::new(model)
            .map(|model| self.models.supports(&model))
            .unwrap_or(false)
    }

    pub(crate) fn count(
        &self,
        target: &ResolvedApiTarget,
        model: &str,
        request: &ModelRequest,
        client: &dyn OperationClient,
        cancellation: &CancellationToken,
    ) -> Result<InputTokenCount, ModelProviderError> {
        let target = ResolvedApiTarget::new(self.base_url.clone(), target.headers.clone());
        self.endpoint
            .count_with_client_and_cancellation(&target, model, request, client, cancellation)
            .map_err(Into::into)
    }
}

fn endpoint(profile: InputTokenCountProfile) -> InputTokenCountEndpoint {
    match profile {
        InputTokenCountProfile::OpenAiResponses => InputTokenCountEndpoint::OpenAiResponses,
        InputTokenCountProfile::AnthropicMessages => InputTokenCountEndpoint::AnthropicMessages,
        InputTokenCountProfile::GoogleGenerateContent => {
            InputTokenCountEndpoint::GoogleGenerateContent
        }
        InputTokenCountProfile::KimiChatCompletions => InputTokenCountEndpoint::KimiChatCompletions,
        InputTokenCountProfile::ZaiChatCompletions => InputTokenCountEndpoint::ZaiChatCompletions,
    }
}

pub(crate) fn estimated_provider_measurement(
    count: InputTokenCount,
    source_revision: &'static str,
) -> Result<ContextTokenMeasurementOutcome, ModelProviderError> {
    let count = u32::try_from(count.get()).map_err(|_| {
        ModelProviderError::InvalidResponse("input token count exceeds supported range".into())
    })?;
    let expected = ContextTokenCount::new(count);
    let uncertainty = ContextTokenCount::new(count.div_ceil(100).max(32));
    let conservative_input = expected.saturating_add(uncertainty);
    let source = ContextTokenMeasurementSource::provider_preflight(source_revision)
        .expect("measurement source revisions are constant and non-empty");
    let measurement = ContextTokenMeasurement::estimated(expected, conservative_input, source)
        .expect("the provider uncertainty policy cannot lower the reported count");
    Ok(ContextTokenMeasurementOutcome::Measured(measurement))
}

fn estimated_local_measurement(
    count: LocalTokenCount,
) -> Result<ContextTokenMeasurementOutcome, ModelProviderError> {
    let expected = ContextTokenCount::new(count.tokens());
    let uncertainty = ContextTokenCount::new(count.tokens().div_ceil(50).max(64));
    let conservative_input = expected.saturating_add(uncertainty);
    let source = ContextTokenMeasurementSource::local_tokenizer(count.source_revision())
        .expect("validated local tokenizer revisions are non-empty");
    let measurement = ContextTokenMeasurement::estimated(expected, conservative_input, source)
        .expect("the local tokenizer uncertainty policy cannot lower the reported count");
    Ok(ContextTokenMeasurementOutcome::Measured(measurement))
}

fn model_ref(provider: &ProviderId, model: &str) -> Option<ModelRef> {
    ModelId::new(model)
        .ok()
        .map(|model| ModelRef::new(provider.clone(), model))
}

fn check_cancellation(cancellation: &CancellationToken) -> Result<(), ModelProviderError> {
    cancellation
        .check()
        .map_err(|signal| ModelProviderError::Cancelled(signal.reason().to_string()))
}
