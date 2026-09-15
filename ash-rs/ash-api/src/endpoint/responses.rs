mod events;
pub use events::ResponsesEventDecoder;

use crate::ApiEndpoint;
use crate::ApiError;
use crate::ApiStreamSink;
use crate::ContentPart;
use crate::ImageDetail;
use crate::InputItem;
use crate::InputTokenCount;
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
use serde_json::{Map, Value, json};

const MAX_STREAM_EVENT_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CacheSupport {
    Automatic,
    Breakpoints,
}

// Block breakpoints are part of the documented GPT-5.6-and-later Responses contract.
fn cache_support(model: &str) -> CacheSupport {
    let Some(version) = model
        .strip_prefix("gpt-")
        .and_then(|name| name.split('-').next())
    else {
        return CacheSupport::Automatic;
    };
    let mut parts = version.split('.');
    let major = parts.next().and_then(|part| part.parse::<u32>().ok());
    let minor = parts
        .next()
        .and_then(|part| part.parse::<u32>().ok())
        .unwrap_or(0);
    if parts.next().is_none()
        && (major.is_some_and(|major| major > 5) || major == Some(5) && minor >= 6)
    {
        CacheSupport::Breakpoints
    } else {
        CacheSupport::Automatic
    }
}

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
        build_request(endpoint, model, request)?,
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
    let Value::Object(mut body) = build_request(endpoint, model, request)? else {
        unreachable!("Responses request builders always return an object");
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
    let mut body_sink = OpenAiResponseBodySink {
        framing: SseDecoder::new(MAX_STREAM_EVENT_BYTES)?,
        events: crate::ResponsesEventDecoder::new(),
        sink,
        failure: None,
    };
    let response =
        client.execute_streaming_with_cancellation(&operation, cancellation, &mut body_sink);
    if let Some(error) = body_sink.failure.take() {
        return Err(error);
    }
    let response = response?;
    if !response.is_success() {
        return Err(crate::requests::response_error(&response));
    }
    let OpenAiResponseBodySink {
        framing,
        events,
        sink: _,
        failure: _,
    } = body_sink;
    framing.finish()?;
    parse_response(events.finish_response()?)
}

struct OpenAiResponseBodySink<'a> {
    framing: SseDecoder,
    events: crate::ResponsesEventDecoder,
    sink: &'a mut dyn ApiStreamSink,
    failure: Option<ApiError>,
}

impl OperationStreamSink for OpenAiResponseBodySink<'_> {
    fn emit(&mut self, chunk: &[u8]) -> Result<(), ClientError> {
        let result = self.decode(chunk);
        if let Err(error) = &result {
            self.failure = Some(error.clone());
        }
        result.map_err(|error| ClientError::InvalidResponse(error.to_string()))
    }
}

impl OpenAiResponseBodySink<'_> {
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
    let response = crate::requests::post_json_to_path(
        client,
        target,
        "responses/input_tokens",
        endpoint.headers(target, request)?,
        build_count_request(model, request)?,
        cancellation,
    )?;
    let input_tokens = response
        .get("input_tokens")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            ApiError::InvalidResponse("Responses input-token count is missing input_tokens".into())
        })?;
    Ok(InputTokenCount::new(input_tokens))
}

fn build_count_request(model: &str, request: &ModelRequest) -> Result<Value, ApiError> {
    let Value::Object(mut body) = build_request(ApiEndpoint::OpenAiResponses, model, request)?
    else {
        unreachable!("Responses request builders always return an object");
    };
    for field in [
        "stream",
        "store",
        "include",
        "max_output_tokens",
        "temperature",
        "prompt_cache_key",
    ] {
        body.remove(field);
    }
    if let Some(Value::Array(input)) = body.get_mut("input") {
        for item in input {
            for field in ["content", "output"] {
                if let Some(Value::Array(parts)) = item.get_mut(field) {
                    for part in parts {
                        if let Some(part) = part.as_object_mut() {
                            part.remove("prompt_cache_breakpoint");
                        }
                    }
                }
            }
        }
    }
    Ok(Value::Object(body))
}

