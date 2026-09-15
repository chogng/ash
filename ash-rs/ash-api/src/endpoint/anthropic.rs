use crate::ApiEndpoint;
use crate::ApiError;
use crate::ApiStreamSink;
use crate::ContentPart;
use crate::InputItem;
use crate::InputTokenCount;
use crate::Message;
use crate::MessageRole;
use crate::ModelRequest;
use crate::ModelResponse;
use crate::ModelUsage;
use crate::OutputItem;
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
use serde_json::{Map, Value, json};

const MAX_STREAM_EVENT_BYTES: usize = 1024 * 1024;
const EPHEMERAL_CACHE_CONTROL: &str = "ephemeral";

pub(crate) fn complete(
    endpoint: ApiEndpoint,
    target: &ResolvedApiTarget,
    model: &str,
    request: &ModelRequest,
    client: &dyn OperationClient,
    cancellation: &CancellationToken,
) -> Result<ModelResponse, ApiError> {
    if request.reasoning.is_some() {
        return Err(ApiError::InvalidRequest(
            "Anthropic reasoning requires a provider-specific thinking configuration".into(),
        ));
    }
    let response = crate::requests::post_json(
        client,
        target,
        endpoint,
        request,
        build_request(model, request)?,
        cancellation,
    )?;
    parse_response(response)
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
    if request.reasoning.is_some() {
        return Err(ApiError::InvalidRequest(
            "Anthropic reasoning requires a provider-specific thinking configuration".into(),
        ));
    }
    let Value::Object(mut body) = build_request(model, request)? else {
        unreachable!("Anthropic request builders always return an object");
    };
    body.insert("stream".into(), Value::Bool(true));
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
    let mut body_sink = AnthropicMessageBodySink {
        framing: SseDecoder::new(MAX_STREAM_EVENT_BYTES)?,
        events: crate::AnthropicMessagesSseDecoder::new(),
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
    let AnthropicMessageBodySink {
        framing,
        events,
        sink: _,
        failure: _,
    } = body_sink;
    framing.finish()?;
    parse_response(events.finish_response()?)
}

struct AnthropicMessageBodySink<'a> {
    framing: SseDecoder,
    events: crate::AnthropicMessagesSseDecoder,
    sink: &'a mut dyn ApiStreamSink,
    failure: Option<ApiError>,
}

impl OperationStreamSink for AnthropicMessageBodySink<'_> {
    fn emit(&mut self, chunk: &[u8]) -> Result<(), ClientError> {
        let result = self.decode(chunk);
        if let Err(error) = &result {
            self.failure = Some(error.clone());
        }
        result.map_err(|error| ClientError::InvalidResponse(error.to_string()))
    }
}

impl AnthropicMessageBodySink<'_> {
    fn decode(&mut self, chunk: &[u8]) -> Result<(), ApiError> {
        for frame in self.framing.push(chunk)? {
            for event in self.events.decode(&frame)? {
                self.sink.emit(event)?;
            }
        }
        Ok(())
    }
}

pub(crate) fn count_input_tokens(
    endpoint: ApiEndpoint,
    target: &ResolvedApiTarget,
    model: &str,
    request: &ModelRequest,
    client: &dyn OperationClient,
    cancellation: &CancellationToken,
) -> Result<InputTokenCount, ApiError> {
    if request.reasoning.is_some() {
        return Err(ApiError::InvalidRequest(
            "Anthropic reasoning requires a provider-specific thinking configuration".into(),
        ));
    }
    let response = crate::requests::post_json_to_path(
        client,
        target,
        &format!("{}/count_tokens", endpoint.relative_path()),
        endpoint.headers(target, request)?,
        build_count_request(model, request)?,
        cancellation,
    )?;
    let input_tokens = response
        .get("input_tokens")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            ApiError::InvalidResponse("Anthropic token count is missing input_tokens".into())
        })?;
    Ok(InputTokenCount::new(input_tokens))
}

fn build_count_request(model: &str, request: &ModelRequest) -> Result<Value, ApiError> {
    let Value::Object(mut body) = build_request(model, request)? else {
        unreachable!("Anthropic request builders always return an object");
    };
    for field in ["max_tokens", "temperature"] {
        body.remove(field);
    }
    Ok(Value::Object(body))
}

