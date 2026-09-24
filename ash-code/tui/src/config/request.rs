use super::Command;
use super::ConfigChoices;
use super::ConfigEdit;
use super::ConfigEditResult;
use super::Event;
use super::ProviderApiKeyEdit;
use super::TerminalSettings;
use super::advisor_choices;
use super::config_choices;
use crate::client::new_command_id;
use crate::status::StatusLineSettings;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::ClientError;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_client::ProviderApiKeySetRequest;
use ash_app_server_protocol::protocol::config::ConfigUpdateParams;
use ash_protocol::Patch;
use std::fmt;

pub(crate) struct ProviderApiKeyUpdate {
    pub(crate) provider: String,
    pub(crate) choices: ConfigChoices,
}

impl Command {
    pub(crate) const fn request_name(&self) -> &'static str {
        match self {
            Self::OpenAdvisor => "ash-tui-read-advisor-config",
            Self::SetAdvisor(_) => "ash-tui-set-advisor-config",
            Self::SetMemories(_) => "ash-tui-set-memories",
            Self::SetIssues(_) => "ash-tui-configure-issues",
            Self::SetGit(_) => "ash-tui-configure-git",
            Self::Connection(_) => "ash-tui-provider-connection",
            Self::Subscription(_, _) => "ash-tui-subscription-account",
            Self::OpenEditor => "ash-tui-read-config",
            Self::Edit(_) => "ash-tui-set-config",
            Self::SetProviderApiKey(_) => "ash-tui-set-provider-api-key",
        }
    }
}

pub(crate) fn execute<T>(client: &mut AppServerClient<T>, command: Command) -> Result<Event, String>
where
    T: JsonRpcTransport,
{
    match command {
        Command::OpenAdvisor => (|| -> Result<Event, ConfigCommandError> {
            let config = client.read_config().map_err(ConfigCommandError::from)?;
            let models = client.list_models().map_err(ConfigCommandError::from)?;
            let terminal = TerminalSettings::from_tui(&config.tui).map_err(ConfigCommandError)?;
            Ok(Event::AdvisorOpened(advisor_choices(
                &config,
                &models,
                terminal.language(),
            )))
        })(),
        Command::SetAdvisor(advisor) => set_advisor(client, advisor).map(Event::Updated),
        Command::SetMemories(edit) => set_memories(client, edit).map(Event::Updated),
        Command::SetIssues(edit) => set_issue_settings(client, edit).map(Event::Updated),
        Command::SetGit(edit) => set_git_settings(client, edit).map(Event::Updated),
        Command::Connection(request) => {
            let id = request.id.clone();
            let result = execute_connection(client, request);
            return Ok(Event::Connection(super::provider::Reply { id, result }));
        }
        Command::Subscription(provider, command) => Ok(Event::SubscriptionReply(
            provider,
            super::subscription::execute(client, provider, command),
        )),
        Command::OpenEditor => read_config_choices(client).map(Event::EditorOpened),
        Command::Edit(edit) => set_settings(client, edit).map(Event::Updated),
        Command::SetProviderApiKey(edit) => {
            set_provider_api_key(client, edit).map(|update| Event::ApiKeySaved {
                provider: update.provider,
                choices: update.choices,
            })
        }
    }
    .map_err(|error| error.to_string())
}

fn set_advisor<T: JsonRpcTransport>(
    client: &mut AppServerClient<T>,
    advisor: Option<ash_protocol::AdvisorConfig>,
) -> Result<ConfigEditResult, ConfigCommandError> {
    let config = client.read_config()?;
    client.update_config(ConfigUpdateParams {
        command_id: new_command_id("advisor-config"),
        expected_revision: config.revision,
        advisor: advisor.map(Patch::Value).unwrap_or(Patch::Null),
        time_context: Patch::Missing,
        features: Patch::Missing,
        model: Patch::Missing,
        model_reasoning_effort: Patch::Missing,
        commit_message_model: Patch::Missing,
        approval_review_model: Patch::Missing,
        tool_mode: Patch::Missing,
        grep_backend: Patch::Missing,
        git: Patch::Missing,
        gui: Patch::Missing,
        tui: Patch::Missing,
    })?;
    let config = client.read_config()?;
    let terminal = TerminalSettings::from_tui(&config.tui).map_err(ConfigCommandError)?;
    let status_line = StatusLineSettings::from_tui(&config.tui).map_err(ConfigCommandError)?;
    let providers = client.list_providers()?;
    Ok(ConfigEditResult {
        terminal,
        status_line: status_line.clone(),
        choices: config_choices(&config, &providers, terminal, status_line),
    })
}