pub(super) fn build_request(
    endpoint: ApiEndpoint,
    model: &str,
    request: &ModelRequest,
) -> Result<Value, ApiError> {
    crate::requests::openai_tools::validate_tools(&request.tools)?;
    crate::requests::require_materialized_attachments(request)?;
    for item in &request.input {
        let (content, allowed_role) = match item {
            InputItem::Message(message) => (&message.content, message.role == MessageRole::User),
            InputItem::ToolResult(result) => (&result.content, true),
        };
        if content
            .iter()
            .any(|part| matches!(part, ContentPart::AudioUrl { .. }))
            && (endpoint != ApiEndpoint::ChatGptResponses || !allowed_role)
        {
            return Err(ApiError::InvalidRequest("audio in Responses requires the ChatGPT audio input contract and a user message or tool result; use Chat Completions for API audio models".into()));
        }
    }
    let mut body = Map::from_iter([
        ("model".into(), Value::String(model.into())),
        (
            "input".into(),
            Value::Array(convert_input(
                &request.input,
                cache_support(model),
                if endpoint == ApiEndpoint::ChatGptResponses {
                    None
                } else {
                    request.prompt_cache_prefix_end
                },
            )?),
        ),
        ("stream".into(), Value::Bool(false)),
        ("store".into(), Value::Bool(false)),
    ]);
    if let Some(instructions) = &request.instructions {
        body.insert("instructions".into(), Value::String(instructions.clone()));
    }
    if !request.tools.is_empty() {
        body.insert(
            "tools".into(),
            Value::Array(request.tools.iter().map(convert_tool).collect()),
        );
        body.insert(
            "tool_choice".into(),
            convert_responses_tool_choice(&request.tool_choice),
        );
        body.insert(
            "parallel_tool_calls".into(),
            Value::Bool(request.parallel_tool_calls),
        );
    }
    if let Some(reasoning) = &request.reasoning {
        body.insert(
            "reasoning".into(),
            json!({
                "effort": reasoning_effort(reasoning.effort),
                "summary": reasoning.summary.then_some("auto"),
            }),
        );
        if reasoning.summary {
            body.insert("include".into(), json!(["reasoning.encrypted_content"]));
        }
    }
    if let Some(max_output_tokens) = request.max_output_tokens {
        body.insert("max_output_tokens".into(), json!(max_output_tokens));
    }
    if let Some(temperature) = request.temperature {
        body.insert("temperature".into(), json!(temperature));
    }
    if let Some(prompt_cache_key) = &request.prompt_cache_key {
        body.insert(
            "prompt_cache_key".into(),
            Value::String(prompt_cache_key.clone()),
        );
    }
    Ok(Value::Object(body))
}

fn convert_input(
    input: &[InputItem],
    cache: CacheSupport,
    prefix_end: Option<u32>,
) -> Result<Vec<Value>, ApiError> {
    let mut converted = Vec::new();
    let mut candidates = Vec::new();
    if prefix_end.is_some_and(|end| end as usize >= input.len()) {
        return Err(ApiError::InvalidRequest(
            "prompt cache boundary is outside the input".into(),
        ));
    }
    for (index, item) in input.iter().enumerate() {
        match item {
            InputItem::Message(message) => {
                if !message.content.is_empty() {
                    if message.role != MessageRole::Assistant {
                        candidates.push((
                            index,
                            converted.len(),
                            "content",
                            message.content.len() - 1,
                        ));
                    }
                    converted.push(json!({
                        "role": role(message.role),
                        "content": message
                            .content
                            .iter()
                            .map(|part| convert_content(message.role, part))
                            .collect::<Vec<_>>(),
                    }));
                }
                converted.extend(message.tool_calls.iter().map(|call| {
                    json!({
                        "type": "function_call",
                        "call_id": call.id,
                        "name": call.name,
                        "arguments": call.arguments.to_string(),
                    })
                }));
            }
            InputItem::ToolResult(result) => {
                let output = if cache == CacheSupport::Breakpoints
                    || result
                        .content
                        .iter()
                        .any(|part| !matches!(part, ContentPart::Text(_)))
                {
                    if !result.content.is_empty() {
                        candidates.push((
                            index,
                            converted.len(),
                            "output",
                            result.content.len() - 1,
                        ));
                    }
                    Value::Array(
                        result
                            .content
                            .iter()
                            .map(|part| convert_content(MessageRole::User, part))
                            .collect(),
                    )
                } else {
                    Value::String(content_text(&result.content))
                };
                converted.push(json!({ "type": "function_call_output", "call_id": result.call_id, "output": output }));
            }
        }
    }
    if converted.is_empty() && !input.is_empty() {
        return Err(ApiError::InvalidRequest(
            "input contains no encodable items".into(),
        ));
    }
    if cache == CacheSupport::Breakpoints {
        if let Some(end) = prefix_end {
            if let Some((_, item, field, part)) = candidates
                .into_iter()
                .rev()
                .find(|(index, ..)| *index <= end as usize)
            {
                converted[item][field][part]["prompt_cache_breakpoint"] =
                    json!({ "mode": "explicit" });
            }
        }
    }
    Ok(converted)
}

#[cfg(test)]
#[path = "responses_tests.rs"]
mod tests;

