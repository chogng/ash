use super::Client;
use crate::RequestError;
use async_utils::CancellationToken;
use http_client::HttpHeader;
use serde_json::Value;
/// Subscription models returned by the authenticated models-v2 endpoint.
#[derive(Clone, Debug, PartialEq)]
pub struct CatalogModel {
    pub id: String,
    pub name: Option<String>,
    pub context_window: Option<u32>,
    pub reasoning_efforts: Vec<String>,
    pub reasoning_effort: Option<String>,
}

impl Client<'_> {
    pub fn read_models(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<Vec<CatalogModel>, RequestError> {
        parse_models(self.http.get(
            self.http.endpoint(["models-v2"])?,
            &[HttpHeader::new("Accept", "application/json")],
            cancellation,
        )?)
    }
}

// These spellings and _meta locations follow grok-build's parse_remote_model_value.
fn field<'a>(entry: &'a Value, names: &[&str]) -> Option<&'a Value> {
    names.iter().find_map(|name| entry.get(name)).or_else(|| {
        entry
            .get("_meta")
            .and_then(|meta| names.iter().find_map(|name| meta.get(name)))
    })
}

fn parse_models(value: Value) -> Result<Vec<CatalogModel>, RequestError> {
    let entries = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| RequestError::InvalidResponse)?;
    let mut models = Vec::new();
    for entry in entries {
        if field(entry, &["hidden"]).and_then(Value::as_bool) == Some(true)
            || field(entry, &["apiBackend", "api_backend"]).and_then(Value::as_str)
                != Some("responses")
        {
            continue;
        }
        let id = field(entry, &["model", "modelId", "id"])
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| RequestError::InvalidResponse)?;
        let context_window = field(
            entry,
            &["contextWindow", "context_window", "totalContextTokens"],
        )
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 0);
        let reasoning_efforts = field(entry, &["reasoningEfforts", "reasoning_efforts"])
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|effort| {
                effort
                    .as_str()
                    .or_else(|| effort.get("value").and_then(Value::as_str))
            })
            .map(str::to_owned)
            .collect();
        models.push(CatalogModel {
            id: id.into(),
            name: field(entry, &["name"])
                .and_then(Value::as_str)
                .map(str::to_owned),
            context_window,
            reasoning_efforts,
            reasoning_effort: field(entry, &["reasoningEffort", "reasoning_effort"])
                .and_then(Value::as_str)
                .map(str::to_owned),
        });
    }
    Ok(models)
}

#[cfg(test)]
#[path = "models_tests.rs"]
mod tests;
