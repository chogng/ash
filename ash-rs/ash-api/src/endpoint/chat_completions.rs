use crate::ApiEndpoint;
use crate::ApiError;
use crate::ApiStreamSink;
use crate::ContentPart;
use crate::ImageDetail;
use crate::InputItem;
use crate::Message;
use crate::MessageRole;
use crate::ModelRequest;
use crate::ModelResponse;
use crate::ModelUsage;
use crate::OutputItem;
use crate::ReasoningEffort;
use crate::StopReason;
use crate::ToolCall;
use crate::ToolCallId;
use crate::ToolChoice;
use crate::ToolDefinition;
use crate::ToolName;
use ash_async_utils::CancellationToken;
use ash_client::ClientError;
use ash_client::ClientRequest;
use ash_client::OperationClient;
use ash_client::OperationStreamSink;
use ash_client::ResolvedApiTarget;
use ash_client::SseDecoder;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

const MAX_STREAM_EVENT_BYTES: usize = 1024 * 1024;

pub(crate) fn complete(
    endpoint: ApiEndpoint,
    target: &ResolvedApiTarget,
    model: &str,
    request: &ModelRequest,
    client: &dyn OperationClient,
    cancellation: &CancellationToken,
) -> Result<ModelResponse, ApiError> {
    let response = crate::requests::post_json(
        client,
        target,
        endpoint,
        request,
        build_request(model, request)?,
        cancellation,
    )?;
    parse_response(endpoint, response)
}

pub(crate) fn stream(
    endpoint: ApiEndpoint,
    target: &ResolvedApiTarget,
    model: &str,
    request: &ModelRequest,
    client: &dyn OperationClient,
    cancellation: &CancellationToken,
    sink: &mut dyn ApiStreamSink,
) -> Result<ModelResponse, ApiError> {
    let Value::Object(mut body) = build_request(model, request)? else {
        unreachable!("Chat Completions request builders always return an object");
    };
    body.insert("stream".into(), Value::Bool(true));
    body.insert("stream_options".into(), json!({"include_usage": true}));
    let body = serde_json::to_vec(&Value::Object(body))
        .map_err(|error| ApiError::InvalidRequest(format!("failed to encode API JSON: {error}")))?;
    let operation = ClientRequest::new(
        ash_http_client::HttpMethod::Post,
        target.endpoint(endpoint.relative_path())?,
        crate::headers::build(
            endpoint.headers(target, request)?,
            crate::headers::ResponseFormat::EventStream,
        )?,
        body,
        target.retry_policy,
    )?;
    let mut body_sink = OpenAiChatCompletionsBodySink {
        framing: SseDecoder::new(MAX_STREAM_EVENT_BYTES)?,
        events: crate::OpenAiChatCompletionsSseDecoder::new(),
        sink,
        failure: None,
    };
    let transport =
        client.execute_streaming_with_cancellation(&operation, cancellation, &mut body_sink);
    if let Ok(response) = &transport
        && !response.is_success()
    {
        return Err(crate::requests::response_error(response));
    }
    if let Some(error) = body_sink.failure.take() {
        return Err(error);
    }
    transport?;
    let OpenAiChatCompletionsBodySink {
        framing,
        events,
        sink: _,
        failure: _,
    } = body_sink;
    framing.finish()?;
    parse_response(endpoint, events.finish_response()?)
}

struct OpenAiChatCompletionsBodySink<'a> {
    framing: SseDecoder,
    events: crate::OpenAiChatCompletionsSseDecoder,
    sink: &'a mut dyn ApiStreamSink,
    failure: Option<ApiError>,
}

impl OperationStreamSink for OpenAiChatCompletionsBodySink<'_> {
    fn emit(&mut self, chunk: &[u8]) -> Result<(), ClientError> {
        let result = self.decode(chunk);
        if let Err(error) = &result {
            self.failure = Some(error.clone());
        }
        result.map_err(|error| ClientError::InvalidResponse(error.to_string()))
    }
}

