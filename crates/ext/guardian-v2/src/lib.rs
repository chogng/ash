use action_policy::ActionReviewRequest;
use async_utils::CancellationToken;
use config::ResolvedConfig;
use guardian_reviewer::ReviewModel;
use guardian_reviewer::ReviewModelError;
use guardian_reviewer::ReviewModelRequest;
use guardian_reviewer::ReviewerPool;
use model_provider::ModelInvoker;
use model_provider::ModelProvider;
use model_provider::ModelProviderRuntime;
use model_provider::ModelRuntimeRequest;
use model_provider_info::ProviderConfigRegistry;
use protocol::ModelRef;
use protocol::ModelRequest;
use protocol::ResponseItem;
use protocol::ToolChoice;
use std::fmt;
use std::sync::Arc;

/// Resolves one immutable provider-backed model for an approval assessment safe point.
///
/// Callers pass a frozen [`ResolvedConfig`] snapshot. The returned reviewer never rereads mutable
/// configuration, so a concurrent user preference change can affect only a later assessment.
pub struct ReviewModelResolver {
    registry: ProviderConfigRegistry,
    model_provider: Arc<dyn ModelProvider>,
}

impl ReviewModelResolver {
    pub fn builtin() -> Self {
        let registry = ProviderConfigRegistry::builtin();
        let model_provider = Arc::new(ModelProviderRuntime::new(registry.clone()));
        Self::new(registry, model_provider)
    }

    pub fn new(registry: ProviderConfigRegistry, model_provider: Arc<dyn ModelProvider>) -> Self {
        Self {
            registry,
            model_provider,
        }
    }

    pub fn resolve(
        &self,
        config: &ResolvedConfig,
    ) -> Result<ProviderReviewModel, ReviewModelResolutionError> {
        let config = config
            .resolve_approval_review_config(&self.registry)
            .map_err(|error| ReviewModelResolutionError(error.0))?;
        let model = config.model.clone().expect("resolved review model");
        let provider = config.providers.get(&model.provider).ok_or_else(|| {
            ReviewModelResolutionError(format!(
                "approval review model provider '{}' is not configured",
                model.provider
            ))
        })?;
        let invoker = self
            .model_provider
            .runtime(ModelRuntimeRequest::new(model.clone(), provider.clone()))
            .map_err(|error| ReviewModelResolutionError(error.to_string()))?;
        Ok(ProviderReviewModel::new(model, invoker).with_reasoning(
            config
                .model_reasoning_effort
                .map(|effort| protocol::ReasoningConfig {
                    effort,
                    summary: false,
                }),
        ))
    }
}

impl Default for ReviewModelResolver {
    fn default() -> Self {
        Self::builtin()
    }
}

/// Immutable review-only adapter over one provider/model runtime.
#[derive(Clone)]
pub struct ProviderReviewModel {
    model: ModelRef,
    invoker: Arc<dyn ModelInvoker>,
    reasoning: Option<protocol::ReasoningConfig>,
    metrics: diagnostics::Metrics,
}

impl ProviderReviewModel {
    /// Uses the runtime already frozen by the Turn owner.
    pub fn new(model: ModelRef, invoker: Arc<dyn ModelInvoker>) -> Self {
        Self {
            model,
            invoker,
            reasoning: None,
            metrics: diagnostics::Metrics::default(),
        }
    }

    /// Review effort is frozen independently; it never inherits the Agent's effort.
    pub fn with_reasoning(mut self, reasoning: Option<protocol::ReasoningConfig>) -> Self {
        self.reasoning = reasoning;
        self
    }

    pub fn with_metrics(mut self, metrics: diagnostics::Metrics) -> Self {
        self.metrics = metrics;
        self
    }

    fn metric_tags(&self) -> Vec<(&'static str, String)> {
        vec![
            ("guardian_model", self.model.model.to_string()),
            ("provider", self.model.provider.to_string()),
            (
                "reasoning_effort",
                self.reasoning
                    .as_ref()
                    .map(|r| r.effort.to_string())
                    .unwrap_or_else(|| "default".into()),
            ),
        ]
    }

    pub fn model(&self) -> &ModelRef {
        &self.model
    }

    fn request(&self, request: &ReviewModelRequest) -> ModelRequest {
        let mut model_request = ModelRequest::text(request.input_json());
        model_request.instructions = Some(format!(
            "{}\n\nReturn JSON matching this response schema:\n{}",
            request.system_prompt(),
            request.response_schema_json()
        ));
        model_request.tools.clear();
        model_request.tool_choice = ToolChoice::None;
        model_request.parallel_tool_calls = false;
        model_request.temperature = Some(0.0);
        model_request.reasoning = self.reasoning.clone();
        model_request
    }
}

