use super::Command;
use super::ModelChoices;
use super::ModelSummary;
use super::model_choices;
use crate::client::new_command_id;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::ClientError;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::config::ConfigUpdateParams;
use ash_app_server_protocol::protocol::config::ModelRefDto;
use ash_app_server_protocol::protocol::model::ModelListResult;
use ash_protocol::Patch;
use ash_protocol::ReasoningEffort;
use std::fmt;

#[derive(Debug)]
pub(crate) struct ModelUpdate {
    pub(crate) summary: ModelSummary,
    pub(crate) notice: ModelNotice,
    pub(crate) picker: Option<ModelChoices>,
    pub(crate) config: ash_app_server_protocol::protocol::config::ConfigReadResult,
}

#[derive(Debug)]
pub(crate) enum ModelNotice {
    Command(crate::nls::Text),
    /// Adjusting effort must not add transcript commands or change a running turn's status.
    ThinkingEffort(crate::nls::Text),
}

impl Command {
    pub(crate) const fn request_name(&self) -> &'static str {
        match self {
            Self::Pin { .. } => "ash-tui-pin-model",
            Self::OpenEffortPicker
            | Self::DecreaseEffort
            | Self::IncreaseEffort
            | Self::SetEffort { .. } => "ash-tui-effort",
            Self::SetModel { .. } => "ash-tui-set-model",
        }
    }

    pub(crate) fn command_line(&self) -> String {
        match self {
            Self::Pin { preference, pinned } => format!(
                "/model {} {preference}",
                if *pinned { "pin" } else { "unpin" }
            ),
            Self::SetModel { preference } => format!("/model {preference}"),
            Self::OpenEffortPicker | Self::DecreaseEffort | Self::IncreaseEffort => {
                "/effort".into()
            }
            Self::SetEffort { effort } => format!("/effort {}", effort.as_str()),
        }
    }
}

pub(crate) fn execute<T>(
    client: &mut AppServerClient<T>,
    command: Command,
    catalog: &ModelListResult,
) -> Result<ModelUpdate, String>
where
    T: JsonRpcTransport,
{
    match command {
        Command::SetModel { preference } => set_model(client, &preference, catalog),
        Command::Pin { preference, pinned } => set_pin(client, &preference, pinned, catalog),
        Command::DecreaseEffort => change_effort(
            client,
            EffortChange::Step(EffortDirection::Decrease),
            catalog,
        ),
        Command::IncreaseEffort => change_effort(
            client,
            EffortChange::Step(EffortDirection::Increase),
            catalog,
        ),
        Command::SetEffort { effort } => change_effort(client, EffortChange::Set(effort), catalog),
        Command::OpenEffortPicker => unreachable!("effort picker is opened by AppDriver"),
    }
    .map_err(|error| error.to_string())
}

