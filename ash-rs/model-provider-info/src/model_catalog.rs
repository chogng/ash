use crate::StaticModelSpec;
use ash_protocol::ContextWindow;
use ash_protocol::ModelId;
use ash_protocol::ModelRef;
use ash_protocol::ProviderId;
use ash_protocol::TurnInstructions;
use serde::Deserialize;
use serde::de::Error;
use std::collections::HashSet;
use std::sync::LazyLock;

/// The sole bundled text model catalog. JSON owns specs and complete per-model base prompts.
/// Providers stay grouped and releases are ordered newest first; unknown metadata stays unknown.
pub static STATIC_MODEL_CATALOG: LazyLock<Vec<StaticModelSpec>> = LazyLock::new(|| {
    parse_catalog(include_str!("../models.json")).expect("bundled model catalog is valid")
});

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ModelCatalog {
    models: Vec<StaticModelSpec>,
}

// Validate at the data boundary: a malformed registered model is an error, not an unknown model.
fn parse_catalog(json: &str) -> Result<Vec<StaticModelSpec>, serde_json::Error> {
    let mut catalog: ModelCatalog = serde_json::from_str(json)?;
    let mut identities = HashSet::new();
    for spec in &mut catalog.models {
        let provider = ProviderId::new(&spec.provider_id).map_err(serde_json::Error::custom)?;
        let model = ModelId::new(&spec.model_id).map_err(serde_json::Error::custom)?;
        if !identities.insert((provider, model)) {
            return Err(serde_json::Error::custom(format!(
                "duplicate model {}/{}",
                spec.provider_id, spec.model_id
            )));
        }
        if spec.display_name.trim().is_empty() {
            return Err(serde_json::Error::custom("model display name is empty"));
        }
        match spec.context_window {
            ContextWindow::Known(capacity) => {
                // Without separate presets the full declared capacity is the only budget.
                // Normalize once so every consumer uses the same default and selectable values.
                if spec.context_window_options.is_empty() {
                    spec.context_window_options.push(capacity);
                }
                if spec.context_window_options.len() > 2
                    || spec
                        .context_window_options
                        .iter()
                        .any(|tokens| *tokens == 0 || *tokens > capacity)
                    || spec
                        .context_window_options
                        .windows(2)
                        .any(|pair| pair[0] >= pair[1])
                {
                    return Err(serde_json::Error::custom(
                        "invalid model context window defaults or options",
                    ));
                }
            }
            ContextWindow::Unknown if spec.context_window_options.is_empty() => {}
            ContextWindow::Unknown => {
                return Err(serde_json::Error::custom(
                    "context options require declared capacity",
                ));
            }
        }
        if spec.auto_compact_token_limit == Some(0) {
            return Err(serde_json::Error::custom(
                "auto compact token limit must be positive",
            ));
        }
        if let Some(effort) = spec.model_reasoning_effort
            && !spec.supported_reasoning_efforts.contains(&effort)
        {
            return Err(serde_json::Error::custom(
                "default reasoning effort is not supported",
            ));
        }
        if spec.instructions.body.len() > 64 * 1024 {
            return Err(serde_json::Error::custom(
                "model instructions exceed 64 KiB",
            ));
        }
        TurnInstructions::new(
            "models-manager",
            format!("model/{}/{}", spec.provider_id, spec.model_id),
            &spec.instructions.revision,
            &spec.instructions.body,
        )
        .map_err(serde_json::Error::custom)?;
    }
    Ok(catalog.models)
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