fn convert_content(role: MessageRole, part: &ContentPart) -> Value {
    match part {
        ContentPart::Text(text) => json!({
            "type": if role == MessageRole::Assistant {
                "output_text"
            } else {
                "input_text"
            },
            "text": text,
        }),
        ContentPart::ImageAttachment { .. } | ContentPart::AudioAttachment { .. } => {
            unreachable!("durable image attachments must be materialized before API encoding")
        }
        ContentPart::AudioUrl { url } => json!({"type": "input_audio", "audio_url": url}),
        ContentPart::ImageUrl { url, detail } => json!({
            "type": "input_image",
            "image_url": url,
            "detail": image_detail(*detail),
        }),
    }
}

fn convert_tool(tool: &ToolDefinition) -> Value {
    json!({
        "type": "function",
        "name": tool.name,
        "description": tool.description,
        "parameters": tool.parameters,
        "strict": tool.strict,
    })
}

fn convert_responses_tool_choice(choice: &ToolChoice) -> Value {
    match choice {
        ToolChoice::Auto => json!("auto"),
        ToolChoice::None => json!("none"),
        ToolChoice::Required => json!("required"),
        ToolChoice::Function(name) => json!({"type": "function", "name": name}),
    }
}

pub(crate) fn parse_response(response: Value) -> Result<ModelResponse, ApiError> {
    let mut output = Vec::new();
    for item in response
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        match item.get("type").and_then(Value::as_str) {
            Some("message") => {
                for part in item
                    .get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    match part.get("type").and_then(Value::as_str) {
                        Some("output_text") => push_string(&mut output, part, "text", false),
                        Some("refusal") => push_string(&mut output, part, "refusal", true),
                        _ => {}
                    }
                }
            }
            Some("function_call") => output.push(OutputItem::ToolCall(ToolCall {
                id: ToolCallId::new(required_string(item, "call_id")?)
                    .map_err(|error| ApiError::InvalidResponse(error.to_string()))?,
                name: ToolName::new(required_string(item, "name")?)
                    .map_err(|error| ApiError::InvalidResponse(error.to_string()))?,
                arguments: parse_arguments(item.get("arguments"))?,
            })),
            Some("reasoning") => {
                let text = item
                    .get("summary")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|part| part.get("text").and_then(Value::as_str))
                    .collect::<String>();
                if !text.is_empty() {
                    output.push(OutputItem::Reasoning(text));
                }
            }
            _ => {}
        }
    }
    if output.is_empty() {
        return Err(ApiError::InvalidResponse(
            "Responses API returned no supported output items".into(),
        ));
    }
    let status = response
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("completed");
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
        match status {
            "completed" => StopReason::Completed,
            "incomplete"
                if response
                    .pointer("/incomplete_details/reason")
                    .and_then(Value::as_str)
                    == Some("max_output_tokens") =>
            {
                StopReason::MaxOutputTokens
            }
            other => StopReason::Other(other.into()),
        }
    };
    Ok(ModelResponse {
        output,
        usage: parse_usage(response.get("usage")),
        billing: crate::requests::parse_response_billing(&response)?,
        stop_reason,
    })
}

pub(super) fn parse_usage(usage: Option<&Value>) -> Option<ModelUsage> {
    let usage = usage?;
    Some(ModelUsage {
        input_tokens: usage.get("input_tokens").and_then(Value::as_u64),
        output_tokens: usage.get("output_tokens").and_then(Value::as_u64),
        cached_input_tokens: usage
            .pointer("/input_tokens_details/cached_tokens")
            .and_then(Value::as_u64),
        cache_write_input_tokens: usage
            .pointer("/input_tokens_details/cache_write_tokens")
            .and_then(Value::as_u64),
        reasoning_tokens: usage
            .pointer("/output_tokens_details/reasoning_tokens")
            .and_then(Value::as_u64),
    })
}

fn push_string(output: &mut Vec<OutputItem>, value: &Value, field: &str, refusal: bool) {
    if let Some(text) = value.get(field).and_then(Value::as_str)
        && !text.is_empty()
    {
        output.push(if refusal {
            OutputItem::Refusal(text.into())
        } else {
            OutputItem::Text(text.into())
        });
    }
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
        .ok_or_else(|| ApiError::InvalidResponse(format!("function call is missing {field}")))
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
        ImageDetail::Original => "original",
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
    "responses"
}
pub(super) fn headers(
    endpoint: ApiEndpoint,
    request: &ModelRequest,
    headers: &mut Vec<ash_http_client::HttpHeader>,
) -> Result<(), ApiError> {
    if endpoint == ApiEndpoint::ChatGptResponses
        && let Some(scope) = &request.prompt_cache_key
    {
        crate::headers::insert(headers, "session-id", scope)?;
    }
    Ok(())
}
