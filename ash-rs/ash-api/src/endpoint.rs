//! Endpoint dispatch; each endpoint module owns its path, protocol headers, and fields.

pub(crate) mod anthropic;
pub(crate) mod chat_completions;
pub(crate) mod live;
pub(crate) mod realtime;
pub(crate) mod responses;
pub(crate) mod responses_websocket;
pub(crate) mod semantic;
pub(crate) mod token_count;

use crate::ApiError;
use crate::InputTokenCount;
use crate::ModelRequest;
use crate::ModelResponse;
use crate::ModelStreamEvent;
use ash_async_utils::CancellationSource;
use ash_async_utils::CancellationToken;
use ash_client::OperationClient;
use ash_client::ResolvedApiTarget;
use ash_http_client::HttpHeader;

/// The normalized protocol spoken by an API endpoint family.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApiProtocol {
    /// OpenAI's Responses API request and response schema.
    OpenAiResponses,
    /// The OpenAI Chat Completions-compatible request and response schema.
    OpenAiCompletions,
    /// Anthropic's Messages API request and response schema.
    AnthropicMessages,
}

/// An exact API endpoint profile supported by Ash.
///
/// A caller supplies a resolved base URL and headers. This type then encodes a
/// normalized request and decodes the corresponding response. Profiles that
/// share a request shape remain distinct when their response semantics differ.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApiEndpoint {
    /// An endpoint implementing the OpenAI Responses API.
    OpenAiResponses,
    /// ChatGPT subscription Responses, with Session routing and automatic caching.
    ChatGptResponses,
    /// xAI subscription Responses through the Grok CLI proxy.
    XaiSubscriptionResponses,
    /// An endpoint implementing the OpenAI Chat Completions-compatible API.
    OpenAiChatCompletions,
    /// DeepSeek's Chat Completions endpoint and usage schema.
    DeepSeekChatCompletions,
    /// xAI Chat Completions with conversation cache routing.
    XaiChatCompletions,
    /// An endpoint implementing Anthropic's Messages API.
    AnthropicMessages,
    /// Messages appended to a caller-supplied API base, including any version path.
    AnthropicMessagesAtBase,
}

/// Receives provider-neutral model deltas decoded from one API response stream.
///
/// Implementations should preserve event order and return an error when the
/// invocation consumer has been cancelled or can no longer accept output.
pub trait ApiStreamSink {
    fn emit(&mut self, event: ModelStreamEvent) -> Result<(), ApiError>;
}

impl ApiEndpoint {
    /// Returns the wire protocol implemented by this endpoint family.
    pub fn protocol(self) -> ApiProtocol {
        match self {
            Self::OpenAiResponses | Self::ChatGptResponses | Self::XaiSubscriptionResponses => {
                ApiProtocol::OpenAiResponses
            }
            Self::OpenAiChatCompletions => ApiProtocol::OpenAiCompletions,
            Self::DeepSeekChatCompletions | Self::XaiChatCompletions => {
                ApiProtocol::OpenAiCompletions
            }
            Self::AnthropicMessages | Self::AnthropicMessagesAtBase => {
                ApiProtocol::AnthropicMessages
            }
        }
    }