fn build_request(model: &str, request: &ModelRequest) -> Result<Value, ApiError> {
    crate::requests::require_materialized_attachments(request)?;
    for item in &request.input {
        let content = match item {
            InputItem::Message(message) => &message.content,
            InputItem::ToolResult(result) => &result.content,
        };
        if content
            .iter()
            .any(|part| matches!(part, ContentPart::AudioUrl { .. }))
        {
            return Err(ApiError::InvalidRequest(
                "Anthropic Messages does not support audio attachments".into(),
            ));
        }
    }
    let mut messages = Vec::new();
    for item in &request.input {
        match item {
            InputItem::Message(message) => messages.push(convert_message(message)?),
            InputItem::ToolResult(result) => messages.push(json!({
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": result.call_id,
                    "content": content_text(&result.content),
                    "is_error": result.is_error,
                }],
            })),
        }
    }
    mark_message_cache_breakpoint(&mut messages, request.prompt_cache_prefix_end)?;
    let mut body = Map::from_iter([
        ("model".into(), Value::String(model.into())),
        ("messages".into(), Value::Array(messages)),
        (
            "max_tokens".into(),
            json!(request.max_output_tokens.unwrap_or(4096)),
        ),
    ]);
    if let Some(instructions) = &request.instructions {
        body.insert(
            "system".into(),
            json!([{
                "type": "text",
                "text": instructions,
                "cache_control": ephemeral_cache_control(),
            }]),
        );
    }
    if !request.tools.is_empty() {
        let mut tools = request.tools.iter().map(convert_tool).collect::<Vec<_>>();
        if let Some(last) = tools.last_mut() {
            mark_cache_control(last);
        }
        body.insert("tools".into(), Value::Array(tools));
        body.insert(
            "tool_choice".into(),
            convert_anthropic_tool_choice(&request.tool_choice),
        );
    }
    if let Some(temperature) = request.temperature {
        body.insert("temperature".into(), json!(temperature));
    }
    Ok(Value::Object(body))
}

fn mark_message_cache_breakpoint(
    messages: &mut [Value],
    prefix_end: Option<u32>,
) -> Result<(), ApiError> {
    let Some(prefix_end) = prefix_end else {
        return Ok(());
    };
    let message_index = usize::try_from(prefix_end)
        .map_err(|_| ApiError::InvalidRequest("prompt cache prefix index exceeds usize".into()))?;
    let Some(message) = messages.get_mut(message_index) else {
        return Err(ApiError::InvalidRequest(format!(
            "prompt cache prefix index {prefix_end} is outside the model input"
        )));
    };
    let Some(content) = message.get_mut("content").and_then(Value::as_array_mut) else {
        return Err(ApiError::InvalidRequest(
            "prompt cache prefix must end at a message with content".into(),
        ));
    };
    let Some(last) = content.last_mut() else {
        return Ok(());
    };
    mark_cache_control(last);
    Ok(())
}

fn mark_cache_control(value: &mut Value) {
    if let Some(object) = value.as_object_mut() {
        object.insert("cache_control".into(), ephemeral_cache_control());
    }
}

fn ephemeral_cache_control() -> Value {
    json!({"type": EPHEMERAL_CACHE_CONTROL})
}

fn convert_message(message: &Message) -> Result<Value, ApiError> {
    let role = match message.role {
        MessageRole::User => "user",
        MessageRole::Assistant => "assistant",
        MessageRole::System | MessageRole::Developer => {
            return Err(ApiError::InvalidRequest(
                "Anthropic system instructions belong in ModelRequest.instructions".into(),
            ));
        }
    };
    let mut content = message
        .content
        .iter()
        .map(convert_content)
        .collect::<Result<Vec<_>, _>>()?;
    content.extend(message.tool_calls.iter().map(|call| {
        json!({
            "type": "tool_use",
            "id": call.id,
            "name": call.name,
            "input": call.arguments,
        })
    }));
    Ok(json!({"role": role, "content": content}))
}

fn convert_content(content: &ContentPart) -> Result<Value, ApiError> {
    match content {
        ContentPart::Text(text) => Ok(json!({"type": "text", "text": text})),
        ContentPart::AudioAttachment { .. } | ContentPart::AudioUrl { .. } => {
            Err(ApiError::InvalidRequest(
                "Anthropic Messages does not support audio attachments".into(),
            ))
        }
        ContentPart::ImageAttachment { .. } => {
            unreachable!("durable image attachments must be materialized before API encoding")
        }
        ContentPart::ImageUrl { url, .. } => convert_image(url),
    }
}