fn set_memories<T: JsonRpcTransport>(
    client: &mut AppServerClient<T>,
    edit: ConfigEdit,
) -> Result<ConfigEditResult, ConfigCommandError> {
    let overrides = edit
        .server_config
        .features
        .iter()
        .filter(|state| {
            state.source == features::FeatureSource::User
                || state.feature == features::Feature::Memories
        })
        .map(|state| (state.feature, state.enabled))
        .collect();
    client.update_config(ConfigUpdateParams {
        advisor: Default::default(),
        features: Patch::Value(overrides),
        command_id: new_command_id("memories-config"),
        expected_revision: edit.server_config.revision,
        time_context: Patch::Missing,
        model: Patch::Missing,
        model_reasoning_effort: Patch::Missing,
        approval_review_model: Patch::Missing,
        commit_message_model: Patch::Missing,
        tool_mode: Patch::Missing,
        grep_backend: Patch::Missing,
        git: Patch::Missing,
        gui: Patch::Missing,
        tui: Patch::Missing,
    })?;
    let config = client.read_config()?;
    let terminal = TerminalSettings::from_tui(&config.tui).map_err(ConfigCommandError)?;
    let status_line = StatusLineSettings::from_tui(&config.tui).map_err(ConfigCommandError)?;
    Ok(ConfigEditResult {
        terminal,
        status_line: status_line.clone(),
        choices: config_choices(&config, &edit.providers, terminal, status_line),
    })
}

fn set_issue_settings<T: JsonRpcTransport>(
    client: &mut AppServerClient<T>,
    edit: super::IssueConfigEdit,
) -> Result<ConfigEditResult, ConfigCommandError> {
    client.configure_issues(
        ash_app_server_protocol::protocol::issues::IssueConfigureParams {
            command_id: new_command_id("issues-config"),
            expected_revision: edit.expected_revision,
            config: edit.config,
        },
    )?;
    let config = client.read_config()?;
    let terminal = TerminalSettings::from_tui(&config.tui).map_err(ConfigCommandError)?;
    let status_line = StatusLineSettings::from_tui(&config.tui).map_err(ConfigCommandError)?;
    let providers = client.list_providers()?;
    Ok(ConfigEditResult {
        terminal,
        status_line: status_line.clone(),
        choices: config_choices(&config, &providers, terminal, status_line),
    })
}

fn set_git_settings<T: JsonRpcTransport>(
    client: &mut AppServerClient<T>,
    edit: ConfigEdit,
) -> Result<ConfigEditResult, ConfigCommandError> {
    client.update_config(ConfigUpdateParams {
        advisor: Patch::Missing,
        time_context: Patch::Missing,
        features: Patch::Missing,
        command_id: new_command_id("git-config"),
        expected_revision: edit.server_config.revision,
        model: Patch::Missing,
        model_reasoning_effort: Patch::Missing,
        approval_review_model: Patch::Missing,
        commit_message_model: Patch::Missing,
        tool_mode: Patch::Missing,
        grep_backend: Patch::Missing,
        git: Patch::Value(edit.server_config.git),
        gui: Patch::Missing,
        tui: Patch::Missing,
    })?;
    let config = client.read_config()?;
    let terminal = TerminalSettings::from_tui(&config.tui).map_err(ConfigCommandError)?;
    let status_line = StatusLineSettings::from_tui(&config.tui).map_err(ConfigCommandError)?;
    Ok(ConfigEditResult {
        terminal,
        status_line: status_line.clone(),
        choices: config_choices(&config, &edit.providers, terminal, status_line),
    })
}

fn execute_connection<T: JsonRpcTransport>(
    client: &mut AppServerClient<T>,
    mut request: super::provider::Request,
) -> Result<(ConfigChoices, Option<Result<Vec<String>, String>>), String> {
    let provider = request.config.provider.clone();
    if matches!(request.operation, super::provider::Operation::Test) {
        use ash_app_server_protocol::protocol::provider::ProviderProbeResult;
        let model = request.model.clone();
        let key = request.key.map(|key| key.into_parts().1);
        let result = match client
            .probe_provider(request.config, key, model)
            .map_err(|error| error.to_string())?
        {
            ProviderProbeResult::Passed
                if request.operation == super::provider::Operation::Test =>
            {
                Ok(Vec::new())
            }
            ProviderProbeResult::Failed { message } => Err(message),
            _ => Err("Unexpected endpoint test response".into()),
        };
        return Ok((
            read_config_choices(client).map_err(|error| error.to_string())?,
            Some(result),
        ));
    }
    if request.operation == super::provider::Operation::Remove {
        client
            .remove_provider(
                ash_app_server_protocol::protocol::config::ProviderRemoveParams {
                    command_id: request.id,
                    expected_revision: request.revision,
                    provider: provider.clone(),
                },
            )
            .map_err(|error| error.to_string())?;
        crate::models::remove_provider_pins(client, &provider)?;
        return Ok((
            read_config_choices(client).map_err(|error| error.to_string())?,
            None,
        ));
    }

    let current = client.read_config().map_err(|error| error.to_string())?;
    if let Some(custom) = &mut request.config.custom {
        if let Some(saved) = current
            .providers
            .get(&provider)
            .and_then(|config| config.custom.as_ref())
        {
            custom.order = saved.order;
        }
    }

    if request.operation == super::provider::Operation::Save
        && (current.providers.get(&provider) != Some(&request.config) || current.model.is_none())
    {
        client
            .configure_provider(
                ash_app_server_protocol::protocol::config::ProviderConfigureParams {
                    command_id: request.id,
                    expected_revision: request.revision,
                    config: request.config,
                },
            )
            .map_err(|error| error.to_string())?;
    }
    if let Some(key) = request
        .key
        .filter(|_| request.operation == super::provider::Operation::Save)
    {
        let (provider, key) = key.into_parts();
        client
            .set_provider_api_key(ProviderApiKeySetRequest::new(provider, key))
            .map_err(|error| format!("Provider settings saved; API key was not saved: {error}"))?;
    }

    Ok((
        read_config_choices(client)
            .map_err(|error| format!("Saved; could not refresh provider settings: {error}"))?,
        None,
    ))
}

