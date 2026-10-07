use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::sync::Arc;

use ash_core::ToolInteractionService;
use ash_core::ToolUserInputOutcome;
use ash_protocol::RequestUserInput;
use ash_protocol::UserInputOption;
use ash_protocol::UserInputQuestion;
use ash_rmcp_client::ElicitRequestParams;
use ash_rmcp_client::ElicitResult;
use ash_rmcp_client::ElicitationAction;
use ash_rmcp_client::HostFuture;
use ash_rmcp_client::McpElicitation;
use ash_rmcp_client::RmcpErrorData;
use serde_json::Map;
use serde_json::Value;

const MAX_FIELDS: usize = 32;
const MAX_OPTIONS: usize = 100;
const MAX_TEXT_CHARS: usize = 4_096;

pub(crate) fn handle_elicitation(
    interactions: Option<Arc<dyn ToolInteractionService>>,
    request: McpElicitation,
) -> HostFuture<Result<ElicitResult, RmcpErrorData>> {
    Box::pin(async move {
        let Some(interactions) = interactions else {
            return Ok(ElicitResult::new(ElicitationAction::Decline));
        };
        let ElicitRequestParams::FormElicitationParams {
            message,
            requested_schema,
            ..
        } = request.params
        else {
            return Ok(ElicitResult::new(ElicitationAction::Decline));
        };
        let form = FormRequest::from_schema(message, requested_schema)?;
        let user_request = form.request();
        let outcome =
            tokio::task::spawn_blocking(move || interactions.request_user_input(user_request))
                .await
                .map_err(|_| {
                    RmcpErrorData::internal_error("MCP elicitation delivery stopped", None)
                })?
                .map_err(|_| {
                    RmcpErrorData::internal_error("MCP elicitation delivery failed", None)
                })?;
        match outcome {
            ToolUserInputOutcome::Answered(response) => {
                let content = form.parse_answers(response.answers)?;
                Ok(ElicitResult::new(ElicitationAction::Accept)
                    .with_content(Value::Object(content)))
            }
            ToolUserInputOutcome::Cancelled(_) => Ok(ElicitResult::new(ElicitationAction::Cancel)),
        }
    })
}

struct FormRequest {
    message: String,
    fields: Vec<FormField>,
}

impl FormRequest {
    fn from_schema(message: String, schema: impl serde::Serialize) -> Result<Self, RmcpErrorData> {
        if message.trim().is_empty() || message.chars().count() > MAX_TEXT_CHARS {
            return Err(invalid_form());
        }
        let schema = serde_json::to_value(schema).map_err(|_| invalid_form())?;
        let properties = schema
            .get("properties")
            .and_then(Value::as_object)
            .ok_or_else(invalid_form)?;
        if properties.is_empty() || properties.len() > MAX_FIELDS {
            return Err(invalid_form());
        }
        let required = schema
            .get("required")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect::<BTreeSet<_>>();
        // Dependency features must not change the order of user-visible fields.
        let fields = properties
            .iter()
            .collect::<BTreeMap<_, _>>()
            .into_iter()
            .map(|(id, schema)| FormField::from_schema(id, schema, required.contains(id.as_str())))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self { message, fields })
    }

    fn request(&self) -> RequestUserInput {
        RequestUserInput {
            questions: self
                .fields
                .iter()
                .map(|field| field.question(&self.message))
                .collect(),
        }
    }

    fn parse_answers(
        &self,
        answers: BTreeMap<String, ash_protocol::UserInputAnswer>,
    ) -> Result<Map<String, Value>, RmcpErrorData> {
        if answers
            .keys()
            .any(|id| !self.fields.iter().any(|field| &field.id == id))
        {
            return Err(invalid_response());
        }
        let mut content = Map::new();
        for field in &self.fields {
            match answers.get(&field.id) {
                Some(answer) => {
                    if !answer.value.is_empty() || field.required {
                        content.insert(field.id.clone(), field.kind.parse(&answer.value)?);
                    }
                }
                None if !field.required => {}
                None => return Err(invalid_response()),
            }
        }
        Ok(content)
    }
}

struct FormField {
    id: String,
    title: String,
    description: String,
    required: bool,
    kind: FormFieldKind,
}

impl FormField {
    fn from_schema(id: &str, schema: &Value, required: bool) -> Result<Self, RmcpErrorData> {
        if id.trim().is_empty()
            || id.chars().count() > 128
            || looks_sensitive(id)
            || schema.get("type").and_then(Value::as_str) == Some("array")
        {
            return Err(invalid_form());
        }
        let title = bounded_text(schema.get("title").and_then(Value::as_str).unwrap_or(id))?;
        let description = bounded_text(
            schema
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or(&title),
        )?;
        if looks_sensitive(&title) || looks_sensitive(&description) {
            return Err(invalid_form());
        }
        let kind = FormFieldKind::from_schema(schema)?;
        Ok(Self {
            id: id.to_owned(),
            title,
            description,
            required,
            kind,
        })
    }

    fn question(&self, message: &str) -> UserInputQuestion {
        UserInputQuestion {
            id: self.id.clone(),
            header: self.title.clone(),
            question: format!("{message}\n\n{}", self.description),
            options: self.kind.options(),
            allow_free_form: self.kind.allows_free_form(),
        }
    }
}

