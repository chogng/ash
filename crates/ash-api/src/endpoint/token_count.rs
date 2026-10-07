use crate::ApiEndpoint;
use crate::ApiError;
use crate::InputTokenCount;
use crate::ModelRequest;
use crate::endpoint;
use crate::endpoint::validate_request;
use crate::requests;
use ash_async_utils::CancellationSource;
use ash_async_utils::CancellationToken;
use ash_client::OperationClient;
use ash_client::ResolvedApiTarget;

/// A concrete provider preflight endpoint that measures one canonical model input.
///
/// Unlike [`ApiEndpoint`], these endpoints do not invoke a model. Implementations encode the
/// provider's documented token-count request and return only the provider-reported input count;
/// callers remain responsible for declaring accuracy and conservative budget margins.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InputTokenCountEndpoint {
    /// OpenAI Responses `POST /responses/input_tokens`.
    OpenAiResponses,
    /// Anthropic Messages `POST /v1/messages/count_tokens`.
    AnthropicMessages,
    /// Gemini native `POST /models/{model}:countTokens`.
    GoogleGenerateContent,
    /// Moonshot `POST /tokenizers/estimate-token-count`.
    KimiChatCompletions,
    /// Z.AI `POST /tokenizer`.
    ZaiChatCompletions,
}

impl InputTokenCountEndpoint {
    /// Measures a canonical request with a fresh compatibility cancellation scope.
    pub fn count_with_client(
        self,
        target: &ResolvedApiTarget,
        model: &str,
        request: &ModelRequest,
        client: &dyn OperationClient,
    ) -> Result<InputTokenCount, ApiError> {
        self.count_with_client_and_cancellation(
            target,
            model,
            request,
            client,
            &CancellationSource::new().token(),
        )
    }

    /// Measures a canonical request while observing one caller-owned cancellation scope.
    pub fn count_with_client_and_cancellation(
        self,
        target: &ResolvedApiTarget,
        model: &str,
        request: &ModelRequest,
        client: &dyn OperationClient,
        cancellation: &CancellationToken,
    ) -> Result<InputTokenCount, ApiError> {
        target.require_purpose(ash_client::RequestPurpose::InputTokenCount)?;
        validate_request(model, request)?;
        match self {
            Self::OpenAiResponses => endpoint::responses::count_input_tokens(
                ApiEndpoint::OpenAiResponses,
                target,
                model,
                request,
                client,
                cancellation,
            ),
            Self::AnthropicMessages => endpoint::anthropic::count_input_tokens(
                ApiEndpoint::AnthropicMessages,
                target,
                model,
                request,
                client,
                cancellation,
            ),
            Self::GoogleGenerateContent => requests::google_count_tokens::count_input_tokens(
                target,
                model,
                request,
                client,
                cancellation,
            ),
            Self::KimiChatCompletions => requests::kimi_estimate_tokens::count_input_tokens(
                target,
                model,
                request,
                client,
                cancellation,
            ),
            Self::ZaiChatCompletions => requests::zai_tokenizer::count_input_tokens(
                target,
                model,
                request,
                client,
                cancellation,
            ),
        }
    }
}
