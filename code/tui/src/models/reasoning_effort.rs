//! Reasoning-effort selection and configuration updates shared by shortcuts and `/effort`.
//!
//! The exact provider/model catalog entry owns the available levels and their order; the TUI
//! does not define a universal level list. Input ownership stays with App. Adjustments persist
//! through the same revision-checked configuration path as explicit effort selection.

use super::ModelCommandError;
use super::ModelNotice;
use super::ModelSummary;
use super::ModelUpdate;
use crate::client::new_command_id;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::config::ConfigUpdateParams;
use ash_app_server_protocol::protocol::model::ModelListResult;
use ash_protocol::Patch;
use ash_protocol::ReasoningEffort;

pub(super) fn selected_efforts<'a>(
    config: &ash_app_server_protocol::protocol::config::ConfigReadResult,
    catalog: &'a ModelListResult,
) -> Result<
    (
        &'a [ash_protocol::ModelReasoningEffortOption],
        Option<ReasoningEffort>,
    ),
    ModelCommandError,
> {
    let model = config.model.as_ref().ok_or_else(|| {
        ModelCommandError("Select a model with /model before changing thinking effort".into())
    })?;
    let entry = catalog
        .models
        .iter()
        .find(|entry| {
            entry.model.provider.as_str() == model.provider
                && entry.model.model.as_str() == model.model
        })
        .ok_or_else(|| ModelCommandError("Model no longer available".into()))?;
    if entry.supported_reasoning_efforts.is_empty() {
        return Err(ModelCommandError(
            "This model does not support thinking effort".into(),
        ));
    }
    Ok((
        &entry.supported_reasoning_efforts,
        config
            .model_reasoning_effort
            .or(entry.default_reasoning_effort),
    ))
}

pub(super) fn choices(
    config: &ash_app_server_protocol::protocol::config::ConfigReadResult,
    catalog: &ModelListResult,
) -> Result<crate::thread::composer::options::ComposerOptions, String> {
    let (supported, current) =
        selected_efforts(config, catalog).map_err(|error| error.to_string())?;
    Ok(crate::thread::composer::options::choices(
        "Thinking effort",
        supported.iter().map(|option| {
            let effort = option.effort;
            (
                effort.as_str().into(),
                option.description.clone().unwrap_or_default(),
                crate::thread::composer::options::ComposerOption::Effort(effort),
                current == Some(effort),
            )
        }),
    ))
}

pub(super) enum Change {
    Step(Direction),
    Set(ReasoningEffort),
}

pub(super) enum Direction {
    Decrease,
    Increase,
}

pub(super) fn update<T: JsonRpcTransport>(
    client: &mut AppServerClient<T>,
    change: Change,
    catalog: &ModelListResult,
) -> Result<ModelUpdate, ModelCommandError> {
    let config = client.read_config()?;
    let (supported, current) = selected_efforts(&config, catalog)?;
    let effort = match change {
        Change::Set(effort) if supported.iter().any(|option| option.effort == effort) => effort,
        Change::Set(_) => {
            return Err(ModelCommandError(
                "Use /effort to choose a supported thinking effort".into(),
            ));
        }
        Change::Step(direction) => {
            let next = match current {
                Some(effort) => {
                    let index = supported
                        .iter()
                        .position(|option| option.effort == effort)
                        .ok_or_else(|| {
                            ModelCommandError(
                                "Use /effort to choose a supported thinking effort".into(),
                            )
                        })?;
                    // Boundaries stay silent: the status line already shows the current level.
                    // Do not wrap or persist an unchanged value.
                    let next = match direction {
                        Direction::Decrease => index.checked_sub(1),
                        Direction::Increase => (index + 1 < supported.len()).then_some(index + 1),
                    };
                    let Some(next) = next else {
                        return Ok(ModelUpdate {
                            catalog: None,
                            summary: ModelSummary::from_catalog(
                                config.model.clone(),
                                config.model_reasoning_effort,
                                Some(catalog),
                            ),
                            notice: ModelNotice::Silent,
                            picker: None,
                            config,
                        });
                    };
                    next
                }
                None => 0,
            };
            supported[next].effort
        }
    };
    client.update_config(ConfigUpdateParams {
        context: ash_protocol::Patch::Missing,
        advisor: Default::default(),
        time_context: Default::default(),
        features: Default::default(),
        command_id: new_command_id("effort"),
        expected_revision: config.revision,
        model: Patch::Missing,
        model_reasoning_effort: Patch::Value(effort),
        commit_message_model: Patch::Missing,
        approval_review_model: Patch::Missing,
        tool_mode: Patch::Missing,
        grep_backend: Patch::Missing,
        git: Patch::Missing,
        gui: Patch::Missing,
        tui: Patch::Missing,
    })?;
    let config = client.read_config()?;
    let summary = ModelSummary::from_catalog(
        config.model.clone(),
        config.model_reasoning_effort,
        Some(catalog),
    );
    Ok(ModelUpdate {
        catalog: None,
        notice: ModelNotice::Silent,
        summary,
        config,
        picker: None,
    })
}