enum FormFieldKind {
    String { min: Option<u64>, max: Option<u64> },
    Number { min: Option<f64>, max: Option<f64> },
    Integer { min: Option<i64>, max: Option<i64> },
    Boolean,
    Enum(Vec<(String, String)>),
}

impl FormFieldKind {
    fn from_schema(schema: &Value) -> Result<Self, RmcpErrorData> {
        if let Some(values) = enum_values(schema)? {
            return Ok(Self::Enum(values));
        }
        match schema.get("type").and_then(Value::as_str) {
            Some("string") => Ok(Self::String {
                min: schema.get("minLength").and_then(Value::as_u64),
                max: schema.get("maxLength").and_then(Value::as_u64),
            }),
            Some("number") => Ok(Self::Number {
                min: schema.get("minimum").and_then(Value::as_f64),
                max: schema.get("maximum").and_then(Value::as_f64),
            }),
            Some("integer") => Ok(Self::Integer {
                min: schema.get("minimum").and_then(Value::as_i64),
                max: schema.get("maximum").and_then(Value::as_i64),
            }),
            Some("boolean") => Ok(Self::Boolean),
            _ => Err(invalid_form()),
        }
    }

    fn options(&self) -> Vec<UserInputOption> {
        match self {
            Self::Boolean => ["true", "false"]
                .into_iter()
                .map(|value| UserInputOption {
                    label: value.into(),
                    description: value.into(),
                })
                .collect(),
            Self::Enum(values) => values
                .iter()
                .map(|(value, title)| UserInputOption {
                    label: value.clone(),
                    description: title.clone(),
                })
                .collect(),
            Self::String { .. } | Self::Number { .. } | Self::Integer { .. } => Vec::new(),
        }
    }

    fn allows_free_form(&self) -> bool {
        matches!(
            self,
            Self::String { .. } | Self::Number { .. } | Self::Integer { .. }
        )
    }

    fn parse(&self, value: &str) -> Result<Value, RmcpErrorData> {
        match self {
            Self::String { min, max } => {
                let length = value.chars().count() as u64;
                if min.is_some_and(|min| length < min) || max.is_some_and(|max| length > max) {
                    return Err(invalid_response());
                }
                Ok(Value::String(value.to_owned()))
            }
            Self::Number { min, max } => {
                let value = value.parse::<f64>().map_err(|_| invalid_response())?;
                if !value.is_finite()
                    || min.is_some_and(|min| value < min)
                    || max.is_some_and(|max| value > max)
                {
                    return Err(invalid_response());
                }
                serde_json::Number::from_f64(value)
                    .map(Value::Number)
                    .ok_or_else(invalid_response)
            }
            Self::Integer { min, max } => {
                let value = value.parse::<i64>().map_err(|_| invalid_response())?;
                if min.is_some_and(|min| value < min) || max.is_some_and(|max| value > max) {
                    return Err(invalid_response());
                }
                Ok(Value::Number(value.into()))
            }
            Self::Boolean => value
                .parse::<bool>()
                .map(Value::Bool)
                .map_err(|_| invalid_response()),
            Self::Enum(values) if values.iter().any(|(candidate, _)| candidate == value) => {
                Ok(Value::String(value.to_owned()))
            }
            Self::Enum(_) => Err(invalid_response()),
        }
    }
}

fn enum_values(schema: &Value) -> Result<Option<Vec<(String, String)>>, RmcpErrorData> {
    let values = if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(|value| (value.to_owned(), value.to_owned()))
                    .ok_or_else(invalid_form)
            })
            .collect::<Result<Vec<_>, _>>()?
    } else if let Some(values) = schema.get("oneOf").and_then(Value::as_array) {
        values
            .iter()
            .map(|value| {
                let constant = value
                    .get("const")
                    .and_then(Value::as_str)
                    .ok_or_else(invalid_form)?;
                let title = value
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or(constant);
                Ok((bounded_text(constant)?, bounded_text(title)?))
            })
            .collect::<Result<Vec<_>, RmcpErrorData>>()?
    } else {
        return Ok(None);
    };
    if values.len() < 2 || values.len() > MAX_OPTIONS {
        return Err(invalid_form());
    }
    Ok(Some(values))
}

fn bounded_text(value: &str) -> Result<String, RmcpErrorData> {
    if value.trim().is_empty() || value.chars().count() > MAX_TEXT_CHARS {
        Err(invalid_form())
    } else {
        Ok(value.to_owned())
    }
}

fn looks_sensitive(value: &str) -> bool {
    let normalized = value.to_ascii_lowercase().replace(['-', '_'], " ");
    ["password", "secret", "token", "credential", "api key"]
        .iter()
        .any(|marker| normalized.contains(marker))
}

fn invalid_form() -> RmcpErrorData {
    RmcpErrorData::invalid_params("unsupported or invalid MCP elicitation form", None)
}

fn invalid_response() -> RmcpErrorData {
    RmcpErrorData::invalid_params(
        "MCP elicitation response did not match the requested form",
        None,
    )
}

#[cfg(test)]
#[path = "elicitation_tests.rs"]
mod tests;
