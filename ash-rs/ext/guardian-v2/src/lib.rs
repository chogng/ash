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
use model_provider_config::ProviderConfigRegistry;
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
        let model = config
            .resolve_approval_review_model(&self.registry)
            .map_err(|error| ReviewModelResolutionError(error.0))?;
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
        Ok(ProviderReviewModel { model, invoker })
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
}

impl ProviderReviewModel {
    pub fn model(&self) -> &ModelRef {
        &self.model
    }

    fn request(request: &ReviewModelRequest) -> ModelRequest {
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
        let response = self
            .invoker
            .invoke_with_cancellation(&Self::request(request), cancellation)
            .map_err(|error| match error {
                model_provider::ModelProviderError::Unavailable(message) => {
                    ReviewModelError::Transient(message)
                }
                error => ReviewModelError::Invocation(error.to_string()),
            })?;
        cancellation
            .check()
            .map_err(|signal| ReviewModelError::Invocation(signal.reason().to_string()))?;

        let mut text = String::new();
        for item in response.output {
            match item {
                ResponseItem::Text(fragment) => {
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
    builder.approval_reviewer(Arc::new(PooledReviewer(ReviewerPool::new(model))));
}
struct PooledReviewer(ReviewerPool<ProviderReviewModel>);
impl extension_api::ApprovalReviewContributor for PooledReviewer {
    fn review(
        &self,
        request: &ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<action_policy::ClassifierAssessment, extension_api::ExtensionError> {
        use action_policy::ActionClassifier;
        self.0
            .classify(request, cancellation)
            .map_err(|error| extension_api::ExtensionError::new(error.to_string()))
    }
}

/// Captures the isolated reviewer and its revision identity for a host policy.
pub fn reviewer(model: ProviderReviewModel) -> extension_api::ApprovalReviewer {
    let identity = format!("{}/{}", model.model().provider, model.model().model);
    let mut builder = extension_api::ExtensionRegistryBuilder::new();
    install(&mut builder, model);
    extension_api::ApprovalReviewer::Configured {
        identity,
        registry: Arc::new(builder.build()),
    }
}