pub(crate) fn set_model<T>(
    client: &mut AppServerClient<T>,
    arguments: &str,
    catalog: &ModelListResult,
) -> Result<ModelUpdate, ModelCommandError>
where
    T: JsonRpcTransport,
{
    let config = client.read_config()?;
    if arguments.is_empty() {
        return Err(ModelCommandError(
            "model selection requires a model or 'clear'".into(),
        ));
    }

    let mut tokens = arguments.split_whitespace();
    let first = tokens
        .next()
        .ok_or_else(|| ModelCommandError("model selection requires a model or 'clear'".into()))?;

    let (model, model_reasoning_effort) = if first == "clear" {
        if tokens.next().is_some() {
            return Err(ModelCommandError(
                "/model clear does not accept additional arguments".into(),
            ));
        }
        (Patch::Null, Patch::Null)
    } else {
        let (provider, model) = first.split_once('/').ok_or_else(|| {
            ModelCommandError(
                "model must use <provider>/<model> [effort]; use /model clear to unset it".into(),
            )
        })?;
        if provider.trim().is_empty()
            || model.trim().is_empty()
            || provider.contains(char::is_whitespace)
            || model.contains(char::is_whitespace)
        {
            return Err(ModelCommandError(
                "model must use non-empty <provider>/<model> without whitespace".into(),
            ));
        }
        let effort_opt = match tokens.next() {
            Some(raw) => {
                let effort = raw.parse::<ReasoningEffort>().map_err(|_| {
                    ModelCommandError(format!(
                        "invalid reasoning effort '{raw}'; supported values: low, medium, high, max"
                    ))
                })?;
                Some(effort)
            }
            None => None,
        };

        if tokens.next().is_some() {
            return Err(ModelCommandError(
                "too many arguments; expected /model <provider>/<model> [effort]".into(),
            ));
        }

        if let Some(effort) = effort_opt {
            let entry = catalog.models.iter().find(|entry| {
                entry.model.provider.as_str() == provider && entry.model.model.as_str() == model
            });
            if let Some(entry) = entry {
                if entry.supported_reasoning_efforts.is_empty() {
                    return Err(ModelCommandError(format!(
                        "model '{provider}/{model}' does not support reasoning effort"
                    )));
                }
                if !entry.supported_reasoning_efforts.contains(&effort) {
                    let supported = entry
                        .supported_reasoning_efforts
                        .iter()
                        .map(|e| e.as_str())
                        .collect::<Vec<_>>()
                        .join(", ");
                    return Err(ModelCommandError(format!(
                        "model '{provider}/{model}' does not support reasoning effort '{effort}'; supported: [{supported}]"
                    )));
                }
            }
        }

        (
            Patch::Value(ModelRefDto {
                provider: provider.into(),
                model: model.into(),
            }),
            match effort_opt {
                Some(effort) => Patch::Value(effort),
                None => Patch::Null,
            },
        )
    };

    client.update_config(ConfigUpdateParams {
        advisor: Default::default(),
        time_context: Default::default(),
        features: Default::default(),
        command_id: new_command_id("model"),
        expected_revision: config.revision,
        model,
        model_reasoning_effort,
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
    let notice = format!(
        "Model: {}",
        model_label(summary.model(), summary.model_reasoning_effort())
    );
    Ok(ModelUpdate {
        summary,
        notice: ModelNotice::Command(crate::nls::Text::literal(notice)),
        picker: None,
        config,
    })
}

fn selected_efforts<'a>(
    config: &ash_app_server_protocol::protocol::config::ConfigReadResult,
    catalog: &'a ModelListResult,
) -> Result<(&'a [ReasoningEffort], Option<ReasoningEffort>), ModelCommandError> {
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
            .or(entry.model_reasoning_effort),
    ))
}

pub(super) fn effort_choices(
    config: &ash_app_server_protocol::protocol::config::ConfigReadResult,
    catalog: &ModelListResult,
) -> Result<crate::thread::composer::options::ComposerOptions, String> {
    let (supported, current) =
        selected_efforts(config, catalog).map_err(|error| error.to_string())?;
    Ok(crate::thread::composer::options::choices(
        "Thinking effort",
        supported.iter().copied().map(|effort| {
            (
                super::reasoning_effort_label(effort).into(),
                String::new(),
                crate::thread::composer::options::ComposerOption::Effort(effort),
                current == Some(effort),
            )
        }),
    ))
}

enum EffortChange {
    Step(EffortDirection),
    Set(ReasoningEffort),
}

enum EffortDirection {
    Decrease,
    Increase,
}

fn change_effort<T: JsonRpcTransport>(
    client: &mut AppServerClient<T>,
    change: EffortChange,
    catalog: &ModelListResult,
) -> Result<ModelUpdate, ModelCommandError> {
    let config = client.read_config()?;
    let (supported, current) = selected_efforts(&config, catalog)?;
    let effort = match change {
        EffortChange::Set(effort) if supported.contains(&effort) => effort,
        EffortChange::Set(_) => {
            return Err(ModelCommandError(
                "Use /effort to choose a supported thinking effort".into(),
            ));
        }
        EffortChange::Step(direction) => {
            let next = match current {
                Some(effort) => {
                    let index = supported
                        .iter()
                        .position(|value| *value == effort)
                        .ok_or_else(|| {
                            ModelCommandError(
                                "Use /effort to choose a supported thinking effort".into(),
                            )
                        })?;
                    // A directional adjustment stops at the boundary rather than wrapping.
                    let next = match direction {
                        EffortDirection::Decrease => index.checked_sub(1),
                        EffortDirection::Increase => {
                            (index + 1 < supported.len()).then_some(index + 1)
                        }
                    };
                    let Some(next) = next else {
                        let message = match direction {
                            EffortDirection::Decrease => {
                                "Thinking effort is already at the lowest level ({0})"
                            }
                            EffortDirection::Increase => {
                                "Thinking effort is already at the highest level ({0})"
                            }
                        };
                        return Ok(ModelUpdate {
                            summary: ModelSummary::from_catalog(
                                config.model.clone(),
                                config.model_reasoning_effort,
                                Some(catalog),
                            ),
                            notice: ModelNotice::ThinkingEffort(crate::nls::Text::template(
                                message,
                                vec![super::reasoning_effort_label(effort).into()],
                            )),
                            picker: None,
                            config,
                        });
                    };
                    next
                }
                None => 0,
            };
            supported[next]
        }
    };
    client.update_config(ConfigUpdateParams {
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
        notice: ModelNotice::ThinkingEffort(crate::nls::Text::template(
            "Thinking effort: {0}",
            vec![super::reasoning_effort_label(effort).into()],
        )),
        summary,
        config,
        picker: None,
    })
}

