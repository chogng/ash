//! Request and unary-response codecs grouped by API endpoint family.
//!
//! Each codec receives its method, relative path, and protocol-owned headers
//! from `endpoint/`; it only owns JSON/body conversion.

use crate::ContentPart;
use crate::InputItem;
use crate::ModelRequest;
use crate::{ApiEndpoint, ApiError};
use ash_async_utils::CancellationToken;
use ash_client::{ClientRequest, OperationClient, ResolvedApiTarget};
use ash_protocol::ModelId;
use ash_protocol::ModelResponseBilling;
use serde_json::Value;

pub(crate) fn parse_response_billing(
    response: &Value,
) -> Result<Option<ModelResponseBilling>, ApiError> {
    let resolved_model = response
        .get("model")
        .filter(|value| !value.is_null())
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| ApiError::InvalidResponse("response model must be a string".into()))
                .and_then(|model| {
                    ModelId::new(model)
                        .map_err(|error| ApiError::InvalidResponse(error.to_string()))
                })
        })
        .transpose()?;
    let applied_service_tier = response
        .get("service_tier")
        .filter(|value| !value.is_null())
        .map(|value| {
            value.as_str().map(str::to_owned).ok_or_else(|| {
                ApiError::InvalidResponse("response service tier must be a string".into())
            })
        })
        .transpose()?;
    if resolved_model.is_none() && applied_service_tier.is_none() {
        return Ok(None);
    }
    Ok(Some(ModelResponseBilling {
        resolved_model,
        applied_service_tier,
    }))
}

pub(crate) fn post_json(
    client: &dyn OperationClient,
    target: &ResolvedApiTarget,
    endpoint: ApiEndpoint,
    request: &ModelRequest,
    body: Value,
    cancellation: &CancellationToken,
) -> Result<Value, ApiError> {
    post_json_to_path(
        client,
        target,
        endpoint.relative_path(),
        endpoint.headers(target, request)?,
        body,
        cancellation,
    )
}

pub(crate) fn post_json_to_path(
    client: &dyn OperationClient,
    target: &ResolvedApiTarget,
    relative_path: &str,
    headers: Vec<ash_http_client::HttpHeader>,
    body: Value,
    cancellation: &CancellationToken,
) -> Result<Value, ApiError> {
    let body = serde_json::to_vec(&body)
        .map_err(|error| ApiError::InvalidRequest(format!("failed to encode API JSON: {error}")))?;
    let request = ClientRequest::new(
        ash_http_client::HttpMethod::Post,
        target.endpoint(relative_path)?,
        crate::headers::build(headers, crate::headers::ResponseFormat::Json)?,
        body,
        target.retry_policy,
    )?;
    let response = client.execute_with_cancellation(&request, cancellation)?;
    if !response.is_success() {
        return Err(response_error(&response));
    }
    serde_json::from_slice(response.body())
        .map_err(|_| ApiError::InvalidResponse("server returned invalid JSON".into()))
}

pub(crate) fn response_error(response: &ash_client::ClientResponse) -> ApiError {
    match response.status() {
        429 if is_usage_limited(&provider_error_detail(response.body())) => ApiError::UsageLimited,
        429 => ApiError::RateLimited {
            retry_after_ms: response
                .retry_after()
                .and_then(|delay| u64::try_from(delay.as_millis()).ok())
                .map(|delay| delay.min(60_000)),
        },
        status @ (401 | 403 | 500..=599) => ApiError::HttpStatus(status),
        400 => classify_provider_error(response.body(), ProviderErrorFallback::InvalidRequest),
        status => classify_provider_error(response.body(), ProviderErrorFallback::Status(status)),
    }
}

