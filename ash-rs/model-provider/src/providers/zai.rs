use super::ProviderAdapter;
use super::api_endpoint;
use crate::ModelProviderError;
use ash_api::ApiEndpoint;
use ash_api::InputItem;
use ash_api::ModelRequest;
use ash_async_utils::CancellationToken;
use ash_client::OperationClient;
use ash_client::ResolvedApiTarget;
use ash_context_engine::ContextTokenMeasurementCapability;
use ash_context_engine::ContextTokenMeasurementOutcome;
use ash_http_client::HttpHeader;
use ash_model_provider_config::InputTokenCountProfile;
use ash_model_provider_config::NormalizedModelProviderConfig;

pub(crate) struct ZaiAdapter {
    token_counter: Option<super::measurement::ProviderInputTokenCounter>,
    endpoint: ApiEndpoint,
}

impl ZaiAdapter {
    pub(crate) fn new(config: &NormalizedModelProviderConfig) -> Self {
        Self {
            token_counter: super::measurement::ProviderInputTokenCounter::from_config(
                config,
                InputTokenCountProfile::ZaiChatCompletions,
            ),
            endpoint: api_endpoint(config.api_profile),
        }
    }
}

impl ProviderAdapter for ZaiAdapter {
    fn endpoint(&self) -> ApiEndpoint {
        self.endpoint
    }

    fn fixed_headers(&self) -> Vec<HttpHeader> {
        vec![HttpHeader::new("Accept-Language", "en-US,en")]
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
        if contains_tool_history(request) {
            return Ok(ContextTokenMeasurementOutcome::Unavailable);
        }
        let count = counter.count(target, model, request, client, cancellation)?;
        super::measurement::estimated_provider_measurement(count, "zai-tokenizer-v1")
    }
}

fn contains_tool_history(request: &ModelRequest) -> bool {
    request.input.iter().any(|item| match item {
        InputItem::Message(message) => !message.tool_calls.is_empty(),
        InputItem::ToolResult(_) => true,
        InputItem::Reasoning(_) => false,
    })
}
