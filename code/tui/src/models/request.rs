use super::Command;
use super::ModelCommandError;
use super::ModelNotice;
use super::ModelSummary;
use super::ModelUpdate;
use super::model_choices;
use super::reasoning_effort;
use crate::client::new_command_id;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::config::ConfigUpdateParams;
use ash_app_server_protocol::protocol::config::ModelRefDto;
use ash_app_server_protocol::protocol::model::ModelListResult;
use ash_protocol::Patch;
use ash_protocol::ReasoningEffort;

impl Command {
    pub(crate) const fn request_name(&self) -> &'static str {
        match self {
            Self::Pin { .. } => "ash-tui-pin-model",
            Self::OpenEffortPicker
            | Self::DecreaseEffort
            | Self::IncreaseEffort
            | Self::SetEffort { .. } => "ash-tui-effort",
            Self::SetModel { .. } => "ash-tui-set-model",
            Self::Configure { .. } => "ash-tui-configure-model",
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
            Self::Configure { preference, .. } => format!("/model {preference}"),
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
        Command::Configure {
            preference,
            revision,
            option,
        } => configure_model(client, &preference, revision, option, catalog),
        Command::Pin { preference, pinned } => set_pin(client, &preference, pinned, catalog),
        Command::DecreaseEffort => reasoning_effort::update(
            client,
            reasoning_effort::Change::Step(reasoning_effort::Direction::Decrease),
            catalog,
        ),
        Command::IncreaseEffort => reasoning_effort::update(
            client,
            reasoning_effort::Change::Step(reasoning_effort::Direction::Increase),
            catalog,
        ),
        Command::SetEffort { effort } => {
            reasoning_effort::update(client, reasoning_effort::Change::Set(effort), catalog)
        }
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
        catalog: None,
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

fn configure_model<T: JsonRpcTransport>(
    client: &mut AppServerClient<T>,
    preference: &str,
    revision: u64,
    option: super::ModelOption,
    catalog: &ModelListResult,
) -> Result<ModelUpdate, ModelCommandError> {
    use super::ModelOption;
    use ash_app_server_protocol::protocol::config::ModelContextConfigDto;
    use ash_app_server_protocol::protocol::config::ProviderConfigureParams;

    let config = client.read_config()?;
    if config.revision != revision {
        return Err(ModelCommandError(
            "Model settings changed; reopen /model and try again".into(),
        ));
    }
    let entry = catalog
        .models
        .iter()
        .find(|entry| format!("{}/{}", entry.model.provider, entry.model.model) == preference)
        .ok_or_else(|| ModelCommandError("Model no longer available".into()))?;
    let provider_id = entry.model.provider.as_str();
    let model_id = entry.model.model.as_str();
    let mut provider = config.providers.get(provider_id).cloned().ok_or_else(|| {
        ModelCommandError("Configure a provider in /config before changing model settings".into())
    })?;
    match option {
        ModelOption::FastOn | ModelOption::FastOff => {
            if entry.capabilities.fast_mode != ash_protocol::CapabilitySupport::Supported {
                return Err(ModelCommandError(
                    "Fast mode is not supported by this model".into(),
                ));
            }
            provider.fast_models.retain(|model| model != model_id);
            if option == ModelOption::FastOn {
                provider.fast_models.push(model_id.into());
            }
        }
        ModelOption::Context272k | ModelOption::Context1m => {
            if !entry
                .maximum_context_window
                .is_some_and(|maximum| maximum >= 1_000_000)
            {
                return Err(ModelCommandError(
                    "This model does not support the 1m context preset".into(),
                ));
            }
            let context_window = if option == ModelOption::Context1m {
                1_000_000
            } else {
                272_000
            };
            if let Some(custom) = &mut provider.custom {
                custom.context_window = context_window;
            } else {
                provider.model_context.insert(
                    model_id.into(),
                    ModelContextConfigDto {
                        context_window,
                        // Recompute the backend's recommendation for the newly selected window.
                        auto_compact_token_limit: None,
                    },
                );
            }
        }
    }
    client.configure_provider(ProviderConfigureParams {
        command_id: new_command_id("model-options"),
        expected_revision: revision,
        config: provider,
    })?;
    let config = client.read_config()?;
    // Input capacity includes output reservation and compaction policy; only the backend
    // computes it. Refresh effective catalog metadata after changing its budget preference.
    let catalog = client.list_models()?;
    let summary = ModelSummary::from_catalog(
        config.model.clone(),
        config.model_reasoning_effort,
        Some(&catalog),
    );
    let picker = model_choices(&catalog, &config).map_err(ModelCommandError)?;
    Ok(ModelUpdate {
        summary,
        notice: ModelNotice::Silent,
        picker: Some(picker),
        config,
        catalog: Some(catalog),
    })
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
        catalog: None,
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