/// Enforces the attachment authority boundary before a provider codec examines content.
///
/// Durable references are intentionally not provider wire values. Core must resolve and validate
/// them into ephemeral media URLs before any public API endpoint can encode a request.
pub(crate) fn require_materialized_attachments(request: &ModelRequest) -> Result<(), ApiError> {
    for content in request.input.iter().flat_map(|item| match item {
        InputItem::Message(message) => message.content.as_slice(),
        InputItem::ToolResult(result) => result.content.as_slice(),
        InputItem::Reasoning(_) => &[],
    }) {
        match content {
            ContentPart::ImageAttachment { .. } | ContentPart::AudioAttachment { .. } => {
                return Err(ApiError::InvalidRequest(
                    "durable attachments must be materialized before API encoding".into(),
                ));
            }
            ContentPart::ImageUrl { url, .. } if !is_provider_image_url(url) => {
                return Err(ApiError::InvalidRequest(
                    "image input must be an inline data URL or an HTTP(S) URL".into(),
                ));
            }
            ContentPart::AudioUrl { url } => {
                audio::load_data_url(url)
                    .map_err(|error| ApiError::InvalidRequest(error.to_string()))?;
            }
            ContentPart::Text(_) | ContentPart::ImageUrl { .. } => {}
        }
    }
    Ok(())
}

fn is_provider_image_url(url: &str) -> bool {
    url.starts_with("https://")
        || url.starts_with("http://")
        || url
            .get(.."data:".len())
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("data:"))
}

pub(crate) fn stream_error(body: &str) -> ApiError {
    classify_provider_error(body.as_bytes(), ProviderErrorFallback::InvalidResponse)
}

#[derive(Clone, Copy)]
enum ProviderErrorFallback {
    InvalidRequest,
    InvalidResponse,
    Status(u16),
}

fn classify_provider_error(body: &[u8], fallback: ProviderErrorFallback) -> ApiError {
    let detail = provider_error_detail(body);
    let normalized = detail.to_ascii_lowercase();
    if is_context_overflow(&normalized) {
        return ApiError::ContextOverflow(detail);
    }
    if is_auth_failure(&normalized) {
        return ApiError::AuthFailed(detail);
    }
    if is_usage_limited(&normalized) {
        return ApiError::UsageLimited;
    }
    if is_overloaded(&normalized) {
        return ApiError::Overloaded;
    }
    if is_invalid_request(&normalized) {
        return ApiError::InvalidRequest(detail);
    }
    match fallback {
        ProviderErrorFallback::InvalidRequest => ApiError::InvalidRequest(detail),
        ProviderErrorFallback::InvalidResponse => ApiError::InvalidResponse(detail),
        ProviderErrorFallback::Status(status) => ApiError::HttpStatus(status),
    }
}

fn provider_error_detail(body: &[u8]) -> String {
    const MAX_PROVIDER_ERROR_BYTES: usize = 4 * 1024;
    let length = body.len().min(MAX_PROVIDER_ERROR_BYTES);
    let mut detail = String::from_utf8_lossy(&body[..length]).into_owned();
    if detail.trim().is_empty() {
        return "provider returned an empty error body".into();
    }
    if body.len() > length {
        detail.push_str(" [truncated]");
    }
    detail
}

fn is_context_overflow(detail: &str) -> bool {
    detail.contains("context_length_exceeded")
        || detail.contains("context window")
        || detail.contains("maximum context length")
        || detail.contains("prompt is too long")
        || detail.contains("too many tokens")
        || (detail.contains("input token")
            && detail.contains("maximum")
            && (detail.contains("exceed") || detail.contains("limit")))
        || (detail.contains("context")
            && (detail.contains("length") || detail.contains("token"))
            && (detail.contains("exceed")
                || detail.contains("limit")
                || detail.contains("maximum")
                || detail.contains("too long")))
}

fn is_auth_failure(detail: &str) -> bool {
    detail.contains("authentication_error")
        || detail.contains("invalid_api_key")
        || detail.contains("invalid api key")
        || detail.contains("incorrect api key")
        || detail.contains("permission_denied")
}

fn is_usage_limited(detail: &str) -> bool {
    detail.contains("insufficient_quota")
        || detail.contains("insufficient quota")
        || detail.contains("exceeded your current quota")
        || detail.contains("usage limit")
        || detail.contains("usage_limit")
        || detail.contains("billing hard limit")
        || detail.contains("monthly limit")
}

fn is_overloaded(detail: &str) -> bool {
    detail.contains("overloaded_error") || detail.contains("server_overloaded")
}

fn is_invalid_request(detail: &str) -> bool {
    detail.contains("invalid_request_error") || detail.contains("invalid_argument")
}

pub(crate) mod google_count_tokens;
pub(crate) mod kimi_estimate_tokens;
pub(crate) mod openai_tools;
pub(crate) mod zai_tokenizer;
