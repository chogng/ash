use ash_async_utils::CancellationSource;
use ash_async_utils::CancellationToken;
use ash_client::OperationClient;
use ash_client::ResolvedApiTarget;
use serde_json::Value;
use serde_json::json;

use crate::ApiError;

/// Provider-independent wire codec for OpenAI-compatible embedding and rerank endpoints.
///
/// The caller owns provider selection, credentials, and canonical model types. This endpoint only
/// converts bounded text batches to HTTP JSON and restores provider results to input order.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SemanticApiEndpoint {
    OpenAiCompatible,
}

impl SemanticApiEndpoint {
    pub fn embed_with_client(
        self,
        target: &ResolvedApiTarget,
        model: &str,
        inputs: &[String],
        client: &dyn OperationClient,
    ) -> Result<Vec<Vec<f32>>, ApiError> {
        self.embed_with_client_and_cancellation(
            target,
            model,
            inputs,
            client,
            &CancellationSource::new().token(),
        )
    }

    pub fn embed_with_client_and_cancellation(
        self,
        target: &ResolvedApiTarget,
        model: &str,
        inputs: &[String],
        client: &dyn OperationClient,
        cancellation: &CancellationToken,
    ) -> Result<Vec<Vec<f32>>, ApiError> {
        validate_model_and_batch(model, inputs, "embedding")?;
        let response = crate::requests::post_json_to_path(
            client,
            target,
            "embeddings",
            semantic_headers(target),
            json!({"model": model, "input": inputs}),
            cancellation,
        )?;
        ordered_vectors(&response, inputs.len())
    }

    pub fn rerank_with_client(
        self,
        target: &ResolvedApiTarget,
        model: &str,
        query: &str,
        documents: &[String],
        client: &dyn OperationClient,
    ) -> Result<Vec<f32>, ApiError> {
        self.rerank_with_client_and_cancellation(
            target,
            model,
            query,
            documents,
            client,
            &CancellationSource::new().token(),
        )
    }

    pub fn rerank_with_client_and_cancellation(
        self,
        target: &ResolvedApiTarget,
        model: &str,
        query: &str,
        documents: &[String],
        client: &dyn OperationClient,
        cancellation: &CancellationToken,
    ) -> Result<Vec<f32>, ApiError> {
        validate_model_and_batch(model, documents, "rerank")?;
        if query.trim().is_empty() {
            return Err(ApiError::InvalidRequest(
                "rerank query must not be empty".into(),
            ));
        }
        let response = crate::requests::post_json_to_path(
            client,
            target,
            "rerank",
            semantic_headers(target),
            json!({"model": model, "query": query, "documents": documents}),
            cancellation,
        )?;
        ordered_scores(&response, documents.len())
    }
}

fn semantic_headers(target: &ResolvedApiTarget) -> Vec<ash_http_client::HttpHeader> {
    let mut headers = target.headers.clone();
    if !headers
        .iter()
        .any(|header| header.name().eq_ignore_ascii_case("content-type"))
    {
        headers.push(ash_http_client::HttpHeader::new(
            "Content-Type",
            "application/json",
        ));
    }
    headers
}

fn validate_model_and_batch(
    model: &str,
    inputs: &[String],
    operation: &str,
) -> Result<(), ApiError> {
    if model.trim().is_empty() {
        return Err(ApiError::InvalidRequest("model must not be empty".into()));
    }
    if inputs.is_empty() {
        return Err(ApiError::InvalidRequest(format!(
            "{operation} batch must not be empty"
        )));
    }
    Ok(())
}

fn ordered_vectors(response: &Value, expected: usize) -> Result<Vec<Vec<f32>>, ApiError> {
    let entries = response
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| ApiError::InvalidResponse("embedding response is missing data".into()))?;
    let mut ordered = vec![None; expected];
    for (fallback_index, entry) in entries.iter().enumerate() {
        let index = response_index(entry, fallback_index, expected, "embedding")?;
        let values = entry
            .get("embedding")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                ApiError::InvalidResponse("embedding result is missing its vector".into())
            })?
            .iter()
            .map(|value| {
                value.as_f64().map(|value| value as f32).ok_or_else(|| {
                    ApiError::InvalidResponse("embedding vector contains a non-number".into())
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        if values.is_empty() || values.iter().any(|value| !value.is_finite()) {
            return Err(ApiError::InvalidResponse(
                "embedding vector must be non-empty and finite".into(),
            ));
        }
        if ordered[index].replace(values).is_some() {
            return Err(ApiError::InvalidResponse(
                "embedding response contains a duplicate index".into(),
            ));
        }
    }
    ordered
        .into_iter()
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| {
            ApiError::InvalidResponse("embedding response count does not match input".into())
        })
}

fn ordered_scores(response: &Value, expected: usize) -> Result<Vec<f32>, ApiError> {
    let entries = response
        .get("results")
        .and_then(Value::as_array)
        .ok_or_else(|| ApiError::InvalidResponse("rerank response is missing results".into()))?;
    let mut ordered = vec![None; expected];
    for (fallback_index, entry) in entries.iter().enumerate() {
        let index = response_index(entry, fallback_index, expected, "rerank")?;
        let score = entry
            .get("relevance_score")
            .or_else(|| entry.get("score"))
            .and_then(Value::as_f64)
            .map(|value| value as f32)
            .filter(|value| value.is_finite())
            .ok_or_else(|| {
                ApiError::InvalidResponse("rerank result is missing a finite score".into())
            })?;
        if ordered[index].replace(score).is_some() {
            return Err(ApiError::InvalidResponse(
                "rerank response contains a duplicate index".into(),
            ));
        }
    }
    ordered
        .into_iter()
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| {
            ApiError::InvalidResponse("rerank response count does not match input".into())
        })
}

fn response_index(
    entry: &Value,
    fallback: usize,
    expected: usize,
    operation: &str,
) -> Result<usize, ApiError> {
    let index = entry
        .get("index")
        .and_then(Value::as_u64)
        .and_then(|index| usize::try_from(index).ok())
        .unwrap_or(fallback);
    if index >= expected {
        return Err(ApiError::InvalidResponse(format!(
            "{operation} response index is out of range"
        )));
    }
    Ok(index)
}
