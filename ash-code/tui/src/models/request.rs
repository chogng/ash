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
use ash_protocol::Patch;
use ash_protocol::ReasoningEffort;
use std::fmt;

#[derive(Debug)]
pub(crate) struct ModelUpdate {
    pub(crate) summary: ModelSummary,
    pub(crate) notice: String,
    pub(crate) picker: Option<ModelChoices>,
}

impl Command {
    pub(crate) const fn request_name(&self) -> &'static str {
        match self {
            Self::Pin { .. } => "ash-tui-pin-model",
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
        }
    }
}

pub(crate) fn execute<T>(
    client: &mut AppServerClient<T>,
    command: Command,
) -> Result<ModelUpdate, String>
where
    T: JsonRpcTransport,
{
    match command {
        Command::SetModel { preference } => set_model(client, &preference),
        Command::Pin { preference, pinned } => set_pin(client, &preference, pinned),
    }
    .map_err(|error| error.to_string())
}

pub(crate) fn load_selection<T>(
    client: &mut AppServerClient<T>,
) -> Result<ModelChoices, ModelCommandError>
where
    T: JsonRpcTransport,
{
    let config = client.read_config()?;
    let catalog = client.list_models()?;
    let providers = client.list_providers()?;
    model_choices(&catalog, &config, &providers).map_err(ModelCommandError)
}

pub(crate) fn set_model<T>(
    client: &mut AppServerClient<T>,
    arguments: &str,
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
        if !config.providers.contains_key(provider) {
            return Err(ModelCommandError(format!(
                "provider '{provider}' is not configured"
            )));
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
            let catalog = client.list_models()?;
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
        time_context: Default::default(),
        features: Default::default(),
        command_id: new_command_id("model"),
        expected_revision: config.revision,
        model,
        model_reasoning_effort,
        commit_message_model: Patch::Missing,
        approval_review_model: Patch::Missing,
        tool_mode: Patch::Missing,
        agent_grep_backend: Patch::Missing,
        gui: Patch::Missing,
        tui: Patch::Missing,
    })?;
    let config = client.read_config()?;
    let catalog = client.list_models().ok();
    let summary = ModelSummary::from_catalog(
        config.model,
        config.model_reasoning_effort,
        catalog.as_ref(),
    );
    let notice = format!(
        "Model: {}",
        model_label(summary.model(), summary.model_reasoning_effort())
    );
    Ok(ModelUpdate {
        summary,
        notice,
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
        time_context: Default::default(),
        features: Default::default(),
        command_id: new_command_id("pin-model"),
        expected_revision: config.revision,
        model: Patch::Missing,
        model_reasoning_effort: Patch::Missing,
        commit_message_model: Patch::Missing,
        approval_review_model: Patch::Missing,
        tool_mode: Patch::Missing,
        agent_grep_backend: Patch::Missing,
        gui: Patch::Missing,
        tui: Patch::Value(tui),
    })?;
    Ok(())
}
fn set_pin<T: JsonRpcTransport>(
    client: &mut AppServerClient<T>,
    preference: &str,
    pinned: bool,
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
        let catalog = client.list_models()?;
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
    let summary =
        ModelSummary::from_catalog(config.model.clone(), config.model_reasoning_effort, None);
    write_pins(client, config, pins)?;
    Ok(ModelUpdate {
        summary,
        notice: if pinned {
            "Model pinned"
        } else {
            "Model unpinned"
        }
        .into(),
        picker: Some(load_selection(client)?),
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