    pub(crate) fn relative_path(self) -> &'static str {
        match self.protocol() {
            ApiProtocol::OpenAiResponses => responses::path(),
            ApiProtocol::OpenAiCompletions => chat_completions::path(),
            ApiProtocol::AnthropicMessages => anthropic::path(self),
        }
    }

    pub(crate) fn headers(
        self,
        target: &ResolvedApiTarget,
        request: &ModelRequest,
    ) -> Result<Vec<HttpHeader>, ApiError> {
        let mut headers = Vec::new();
        for header in &target.headers {
            crate::headers::insert(&mut headers, header.name(), header.value())?;
        }
        match self.protocol() {
            ApiProtocol::OpenAiResponses => responses::headers(self, request, &mut headers)?,
            ApiProtocol::OpenAiCompletions => {
                chat_completions::headers(self, request, &mut headers)?
            }
            ApiProtocol::AnthropicMessages => anthropic::headers(&mut headers)?,
        }
        Ok(headers)
    }

    /// Completes a normalized request through a supplied operation client.
    ///
    /// The transport only owns HTTP execution. This method owns request and
    /// response codec selection for the endpoint family.
    pub fn complete_with_client(
        self,
        target: &ResolvedApiTarget,
        model: &str,
        request: &ModelRequest,
        client: &dyn OperationClient,
    ) -> Result<ModelResponse, ApiError> {
        self.complete_with_client_and_cancellation(
            target,
            model,
            request,
            client,
            &CancellationSource::new().token(),
        )
    }

    /// Completes a normalized request while observing one caller-owned cancellation scope.
    pub fn complete_with_client_and_cancellation(
        self,
        target: &ResolvedApiTarget,
        model: &str,
        request: &ModelRequest,
        client: &dyn OperationClient,
        cancellation: &CancellationToken,
    ) -> Result<ModelResponse, ApiError> {
        validate_request(model, request)?;
        match self {
            Self::OpenAiResponses | Self::ChatGptResponses | Self::XaiSubscriptionResponses => {
                responses::complete(self, target, model, request, client, cancellation)
            }
            Self::OpenAiChatCompletions
            | Self::DeepSeekChatCompletions
            | Self::XaiChatCompletions => {
                chat_completions::complete(self, target, model, request, client, cancellation)
            }
            Self::AnthropicMessages | Self::AnthropicMessagesAtBase => {
                anthropic::complete(self, target, model, request, client, cancellation)
            }
        }
    }

    /// Streams incremental output and returns the terminal canonical response.
    ///
    /// Every supported endpoint family uses its native wire-stream contract.
    /// The returned response remains authoritative for Tool Calls, usage, and
    /// terminal status.
    pub fn stream_with_client_and_cancellation(
        self,
        target: &ResolvedApiTarget,
        model: &str,
        request: &ModelRequest,
        client: &dyn OperationClient,
        cancellation: &CancellationToken,
        sink: &mut dyn ApiStreamSink,
    ) -> Result<ModelResponse, ApiError> {
        validate_request(model, request)?;
        match self {
            Self::OpenAiResponses | Self::ChatGptResponses | Self::XaiSubscriptionResponses => {
                responses::stream(self, target, model, request, client, cancellation, sink)
            }
            Self::OpenAiChatCompletions
            | Self::DeepSeekChatCompletions
            | Self::XaiChatCompletions => {
                chat_completions::stream(self, target, model, request, client, cancellation, sink)
            }
            Self::AnthropicMessages | Self::AnthropicMessagesAtBase => {
                anthropic::stream(self, target, model, request, client, cancellation, sink)
            }
        }
    }

    /// Counts the input tokens for one normalized request through a supported provider preflight
    /// endpoint.
    pub fn count_input_tokens_with_client(
        self,
        target: &ResolvedApiTarget,
        model: &str,
        request: &ModelRequest,
        client: &dyn OperationClient,
    ) -> Result<InputTokenCount, ApiError> {
        self.count_input_tokens_with_client_and_cancellation(
            target,
            model,
            request,
            client,
            &CancellationSource::new().token(),
        )
    }

    /// Counts input tokens while observing one caller-owned cancellation scope.
    pub fn count_input_tokens_with_client_and_cancellation(
        self,
        target: &ResolvedApiTarget,
        model: &str,
        request: &ModelRequest,
        client: &dyn OperationClient,
        cancellation: &CancellationToken,
    ) -> Result<InputTokenCount, ApiError> {
        validate_request(model, request)?;
        match self {
            Self::ChatGptResponses | Self::XaiSubscriptionResponses => {
                Err(ApiError::InvalidRequest(
                    "Subscription Responses does not expose input-token preflight".into(),
                ))
            }
            Self::OpenAiResponses => {
                responses::count_input_tokens(self, target, model, request, client, cancellation)
            }
            Self::AnthropicMessages | Self::AnthropicMessagesAtBase => {
                anthropic::count_input_tokens(self, target, model, request, client, cancellation)
            }
            Self::OpenAiChatCompletions
            | Self::DeepSeekChatCompletions
            | Self::XaiChatCompletions => Err(ApiError::InvalidRequest(
                "OpenAI Chat Completions does not expose a standard input-token count endpoint"
                    .into(),
            )),
        }
    }
}

pub(crate) fn validate_request(model: &str, request: &ModelRequest) -> Result<(), ApiError> {
    validate_options(model, request)?;
    if request.input.is_empty() {
        return Err(ApiError::InvalidRequest("input must not be empty".into()));
    }
    Ok(())
}

pub(crate) fn validate_options(model: &str, request: &ModelRequest) -> Result<(), ApiError> {
    if model.trim().is_empty() {
        return Err(ApiError::InvalidRequest("model must not be empty".into()));
    }
    if request.max_output_tokens == Some(0) {
        return Err(ApiError::InvalidRequest(
            "maximum output tokens must be greater than zero".into(),
        ));
    }
    Ok(())
}
