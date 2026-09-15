use crate::ApiError;
use crate::ContentPart;
use crate::InputItem;
use crate::InputTokenCount;
use crate::Message;
use crate::MessageRole;
use crate::ModelRequest;
use crate::ToolChoice;
use crate::ToolDefinition;
use ash_async_utils::CancellationToken;
use ash_client::OperationClient;
use ash_client::ResolvedApiTarget;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

pub(crate) fn count_input_tokens(
    target: &ResolvedApiTarget,
    model: &str,
    request: &ModelRequest,
    client: &dyn OperationClient,
    cancellation: &CancellationToken,
) -> Result<InputTokenCount, ApiError> {
    let model = normalized_model(model)?;
    let response = crate::requests::post_json_to_path(
        client,
        target,
        &format!("models/{model}:countTokens"),
        target.headers.clone(),
        build_request(model, request)?,
        cancellation,
    )?;
    let input_tokens = response
        .get("totalTokens")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            ApiError::InvalidResponse("Gemini token count is missing totalTokens".into())
        })?;
    Ok(InputTokenCount::new(input_tokens))
}

fn normalized_model(model: &str) -> Result<&str, ApiError> {
    let model = model.strip_prefix("models/").unwrap_or(model);
    if model.is_empty()
        || !model
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(ApiError::InvalidRequest(
            "Gemini model ID contains unsupported path characters".into(),
        ));
    }
    Ok(model)
}

fn build_request(model: &str, request: &ModelRequest) -> Result<Value, ApiError> {
    crate::requests::require_materialized_attachments(request)?;
    for item in &request.input {
        let (content, user_message) = match item {
            InputItem::Message(message) => (&message.content, message.role == MessageRole::User),
            InputItem::ToolResult(result) => (&result.content, false),
        };
        if !user_message
            && content
                .iter()
                .any(|part| matches!(part, ContentPart::AudioUrl { .. }))
        {
            return Err(ApiError::InvalidRequest(
                "Gemini countTokens accepts audio in user messages only".into(),
            ));
        }
    }
    let mut system_parts = request
        .instructions
        .iter()
        .map(|instructions| json!({"text": instructions}))
        .collect::<Vec<_>>();
    let mut contents = Vec::new();
    for item in &request.input {
        match item {
            InputItem::Message(message)
                if matches!(message.role, MessageRole::System | MessageRole::Developer) =>
            {
                if !message.tool_calls.is_empty() {
                    return Err(ApiError::InvalidRequest(
                        "Gemini system instructions cannot contain tool calls".into(),
                    ));
                }
                system_parts.extend(convert_parts(&message.content)?);
            }
            InputItem::Message(message) => contents.push(convert_message(message)?),
            InputItem::ToolResult(result) => contents.push(json!({
                "role": "user",
                "parts": [{
                    "functionResponse": {
                        "name": result.name,
                        "response": {
                            "output": content_text(&result.content),
                            "isError": result.is_error,
                        },
                    },
                }],
            })),
        }
    }
    if contents.is_empty() {
        return Err(ApiError::InvalidRequest(
            "Gemini countTokens requires at least one non-system content item".into(),
        ));
    }

    let mut generate = Map::from_iter([
        ("model".into(), Value::String(format!("models/{model}"))),
        ("contents".into(), Value::Array(contents)),
    ]);
    if !system_parts.is_empty() {
        generate.insert("systemInstruction".into(), json!({"parts": system_parts}));
    }
    if !request.tools.is_empty() {
        generate.insert("tools".into(), convert_tools(&request.tools));
        generate.insert(
            "toolConfig".into(),
            convert_tool_config(&request.tool_choice),
        );
    }
    Ok(json!({"generateContentRequest": generate}))
}

fn convert_message(message: &Message) -> Result<Value, ApiError> {
    let role = match message.role {
        MessageRole::User => "user",
        MessageRole::Assistant => "model",
        MessageRole::System | MessageRole::Developer => {
            return Err(ApiError::InvalidRequest(
                "Gemini system messages must be converted to systemInstruction".into(),
            ));
        }
    };
    let mut parts = convert_parts(&message.content)?;
    parts.extend(message.tool_calls.iter().map(|call| {
        json!({
            "functionCall": {
                "name": call.name,
                "args": call.arguments,
            },
        })
    }));
    if parts.is_empty() {
        return Err(ApiError::InvalidRequest(
            "Gemini content items must not be empty".into(),
        ));
    }
    Ok(json!({"role": role, "parts": parts}))
}

fn convert_parts(parts: &[ContentPart]) -> Result<Vec<Value>, ApiError> {
    parts
        .iter()
        .map(|part| match part {
            ContentPart::Text(text) => Ok(json!({"text": text})),
            ContentPart::AudioAttachment { .. } => {
                unreachable!("durable audio must be materialized before encoding")
            }
            ContentPart::AudioUrl { url } => {
                let audio = audio::load_data_url(url)
                    .map_err(|error| ApiError::InvalidRequest(error.to_string()))?;
                let data = audio.data_url();
                let (_, payload) = data
                    .split_once(',')
                    .expect("validated audio URL has a payload");
                Ok(json!({"inlineData": {"mimeType": audio.format().mime_type(), "data": payload}}))
            }
            ContentPart::ImageAttachment { .. } => {
                unreachable!("durable image attachments must be materialized before API encoding")
            }
            ContentPart::ImageUrl { url, .. } => convert_inline_image(url),
        })
        .collect()
}

fn convert_inline_image(url: &str) -> Result<Value, ApiError> {
    let Some(data_url) = url.strip_prefix("data:") else {
        return Err(ApiError::InvalidRequest(
            "Gemini countTokens can only map inline data images from canonical image URLs".into(),
        ));
    };
    let Some((metadata, data)) = data_url.split_once(',') else {
        return Err(ApiError::InvalidRequest(
            "Gemini inline image data URL is malformed".into(),
        ));
    };
    let Some(mime_type) = metadata.strip_suffix(";base64") else {
        return Err(ApiError::InvalidRequest(
            "Gemini inline images must use base64 data URLs".into(),
        ));
    };
    if mime_type.is_empty() || data.is_empty() {
        return Err(ApiError::InvalidRequest(
            "Gemini inline image data URL is incomplete".into(),
        ));
    }
    Ok(json!({
        "inlineData": {
            "mimeType": mime_type,
            "data": data,
        },
    }))
}

fn convert_tools(tools: &[ToolDefinition]) -> Value {
    json!([{
        "functionDeclarations": tools
            .iter()
            .map(|tool| json!({
                "name": tool.name,
                "description": tool.description,
                "parametersJsonSchema": tool.parameters,
            }))
            .collect::<Vec<_>>(),
    }])
}

fn convert_tool_config(choice: &ToolChoice) -> Value {
    let function_calling_config = match choice {
        ToolChoice::Auto => json!({"mode": "AUTO"}),
        ToolChoice::None => json!({"mode": "NONE"}),
        ToolChoice::Required => json!({"mode": "ANY"}),
        ToolChoice::Function(name) => json!({
            "mode": "ANY",
            "allowedFunctionNames": [name],
        }),
    };
    json!({"functionCallingConfig": function_calling_config})
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