impl ReviewModel for ProviderReviewModel {
    fn complete(
        &self,
        request: &ReviewModelRequest,
        cancellation: &CancellationToken,
    ) -> Result<String, ReviewModelError> {
        cancellation
            .check()
            .map_err(|signal| ReviewModelError::Invocation(signal.reason().to_string()))?;
        let mut first_token = FirstToken {
            started: std::time::Instant::now(),
            elapsed: None,
        };
        let invocation = match self.invoker.output_transport() {
            protocol::ModelOutputTransport::NativeStreaming => self
                .invoker
                .stream_with_cancellation(&self.request(request), cancellation, &mut first_token),
            protocol::ModelOutputTransport::Unary => self
                .invoker
                .invoke_with_cancellation(&self.request(request), cancellation),
        };
        if let Some(elapsed) = first_token.elapsed {
            let tags = self.metric_tags();
            let tags: Vec<_> = tags
                .iter()
                .map(|(key, value)| (*key, value.as_str()))
                .collect();
            self.metrics.guardian_first_token(&tags, elapsed);
        }
        let response = invocation.map_err(|error| match error {
            model_provider::ModelProviderError::Api(model_provider::ApiError::RateLimited {
                retry_at,
            }) => ReviewModelError::RateLimited { retry_at },
            model_provider::ModelProviderError::Unavailable(message) => {
                ReviewModelError::Transient(message)
            }
            error if error.is_transient() => ReviewModelError::Transient(error.to_string()),
            error => ReviewModelError::Invocation(error.to_string()),
        })?;
        // Usage describes work already billed, even if cancellation now prevents using the answer.
        if let Some(usage) = &response.usage {
            let tags = self.metric_tags();
            let tags: Vec<_> = tags
                .iter()
                .map(|(key, value)| (*key, value.as_str()))
                .collect();
            for (kind, tokens) in [
                ("input", usage.input_tokens),
                ("output", usage.output_tokens),
                ("cached_input", usage.cached_input_tokens),
                ("cache_write_input", usage.cache_write_input_tokens),
                ("reasoning", usage.reasoning_tokens),
            ] {
                if let Some(tokens) = tokens {
                    self.metrics.guardian_tokens(&tags, kind, tokens);
                }
            }
        }
        cancellation
            .check()
            .map_err(|signal| ReviewModelError::Invocation(signal.reason().to_string()))?;
        let mut text = String::new();
        for item in response.output {
            match item {
                ResponseItem::Text(fragment)
                | ResponseItem::Message(protocol::AssistantMessage { text: fragment, .. }) => {
                    let bytes = text
                        .len()
                        .checked_add(fragment.len())
                        .ok_or(ReviewModelError::ResponseTooLarge { bytes: usize::MAX })?;
                    if bytes > request.maximum_response_bytes() {
                        return Err(ReviewModelError::ResponseTooLarge { bytes });
                    }
                    text.push_str(&fragment);
                }
                ResponseItem::Reasoning(_) | ResponseItem::ReasoningState(_) => {}
                ResponseItem::Refusal(reason) => {
                    return Err(ReviewModelError::Invocation(format!(
                        "review model refused the assessment: {reason}"
                    )));
                }
                ResponseItem::ToolCall(_) => {
                    return Err(ReviewModelError::Invocation(
                        "review model attempted a tool call".into(),
                    ));
                }
            }
        }
        if text.trim().is_empty() {
            return Err(ReviewModelError::Invocation(
                "review model returned no JSON response".into(),
            ));
        }
        Ok(text)
    }
}

/// Failure to materialize a configured approval review model.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReviewModelResolutionError(String);

impl fmt::Display for ReviewModelResolutionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ReviewModelResolutionError {}

#[cfg(test)]
#[path = "review_tests.rs"]
mod tests;

/// Installs a pooled asynchronous reviewer behind the extension review contract.
pub fn install(builder: &mut extension_api::ExtensionRegistryBuilder, model: ProviderReviewModel) {
    let metrics = model.metrics.clone();
    let tags = model.metric_tags();
    builder.approval_reviewer(Arc::new(PooledReviewer(
        ReviewerPool::new(model).with_metrics(metrics, tags),
    )));
}
struct PooledReviewer(ReviewerPool<ProviderReviewModel>);
impl extension_api::ApprovalReviewContributor for PooledReviewer {
    fn review(
        &self,
        request: &ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<protocol::ClassifierAssessment, extension_api::ExtensionError> {
        use action_policy::ActionClassifier;
        self.0
            .classify(request, cancellation)
            .map_err(|error| extension_api::ExtensionError::new(error.to_string()))
    }
}

/// Captures the isolated reviewer and its revision identity for a host policy.
pub fn reviewer(model: ProviderReviewModel) -> extension_api::ApprovalReviewer {
    let identity = format!(
        "{}/{}:{:?}",
        model.model().provider,
        model.model().model,
        model.reasoning
    );
    let mut builder = extension_api::ExtensionRegistryBuilder::new();
    install(&mut builder, model);
    extension_api::ApprovalReviewer::Configured {
        identity,
        registry: Arc::new(builder.build()),
    }
}

// The final response remains authoritative; this sink observes timing without retaining text.
struct FirstToken {
    started: std::time::Instant,
    elapsed: Option<std::time::Duration>,
}
impl model_provider::ModelEventSink for FirstToken {
    fn emit(
        &mut self,
        event: protocol::ModelStreamEvent,
    ) -> Result<(), model_provider::ModelProviderError> {
        let nonempty = match event {
            protocol::ModelStreamEvent::TextDelta(text)
            | protocol::ModelStreamEvent::ReasoningDelta(text)
            | protocol::ModelStreamEvent::MessageDelta { text, .. } => !text.is_empty(),
            protocol::ModelStreamEvent::MessageCompleted(_)
            | protocol::ModelStreamEvent::MessageStarted { .. } => false,
        };
        if nonempty && self.elapsed.is_none() {
            self.elapsed = Some(self.started.elapsed());
        }
        Ok(())
    }
}