impl OpenAiChatCompletionsBodySink<'_> {
    fn decode(&mut self, chunk: &[u8]) -> Result<(), ApiError> {
        for frame in self.framing.push(chunk)? {
            for event in self.events.decode(&frame)? {
                self.sink.emit(event)?;
            }
        }
        Ok(())
    }
}

pub(crate) fn build_request(model: &str, request: &ModelRequest) -> Result<Value, ApiError> {
    crate::requests::openai_tools::validate_tools(&request.tools)?;
    crate::requests::require_materialized_attachments(request)?;
    for item in &request.input {
        let (content, user_message) = match item {
            InputItem::Reasoning(_) => {
                return Err(ApiError::InvalidRequest(
                    "Responses reasoning requires a Responses endpoint".into(),
                ));
            }
            InputItem::Message(message) => (&message.content, message.role == MessageRole::User),
            InputItem::ToolResult(result) => (&result.content, false),
        };
        for part in content {
            if let ContentPart::AudioUrl { url } = part {
                let audio = audio::load_data_url(url)
                    .map_err(|error| ApiError::InvalidRequest(error.to_string()))?;
                if !user_message
                    || !matches!(
                        audio.format(),
                        audio::AudioFormat::Wav | audio::AudioFormat::Mp3
                    )
                {
                    return Err(ApiError::InvalidRequest(
                        "Chat Completions accepts WAV or MP3 audio in user messages only".into(),
                    ));
                }
            }
        }
    }
    let mut messages = Vec::new();
    if let Some(instructions) = &request.instructions {
        messages.push(json!({"role": "system", "content": instructions}));
    }
    for item in &request.input {
        match item {
            InputItem::Reasoning(_) => {
                return Err(ApiError::InvalidRequest(
                    "Responses reasoning requires a Responses endpoint".into(),
                ));
            }
            InputItem::Message(message) => messages.push(convert_message(message)),
            InputItem::ToolResult(result) => messages.push(json!({
                "role": "tool",
                "tool_call_id": result.call_id,
                "content": content_text(&result.content),
            })),
        }
    }
    let mut body = Map::from_iter([
        ("model".into(), Value::String(model.into())),
        ("messages".into(), Value::Array(messages)),
        ("stream".into(), Value::Bool(false)),
    ]);
    if !request.tools.is_empty() {
        body.insert(
            "tools".into(),
            Value::Array(request.tools.iter().map(convert_tool).collect()),
        );
        body.insert(
            "tool_choice".into(),
            convert_completions_tool_choice(&request.tool_choice),
        );
        body.insert(
            "parallel_tool_calls".into(),
            Value::Bool(request.parallel_tool_calls),
        );
    }
    if let Some(reasoning) = &request.reasoning {
        body.insert(
            "reasoning_effort".into(),
            json!(reasoning_effort(reasoning.effort)),
        );
    }
    if let Some(max_output_tokens) = request.max_output_tokens {
        body.insert("max_tokens".into(), json!(max_output_tokens));
    }
    if let Some(temperature) = request.temperature {
        body.insert("temperature".into(), json!(temperature));
    }
    Ok(Value::Object(body))
}

fn convert_message(message: &Message) -> Value {
    let mut converted = Map::from_iter([
        ("role".into(), json!(role(message.role))),
        ("content".into(), convert_content(&message.content)),
    ]);
    if !message.tool_calls.is_empty() {
        converted.insert(
            "tool_calls".into(),
            Value::Array(
                message
                    .tool_calls
                    .iter()
                    .map(|call| {
                        json!({
                            "id": call.id,
                            "type": "function",
                            "function": {
                                "name": call.name,
                                "arguments": call.arguments.to_string(),
                            },
                        })
                    })
                    .collect(),
            ),
        );
    }
    Value::Object(converted)
}