fn model_label(model: Option<&ModelRefDto>, effort: Option<ReasoningEffort>) -> String {
    match (model, effort) {
        (Some(model), Some(effort)) => {
            format!("{}/{} ({})", model.provider, model.model, effort.as_str())
        }
        (Some(model), None) => format!("{}/{}", model.provider, model.model),
        (None, _) => "not configured".into(),
    }
}

#[derive(Debug)]
pub(crate) struct ModelCommandError(String);

impl fmt::Display for ModelCommandError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl From<ClientError> for ModelCommandError {
    fn from(error: ClientError) -> Self {
        Self(error.to_string())
    }
}

fn write_pins<T: JsonRpcTransport>(
    client: &mut AppServerClient<T>,
    config: ash_app_server_protocol::protocol::config::ConfigReadResult,
    pins: Vec<ModelRefDto>,
) -> Result<(), ModelCommandError> {
    let mut tui = config.tui;
    tui.0.insert(
        "pinnedModels".into(),
        serde_json::to_value(pins).map_err(|error| ModelCommandError(error.to_string()))?,
    );
    client.update_config(ConfigUpdateParams {
        advisor: Default::default(),
        time_context: Default::default(),
        features: Default::default(),
        command_id: new_command_id("pin-model"),
        expected_revision: config.revision,
        model: Patch::Missing,
        model_reasoning_effort: Patch::Missing,
        commit_message_model: Patch::Missing,
        approval_review_model: Patch::Missing,
        tool_mode: Patch::Missing,
        grep_backend: Patch::Missing,
        git: Patch::Missing,
        gui: Patch::Missing,
        tui: Patch::Value(tui),
    })?;
    Ok(())
}
fn set_pin<T: JsonRpcTransport>(
    client: &mut AppServerClient<T>,
    preference: &str,
    pinned: bool,
    catalog: &ModelListResult,
) -> Result<ModelUpdate, ModelCommandError> {
    let config = client.read_config()?;
    let mut pins = super::picker::pinned_models(&config.tui).map_err(ModelCommandError)?;
    let (provider, model) = preference
        .split_once('/')
        .ok_or_else(|| ModelCommandError("Invalid model identity".into()))?;
    let model = ModelRefDto {
        provider: provider.into(),
        model: model.into(),
    };
    if pinned {
        if !catalog.models.iter().any(|entry| {
            entry.model.provider.as_str() == model.provider
                && entry.model.model.as_str() == model.model
        }) {
            return Err(ModelCommandError("Model no longer available".into()));
        }
        if !pins.contains(&model) {
            pins.push(model);
        }
    } else {
        pins.retain(|pin| pin != &model);
    }
    write_pins(client, config, pins)?;
    let config = client.read_config()?;
    let summary = ModelSummary::from_catalog(
        config.model.clone(),
        config.model_reasoning_effort,
        Some(catalog),
    );
    let picker = model_choices(catalog, &config).map_err(ModelCommandError)?;
    Ok(ModelUpdate {
        summary,
        notice: ModelNotice::Command(
            if pinned {
                "Model pinned"
            } else {
                "Model unpinned"
            }
            .into(),
        ),
        picker: Some(picker),
        config,
    })
}
pub(crate) fn remove_provider_pins<T: JsonRpcTransport>(
    client: &mut AppServerClient<T>,
    provider: &str,
) -> Result<(), String> {
    let config = client.read_config().map_err(|error| error.to_string())?;
    let mut pins = super::picker::pinned_models(&config.tui)?;
    let before = pins.len();
    pins.retain(|pin| pin.provider != provider);
    if pins.len() != before {
        write_pins(client, config, pins).map_err(|error| error.to_string())?;
    }
    Ok(())
}