pub(crate) fn read_config_choices<T>(
    client: &mut AppServerClient<T>,
) -> Result<ConfigChoices, ConfigCommandError>
where
    T: JsonRpcTransport,
{
    let server_config = client.read_config()?;
    let terminal = TerminalSettings::from_tui(&server_config.tui).map_err(ConfigCommandError)?;
    let status_line =
        StatusLineSettings::from_tui(&server_config.tui).map_err(ConfigCommandError)?;
    let providers = client.list_providers()?;
    Ok(config_choices(
        &server_config,
        &providers,
        terminal,
        status_line,
    ))
}

pub(crate) fn set_provider_api_key<T>(
    client: &mut AppServerClient<T>,
    edit: ProviderApiKeyEdit,
) -> Result<ProviderApiKeyUpdate, ConfigCommandError>
where
    T: JsonRpcTransport,
{
    let (provider, api_key) = edit.into_parts();
    let current = client.read_config()?;
    if !current.providers.contains_key(&provider) || current.model.is_none() {
        let config = current
            .providers
            .get(&provider)
            .cloned()
            .unwrap_or_else(
                || ash_app_server_protocol::protocol::config::ProviderConfigDto {
                    provider: provider.clone(),
                    custom: None,
                    base_url: None,
                    max_output_tokens: None,
                    model_context: Default::default(),
                },
            );
        client.configure_provider(
            ash_app_server_protocol::protocol::config::ProviderConfigureParams {
                command_id: new_command_id("provider-config"),
                expected_revision: current.revision,
                config,
            },
        )?;
    }
    client.set_provider_api_key(ProviderApiKeySetRequest::new(provider.clone(), api_key))?;
    let choices = read_config_choices(client)?;
    Ok(ProviderApiKeyUpdate { provider, choices })
}

pub(crate) fn set_settings<T>(
    client: &mut AppServerClient<T>,
    edit: ConfigEdit,
) -> Result<ConfigEditResult, ConfigCommandError>
where
    T: JsonRpcTransport,
{
    let tui = edit
        .terminal
        .write_to_tui(&edit.server_config.tui)
        .map_err(ConfigCommandError)?;
    let tui = edit.status_line.write_to_tui(&tui);
    client.update_config(ConfigUpdateParams {
        advisor: Default::default(),
        time_context: Default::default(),
        features: Default::default(),
        command_id: new_command_id("tui"),
        expected_revision: edit.server_config.revision,
        model: Patch::Missing,
        model_reasoning_effort: Patch::Missing,
        approval_review_model: Patch::Missing,
        commit_message_model: Patch::Missing,
        tool_mode: Patch::Missing,
        grep_backend: Patch::Missing,
        git: Patch::Missing,
        gui: Patch::Missing,
        tui: Patch::Value(tui),
    })?;
    let config = client.read_config()?;
    let terminal = TerminalSettings::from_tui(&config.tui).map_err(ConfigCommandError)?;
    let status_line = StatusLineSettings::from_tui(&config.tui).map_err(ConfigCommandError)?;
    Ok(ConfigEditResult {
        terminal,
        status_line: status_line.clone(),
        choices: config_choices(&config, &edit.providers, terminal, status_line),
    })
}

#[derive(Debug)]
pub(crate) struct ConfigCommandError(String);

impl fmt::Display for ConfigCommandError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl From<ClientError> for ConfigCommandError {
    fn from(error: ClientError) -> Self {
        Self(error.to_string())
    }
}

#[cfg(test)]
#[path = "request_tests.rs"]
mod tests;