fn convert_content(content: &[ContentPart]) -> Value {
    if content.len() == 1
        && let ContentPart::Text(text) = &content[0]
    {
        return Value::String(text.clone());
    }
    Value::Array(
        content
            .iter()
            .map(|part| match part {
                ContentPart::Text(text) => json!({"type": "text", "text": text}),
                ContentPart::ImageAttachment { .. } | ContentPart::AudioAttachment { .. } => {
                    unreachable!(
                        "durable image attachments must be materialized before API encoding"
                    )
                }
                ContentPart::AudioUrl { url } => {
                    let (metadata, data) = url.split_once(',').expect("audio data URL was validated");
                    let mime = metadata.strip_prefix("data:").and_then(|value| value.strip_suffix(";base64"))
                        .expect("audio data URL metadata was validated");
                    let format = match audio::AudioFormat::from_mime_type(mime).expect("audio format was validated") {
                        audio::AudioFormat::Wav => "wav",
                        audio::AudioFormat::Mp3 => "mp3",
                        _ => unreachable!("Chat Completions audio format was validated"),
                    };
                    json!({"type": "input_audio", "input_audio": { "data": data, "format": format }})
                }
                ContentPart::ImageUrl { url, detail } => json!({
                    "type": "image_url",
                    "image_url": {
                        "url": url,
                        "detail": image_detail(*detail),
                    },
                }),
            })
            .collect(),
    )
}

fn convert_tool(tool: &ToolDefinition) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.parameters,
            "strict": tool.strict,
        },
    })
}

fn convert_completions_tool_choice(choice: &ToolChoice) -> Value {
    match choice {
        ToolChoice::Auto => json!("auto"),
        ToolChoice::None => json!("none"),
        ToolChoice::Required => json!("required"),
        ToolChoice::Function(name) => json!({
            "type": "function",
            "function": {"name": name},
        }),
    }
}

fn parse_response(endpoint: ApiEndpoint, response: Value) -> Result<ModelResponse, ApiError> {
    let choice = response
        .pointer("/choices/0")
        .ok_or_else(|| ApiError::InvalidResponse("missing first completion choice".into()))?;
    let message = choice
        .get("message")
        .ok_or_else(|| ApiError::InvalidResponse("completion choice is missing message".into()))?;
    let mut output = Vec::new();
    if let Some(content) = message.get("content") {
        match content {
            Value::String(text) if !text.is_empty() => output.push(OutputItem::Text(text.clone())),
            Value::Array(parts) => {
                for part in parts {
                    if let Some(text) = part.get("text").and_then(Value::as_str)
                        && !text.is_empty()
                    {
                        output.push(OutputItem::Text(text.into()));
                    }
                }
            }
            _ => {}
        }
    }
    if let Some(reasoning) = message
        .get("reasoning_content")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    {
        output.push(OutputItem::Reasoning(reasoning.into()));
    }
    if let Some(refusal) = message
        .get("refusal")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    {
        output.push(OutputItem::Refusal(refusal.into()));
    }
    for call in message
        .get("tool_calls")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        output.push(OutputItem::ToolCall(ToolCall {
            id: ToolCallId::new(required_string(call, "id")?)
                .map_err(|error| ApiError::InvalidResponse(error.to_string()))?,
            name: ToolName::new(
                call.pointer("/function/name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ApiError::InvalidResponse("tool call is missing function name".into())
                    })?,
            )
            .map_err(|error| ApiError::InvalidResponse(error.to_string()))?,
            arguments: parse_arguments(call.pointer("/function/arguments"))?,
        }));
    }
    if output.is_empty() {
        return Err(ApiError::InvalidResponse(
            "completion returned no supported output items".into(),
        ));
    }
    let finish_reason = choice
        .get("finish_reason")
        .and_then(Value::as_str)
        .unwrap_or("stop");
    let stop_reason = if output
        .iter()
        .any(|item| matches!(item, OutputItem::ToolCall(_)))
    {
        StopReason::ToolUse
    } else if output
        .iter()
        .any(|item| matches!(item, OutputItem::Refusal(_)))
    {
        StopReason::Refusal
    } else {
        match finish_reason {
            "stop" => StopReason::Completed,
            "length" => StopReason::MaxOutputTokens,
            other => StopReason::Other(other.into()),
        }
    };
    Ok(ModelResponse {
        output,
        usage: parse_usage(endpoint, response.get("usage")),
        billing: crate::requests::parse_response_billing(&response)?,
        stop_reason,
    })
}

