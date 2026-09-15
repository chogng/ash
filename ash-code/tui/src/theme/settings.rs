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
    client.update_config(ConfigUpdateParams {
        time_context: Default::default(),
        features: Default::default(),
        command_id: new_command_id("theme"),
        expected_revision: config.revision,
        model: Patch::Missing,
        model_reasoning_effort: Patch::Missing,
        approval_review_model: Patch::Missing,
        commit_message_model: Patch::Missing,
        tool_mode: Patch::Missing,
        agent_grep_backend: Patch::Missing,
        gui: Patch::Missing,
        tui: Patch::Value(FrontendConfigDto(tui)),
    })?;
    Ok(())
}

pub(crate) fn preference(config: &ConfigReadResult) -> &str {
    config
        .tui
        .0
        .get("theme")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("system")
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
