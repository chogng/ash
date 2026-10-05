use crate::client::new_command_id;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::ClientError;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::config::ConfigReadResult;
use ash_app_server_protocol::protocol::config::ConfigUpdateParams;
use ash_app_server_protocol::protocol::config::FrontendConfigDto;
use ash_protocol::Patch;
use std::fmt;

pub(crate) fn set_preference<T>(
    client: &mut AppServerClient<T>,
    theme: String,
) -> Result<(), ThemeSettingsError>
where
    T: JsonRpcTransport,
{
    let config = client.read_config()?;
    let mut tui = config.tui.0;
    tui.insert("theme".into(), serde_json::Value::String(theme));
    let tui = FrontendConfigDto(tui);
    crate::config::TuiSettings::from_tui(&tui).map_err(ThemeSettingsError)?;
    client.update_config(ConfigUpdateParams {
        context: ash_protocol::Patch::Missing,
        advisor: Default::default(),
        time_context: Default::default(),
        features: Default::default(),
        command_id: new_command_id("theme"),
        expected_revision: config.revision,
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
    Ok(())
}

pub(crate) fn preference(config: &ConfigReadResult) -> Result<&str, String> {
    crate::config::TuiSettings::from_tui(&config.tui)?;
    preference_from_tui(&config.tui)
}

pub(crate) fn preference_from_tui(section: &FrontendConfigDto) -> Result<&str, String> {
    match section.0.get("theme") {
        None => Ok("system"),
        Some(serde_json::Value::String(name)) if !name.trim().is_empty() => Ok(name),
        Some(_) => Err("Invalid [tui].theme: expected a non-empty theme name.".into()),
    }
}

#[derive(Debug)]
pub(crate) struct ThemeSettingsError(String);

impl fmt::Display for ThemeSettingsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl From<ClientError> for ThemeSettingsError {
    fn from(error: ClientError) -> Self {
        Self(error.to_string())
    }
}
