use super::Command;
use super::Event;
use super::McpChoices;
use super::mcp_choices;
use crate::client::new_command_id;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::ClientError;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::config::McpServerEnablementDto;
use ash_app_server_protocol::protocol::config::McpServerSetEnablementParams;

impl Command {
    pub(crate) const fn request_name(&self) -> &'static str {
        match self {
            Self::SetEnablement { .. } => "ash-tui-set-mcp-enablement",
        }
    }
}

pub(crate) fn execute<T>(client: &mut AppServerClient<T>, command: Command) -> Result<Event, String>
where
    T: JsonRpcTransport,
{
    match command {
        Command::SetEnablement {
            server_id,
            enablement,
        } => set_enablement(client, server_id, enablement),
    }
    .map(Event::SettingsUpdated)
    .map_err(|error| error.to_string())
}

pub(crate) fn load_selection<T>(client: &mut AppServerClient<T>) -> Result<McpChoices, ClientError>
where
    T: JsonRpcTransport,
{
    client
        .read_config()
        .map(|config| mcp_choices(&config.mcp_servers))
}

pub(crate) fn set_enablement<T>(
    client: &mut AppServerClient<T>,
    server_id: String,
    enablement: McpServerEnablementDto,
) -> Result<McpChoices, ClientError>
where
    T: JsonRpcTransport,
{
    let config = client.read_config()?;
    client.set_mcp_server_enablement(McpServerSetEnablementParams {
        command_id: new_command_id("mcp-enablement"),
        expected_revision: config.revision,
        server_id,
        enablement,
    })?;
    load_selection(client)
}
