use crate::StaticModelSpec;
use ash_protocol::ContextWindow;
use ash_protocol::ModelId;
use ash_protocol::ModelRef;
use ash_protocol::ProviderId;
use serde::Deserialize;
use serde::de::Error;
use std::collections::HashSet;
use std::sync::LazyLock;

/// The sole bundled text model catalog. JSON owns specs and complete per-model base prompts.
/// Providers stay grouped and releases are ordered newest first; unknown metadata stays unknown.
pub static STATIC_MODEL_CATALOG: LazyLock<Vec<StaticModelSpec>> =
    LazyLock::new(|| parse_catalogs(&BUNDLED_CATALOGS).expect("bundled model catalog is valid"));

// Keep presentation order explicit: filesystem enumeration must not reorder the product catalog.
const BUNDLED_CATALOGS: [(&str, &str); 8] = [
    ("openai", include_str!("../models/openai.json")),
    ("anthropic", include_str!("../models/anthropic.json")),
    ("google", include_str!("../models/google.json")),
    ("xai", include_str!("../models/xai.json")),
    ("kimi", include_str!("../models/kimi.json")),
    ("deepseek", include_str!("../models/deepseek.json")),
    ("glm", include_str!("../models/glm.json")),
    ("meta", include_str!("../models/meta.json")),
];

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct ModelCatalog {
    #[serde(rename = "$schema")]
    schema: Option<String>,
    models: Vec<StaticModelSpec>,
}

/// Schema of the editable catalog, including its nullable capability declarations.
pub fn model_catalog_schema() -> schemars::Schema {
    schemars::schema_for!(ModelCatalog)
}

fn parse_catalogs(sources: &[(&str, &str)]) -> Result<Vec<StaticModelSpec>, serde_json::Error> {
    let mut models = Vec::new();
    let mut identities = HashSet::new();
    for &(provider, json) in sources {
        let path = format!("models/{provider}.json");
        let catalog = parse_catalog(json)
            .map_err(|error| serde_json::Error::custom(format!("{path}: {error}")))?;
        for spec in catalog {
            if spec.provider_id != provider {
                return Err(serde_json::Error::custom(format!(
                    "{path}: model {}/{} must belong to provider {provider}",
                    spec.provider_id, spec.model_id
                )));
            }
            if !identities.insert((spec.provider_id.clone(), spec.model_id.clone())) {
                return Err(serde_json::Error::custom(format!(
                    "{path}: duplicate model {}/{}",
                    spec.provider_id, spec.model_id
                )));
            }
            models.push(spec);
        }
    }
    Ok(models)
}

// Validate at the data boundary: a malformed registered model is an error, not an unknown model.
fn parse_catalog(json: &str) -> Result<Vec<StaticModelSpec>, serde_json::Error> {
    let catalog: ModelCatalog = serde_json::from_str(json)?;
    if catalog
        .schema
        .as_deref()
        .is_some_and(|schema| schema != "../models.schema.json")
    {
        return Err(serde_json::Error::custom(
            "model catalog schema must reference ../models.schema.json",
        ));
    }
    let mut identities = HashSet::new();
    for spec in &catalog.models {
        validate_model(spec).map_err(|error| {
            serde_json::Error::custom(format!(
                "model {}/{}: {error}",
                spec.provider_id, spec.model_id
            ))
        })?;
        if !identities.insert((&spec.provider_id, &spec.model_id)) {
            return Err(serde_json::Error::custom(format!(
                "duplicate model {}/{}",
                spec.provider_id, spec.model_id
            )));
        }
    }
    Ok(catalog.models)
}

fn validate_model(spec: &StaticModelSpec) -> Result<(), serde_json::Error> {
    spec.settings
        .validate()
        .map_err(serde_json::Error::custom)?;
    ProviderId::new(&spec.provider_id).map_err(serde_json::Error::custom)?;
    ModelId::new(&spec.model_id).map_err(serde_json::Error::custom)?;
    if spec.display_name.trim().is_empty() {
        return Err(serde_json::Error::custom("model display name is empty"));
    }
    ash_protocol::ModelInfo::validate_presentation(
        spec.description.as_deref(),
        &spec.supported_reasoning_efforts,
    )
    .map_err(serde_json::Error::custom)?;
    match (spec.context_window, spec.max_context_window) {
        (ContextWindow::Known(default), ContextWindow::Known(maximum)) if maximum < default => {
            return Err(serde_json::Error::custom(
                "maximum context window is below the default",
            ));
        }
        (ContextWindow::Unknown, ContextWindow::Known(_)) => {
            return Err(serde_json::Error::custom(
                "maximum context window requires a default",
            ));
        }
        _ => {}
    }
    if spec.auto_compact_token_limit == Some(0) {
        return Err(serde_json::Error::custom(
            "auto compact token limit must be positive",
        ));
    }
    if let Some(effort) = spec.default_reasoning_effort
        && !spec
            .supported_reasoning_efforts
            .iter()
            .any(|option| option.effort == effort)
    {
        return Err(serde_json::Error::custom(
            "default reasoning effort is not supported",
        ));
    }
    let messages = &spec.model_messages;
    let texts = std::iter::once(&messages.system_instructions)
        .chain(messages.tools.values().map(|tool| &tool.description))
        .chain(messages.collaboration_modes.values())
        .chain(messages.multi_agent.root.iter())
        .chain(messages.multi_agent.subagent.iter());
    let mut bytes = 0;
    for text in texts {
        if text.trim().is_empty() {
            return Err(serde_json::Error::custom("model instruction text is empty"));
        }
        bytes += text.len();
    }
    if bytes > 64 * 1024 {
        return Err(serde_json::Error::custom("model messages exceed 64 KiB"));
    }
    Ok(())
}

/// Finds a model by its exact stable vendor and model identity.
pub fn find_static_model(model: &ModelRef) -> Option<&'static StaticModelSpec> {
    STATIC_MODEL_CATALOG.iter().find(|spec| {
        spec.provider_id == model.provider.as_str() && spec.model_id == model.model.as_str()
    })
}

pub(crate) fn attach_static_models(definitions: &mut [crate::ProviderDefinition]) {
    for definition in definitions {
        definition.models = STATIC_MODEL_CATALOG
            .iter()
            .filter(|spec| spec.provider_id == definition.id.as_str())
            .map(StaticModelSpec::model)
            .collect();
    }
}

#[cfg(test)]
#[path = "model_catalog_tests.rs"]
mod tests;