fn convert_image(url: &str) -> Result<Value, ApiError> {
    if url.starts_with("https://") || url.starts_with("http://") {
        return Ok(json!({
            "type": "image",
            "source": {
                "type": "url",
                "url": url,
            },
        }));
    }

    let Some((header, data)) = url.split_once(',') else {
        return Err(invalid_image());
    };
    let Some(media_type) = header
        .strip_prefix("data:")
        .and_then(|header| header.strip_suffix(";base64"))
    else {
        return Err(invalid_image());
    };
    if data.is_empty()
        || !matches!(
            media_type,
            "image/png" | "image/jpeg" | "image/gif" | "image/webp"
        )
    {
        return Err(invalid_image());
    }

    Ok(json!({
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": media_type,
            "data": data,
        },
    }))
}

fn invalid_image() -> ApiError {
    ApiError::InvalidRequest(
        "Anthropic image input must be an HTTP(S) URL or a supported base64 data URL".into(),
    )
}

fn convert_tool(tool: &ToolDefinition) -> Value {
    json!({
        "name": tool.name,
        "description": tool.description,
        "input_schema": tool.parameters,
    })
}

fn convert_anthropic_tool_choice(choice: &ToolChoice) -> Value {
    match choice {
        ToolChoice::Auto => json!({"type": "auto"}),
        ToolChoice::None => json!({"type": "none"}),
        ToolChoice::Required => json!({"type": "any"}),
        ToolChoice::Function(name) => json!({"type": "tool", "name": name}),
    }
}

fn parse_response(response: Value) -> Result<ModelResponse, ApiError> {
    let mut output = Vec::new();
    for item in response
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        match item.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = item.get("text").and_then(Value::as_str)
                    && !text.is_empty()
                {
                    output.push(OutputItem::Text(text.into()));
                }
            }
            Some("thinking") => {
                if let Some(text) = item.get("thinking").and_then(Value::as_str)
                    && !text.is_empty()
                {
                    output.push(OutputItem::Reasoning(text.into()));
                }
            }
            Some("tool_use") => output.push(OutputItem::ToolCall(ToolCall {
                id: ToolCallId::new(required_string(item, "id")?)
                    .map_err(|error| ApiError::InvalidResponse(error.to_string()))?,
                name: ToolName::new(required_string(item, "name")?)
                    .map_err(|error| ApiError::InvalidResponse(error.to_string()))?,
                arguments: item.get("input").cloned().unwrap_or_else(|| json!({})),
            })),
            _ => {}
        }
    }
    if output.is_empty() {
        return Err(ApiError::InvalidResponse(
            "Anthropic returned no supported content blocks".into(),
        ));
    }
    let stop_reason = if output
        .iter()
        .any(|item| matches!(item, OutputItem::ToolCall(_)))
    {
        StopReason::ToolUse
    } else {
        match response
            .get("stop_reason")
            .and_then(Value::as_str)
            .unwrap_or("end_turn")
        {
            "end_turn" | "stop_sequence" => StopReason::Completed,
            "max_tokens" => StopReason::MaxOutputTokens,
            other => StopReason::Other(other.into()),
        }
    };
    Ok(ModelResponse {
        output,
        usage: parse_usage(response.get("usage"))?,
        billing: crate::requests::parse_response_billing(&response)?,
        stop_reason,
    })
}

fn parse_usage(usage: Option<&Value>) -> Result<Option<ModelUsage>, ApiError> {
    let Some(usage) = usage else {
        return Ok(None);
    };
    let uncached = usage.get("input_tokens").and_then(Value::as_u64);
    let cache_read = usage
        .get("cache_read_input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let cache_write = usage
        .get("cache_creation_input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let input_tokens = uncached
        .map(|uncached| {
            uncached
                .checked_add(cache_read)
                .and_then(|total| total.checked_add(cache_write))
                .ok_or_else(|| {
                    ApiError::InvalidResponse("Anthropic usage token count overflowed".into())
                })
        })
        .transpose()?;
    Ok(Some(ModelUsage {
        input_tokens,
        output_tokens: usage.get("output_tokens").and_then(Value::as_u64),
        cached_input_tokens: Some(cache_read),
        cache_write_input_tokens: Some(cache_write),
        reasoning_tokens: usage
            .pointer("/output_tokens_details/thinking_tokens")
            .and_then(Value::as_u64),
    }))
}

fn required_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, ApiError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::InvalidResponse(format!("tool use is missing {field}")))
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

#[cfg(test)]
#[path = "anthropic_tests.rs"]
mod tests;

pub(super) fn path(endpoint: ApiEndpoint) -> &'static str {
    if endpoint == ApiEndpoint::AnthropicMessagesAtBase {
        "messages"
    } else {
        "v1/messages"
    }
}
pub(super) fn headers(headers: &mut Vec<ash_http_client::HttpHeader>) -> Result<(), ApiError> {
    crate::headers::insert(headers, "anthropic-version", "2023-06-01")
}
