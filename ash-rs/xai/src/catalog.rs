use crate::XaiError;
use crate::XaiErrorKind;
use crate::XaiOAuth;
use ash_async_utils::CancellationToken;
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

impl XaiOAuth {
    pub fn models(
        &self,
        account_id: &str,
        cancellation: &CancellationToken,
    ) -> Result<Vec<CatalogModel>, XaiError> {
        let target = self.api_target()?;
        if target.account_id != account_id {
            return Err(XaiError::new(
                "xAI account changed; refresh the model catalog",
            ));
        }
        let result = self.get(&target.target, "models-v2", cancellation);
        let value = match result {
            Err(error) if error.kind() == XaiErrorKind::Authentication => {
                let Some(renewed) = self.recover_unauthorized(&target)? else {
                    return Err(error);
                };
                self.get(&renewed.target, "models-v2", cancellation)
                    .inspect_err(|error| {
                        if error.kind() == XaiErrorKind::Authentication {
                            self.note_rejected(&renewed);
                        }
                    })?
            }
            result => result?,
        };
        parse_models(value)
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

fn parse_models(value: Value) -> Result<Vec<CatalogModel>, XaiError> {
    let entries = value.get("data").and_then(Value::as_array).ok_or_else(|| {
        XaiError::with_kind(
            XaiErrorKind::InvalidResponse,
            "xAI model catalog is missing data",
        )
    })?;
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
            .ok_or_else(|| {
                XaiError::with_kind(
                    XaiErrorKind::InvalidResponse,
                    "xAI model catalog is missing model identity",
                )
            })?;
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
#[path = "catalog_tests.rs"]
mod tests;
