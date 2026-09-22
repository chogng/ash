use super::ProviderAdapter;
use super::api_endpoint;
use crate::ModelProviderError;
use ash_api::ApiEndpoint;
use ash_api::ModelRequest;
use ash_async_utils::CancellationToken;
use ash_client::OperationClient;
use ash_client::ResolvedApiTarget;
use ash_context_engine::ContextTokenCount;
use ash_context_engine::ContextTokenMeasurement;
use ash_context_engine::ContextTokenMeasurementCapability;
use ash_context_engine::ContextTokenMeasurementOutcome;
use ash_context_engine::ContextTokenMeasurementSource;
use ash_model_provider_config::InputTokenCountProfile;
use ash_model_provider_config::NormalizedModelProviderConfig;
use ash_protocol::CapabilitySupport;
use ash_protocol::Model;
use ash_protocol::ModelImageInputLimits;
use ash_protocol::ModelImageInputPolicy;

pub(crate) struct OpenAiAdapter {
    token_counter: Option<super::measurement::ProviderInputTokenCounter>,
    endpoint: ApiEndpoint,
}

impl OpenAiAdapter {
    pub(crate) fn new(config: &NormalizedModelProviderConfig) -> Self {
        Self {
            token_counter: super::measurement::ProviderInputTokenCounter::from_config(
                config,
                InputTokenCountProfile::OpenAiResponses,
            ),
            endpoint: api_endpoint(config.api_profile),
        }
    }
}

impl ProviderAdapter for OpenAiAdapter {
    fn image_input_policy(&self, model: &Model) -> ModelImageInputPolicy {
        const LOW: ModelImageInputLimits = ModelImageInputLimits::new(512, 256);
        const HIGH: ModelImageInputLimits = ModelImageInputLimits::new(2_048, 2_440);
        const ORIGINAL: ModelImageInputLimits = ModelImageInputLimits::new(6_000, 10_000);
        if model.capabilities.image_detail_original == CapabilitySupport::Supported {
            ModelImageInputPolicy::new(ORIGINAL, LOW, HIGH, ORIGINAL)
        } else {
            ModelImageInputPolicy::new(HIGH, LOW, HIGH, HIGH)
        }
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
        let count = u32::try_from(count.get()).map_err(|_| {
            ModelProviderError::InvalidResponse("input token count exceeds supported range".into())
        })?;
        let source =
            ContextTokenMeasurementSource::provider_preflight("openai-responses-input-tokens-v1")
                .expect("measurement source revision is constant and non-empty");
        Ok(ContextTokenMeasurementOutcome::Measured(
            ContextTokenMeasurement::exact(ContextTokenCount::new(count), source),
        ))
    }
}
