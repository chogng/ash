use crate::ApiError;
use crate::InputTokenCount;
use crate::ModelRequest;
use crate::endpoint::chat_completions as openai_chat_completions;
use ash_async_utils::CancellationToken;
use ash_client::OperationClient;
use ash_client::ResolvedApiTarget;
use serde_json::Value;

pub(crate) fn count_input_tokens(
    target: &ResolvedApiTarget,
    model: &str,
    request: &ModelRequest,
    client: &dyn OperationClient,
    cancellation: &CancellationToken,
) -> Result<InputTokenCount, ApiError> {
    let response = crate::requests::post_json_to_path(
        client,
        target,
        "tokenizer",
        target.headers.clone(),
        build_request(model, request)?,
        cancellation,
    )?;
    let input_tokens = response
        .pointer("/usage/total_tokens")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            ApiError::InvalidResponse(
                "Z.AI tokenizer response is missing usage.total_tokens".into(),
            )
        })?;
    Ok(InputTokenCount::new(input_tokens))
}

fn build_request(model: &str, request: &ModelRequest) -> Result<Value, ApiError> {
    let Value::Object(mut body) = openai_chat_completions::build_request(model, request)? else {
        unreachable!("Chat Completions request builders always return an object");
    };
    body.retain(|field, _| matches!(field.as_str(), "model" | "messages" | "tools"));
    if let Some(tools) = body.get_mut("tools").and_then(Value::as_array_mut) {
        for tool in tools {
            if let Some(function) = tool.get_mut("function").and_then(Value::as_object_mut) {
                function.remove("strict");
            }
        }
    }
    Ok(Value::Object(body))
}