fn parse_usage(endpoint: ApiEndpoint, usage: Option<&Value>) -> Option<ModelUsage> {
    let usage = usage?;
    let cached_input_tokens = match endpoint {
        ApiEndpoint::DeepSeekChatCompletions => {
            usage.get("prompt_cache_hit_tokens").and_then(Value::as_u64)
        }
        ApiEndpoint::OpenAiChatCompletions | ApiEndpoint::XaiChatCompletions => usage
            .pointer("/prompt_tokens_details/cached_tokens")
            .and_then(Value::as_u64),
        ApiEndpoint::OpenAiResponses
        | ApiEndpoint::ChatGptResponses
        | ApiEndpoint::XaiSubscriptionResponses
        | ApiEndpoint::AnthropicMessages
        | ApiEndpoint::AnthropicMessagesAtBase => {
            unreachable!("Chat Completions parser requires a Chat Completions endpoint")
        }
    };
    Some(ModelUsage {
        input_tokens: usage.get("prompt_tokens").and_then(Value::as_u64),
        output_tokens: usage.get("completion_tokens").and_then(Value::as_u64),
        cached_input_tokens,
        cache_write_input_tokens: None,
        reasoning_tokens: usage
            .pointer("/completion_tokens_details/reasoning_tokens")
            .and_then(Value::as_u64),
    })
}

fn parse_arguments(arguments: Option<&Value>) -> Result<Value, ApiError> {
    match arguments {
        Some(Value::String(arguments)) => serde_json::from_str(arguments)
            .map_err(|_| ApiError::InvalidResponse("tool arguments are invalid JSON".into())),
        Some(arguments) => Ok(arguments.clone()),
        None => Ok(json!({})),
    }
}

fn required_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, ApiError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::InvalidResponse(format!("tool call is missing {field}")))
}

fn content_text(content: &[ContentPart]) -> String {
    content
        .iter()
        .filter_map(|part| match part {
            ContentPart::Text(text) => Some(text.as_str()),
            ContentPart::ImageAttachment { .. }
            | ContentPart::AudioAttachment { .. }
            | ContentPart::AudioUrl { .. } => None,
            ContentPart::ImageUrl { .. } => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn role(role: MessageRole) -> &'static str {
    match role {
        MessageRole::System => "system",
        MessageRole::Developer => "developer",
        MessageRole::User => "user",
        MessageRole::Assistant => "assistant",
    }
}

fn image_detail(detail: ImageDetail) -> &'static str {
    match detail {
        ImageDetail::Auto => "auto",
        ImageDetail::Low => "low",
        ImageDetail::High => "high",
        ImageDetail::Original => "auto",
    }
}

fn reasoning_effort(effort: ReasoningEffort) -> &'static str {
    match effort {
        ReasoningEffort::None => "none",
        ReasoningEffort::Minimal => "minimal",
        ReasoningEffort::Low => "low",
        ReasoningEffort::Medium => "medium",
        ReasoningEffort::High => "high",
        ReasoningEffort::ExtraHigh => "xhigh",
        ReasoningEffort::Max => "max",
    }
}

pub(super) fn path() -> &'static str {
    "chat/completions"
}
pub(super) fn headers(
    endpoint: ApiEndpoint,
    request: &ModelRequest,
    headers: &mut Vec<ash_http_client::HttpHeader>,
) -> Result<(), ApiError> {
    if endpoint == ApiEndpoint::XaiChatCompletions
        && let Some(scope) = &request.prompt_cache_key
    {
        crate::headers::insert(headers, "x-grok-conv-id", scope)?;
    }
    Ok(())
}
