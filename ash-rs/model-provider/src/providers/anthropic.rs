use super::ProviderAdapter;
use super::api_endpoint;
use crate::ModelProviderError;
use ash_api::ApiEndpoint;
use ash_api::ModelRequest;
use ash_async_utils::CancellationToken;
use ash_client::OperationClient;
use ash_client::ResolvedApiTarget;
use ash_context_engine::ContextTokenMeasurementCapability;
use ash_context_engine::ContextTokenMeasurementOutcome;
use ash_model_provider_config::InputTokenCountProfile;
use ash_model_provider_config::NormalizedModelProviderConfig;
use ash_protocol::Model;
use ash_protocol::ModelImageInputLimits;
use ash_protocol::ModelImageInputPolicy;

pub(crate) struct AnthropicAdapter {
    token_counter: Option<super::measurement::ProviderInputTokenCounter>,
    endpoint: ApiEndpoint,
}

impl AnthropicAdapter {
    pub(crate) fn new(config: &NormalizedModelProviderConfig) -> Self {
        Self {
            token_counter: super::measurement::ProviderInputTokenCounter::from_config(
                config,
                InputTokenCountProfile::AnthropicMessages,
            ),
            endpoint: if config.provider.as_str().starts_with("custom-")
                || config.provider.as_str() == "openai-compatible"
            {
                ApiEndpoint::AnthropicMessagesAtBase
            } else {
                api_endpoint(config.api_profile)
            },
        }
    }
}

impl ProviderAdapter for AnthropicAdapter {
    fn image_input_policy(&self, _: &Model) -> ModelImageInputPolicy {
        const LOW: ModelImageInputLimits = ModelImageInputLimits::new(512, 256);
        const STANDARD: ModelImageInputLimits = ModelImageInputLimits::new(1_568, 1_120);
        ModelImageInputPolicy::new(STANDARD, LOW, STANDARD, STANDARD)
    }

    fn endpoint(&self) -> ApiEndpoint {
        self.endpoint
    }

    fn input_token_measurement_capability(&self, model: &str) -> ContextTokenMeasurementCapability {
        if self
            .token_counter
            .as_ref()
            .is_some_and(|counter| counter.supports(model))
        {
            ContextTokenMeasurementCapability::Remote
        } else {
            ContextTokenMeasurementCapability::Unavailable
        }
    }

    fn measure_input(
        &self,
        target: &ResolvedApiTarget,
        model: &str,
        request: &ModelRequest,
        client: &dyn OperationClient,
        cancellation: &CancellationToken,
    ) -> Result<ContextTokenMeasurementOutcome, ModelProviderError> {
        let Some(counter) = self
            .token_counter
            .as_ref()
            .filter(|counter| counter.supports(model))
        else {
            return Ok(ContextTokenMeasurementOutcome::Unavailable);
        };
        let count = counter.count(target, model, request, client, cancellation)?;
        super::measurement::estimated_provider_measurement(count, "anthropic-count-tokens-v1")
    }
}
