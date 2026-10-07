use ash_app_server_client::AppServerClient;
use ash_app_server_client::ClientError;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::connectors::ConnectorDeviceOAuthPollParams;
use ash_app_server_protocol::protocol::connectors::ConnectorDeviceOAuthPollResult;
use ash_app_server_protocol::protocol::connectors::ConnectorDeviceOAuthStartParams;
use ash_app_server_protocol::protocol::connectors::ConnectorDisconnectParams;
use ash_app_server_protocol::protocol::connectors::ConnectorOAuthCancelParams;

use super::Command;
use super::ConnectorChoices;
use super::Event;
use super::connector_choices;
use crate::client::new_command_id;

impl Command {
    pub(crate) const fn request_name(&self) -> &'static str {
        match self {
            Self::ConnectDeviceOAuth { .. } => "ash-tui-connect-device-oauth",
            Self::Disconnect { .. } => "ash-tui-disconnect-connector",
        }
    }
}

pub(crate) fn execute<T>(client: &mut AppServerClient<T>, command: Command) -> Result<Event, String>
where
    T: JsonRpcTransport,
{
    match command {
        Command::ConnectDeviceOAuth {
            connector_id,
            connection_generation,
        } => connect_device_oauth(client, connector_id, connection_generation),
        Command::Disconnect { connector_id } => disconnect(client, connector_id),
    }
    .map(Event::PickerUpdated)
    .map_err(|error| error.to_string())
}

pub(crate) fn load_selection<T>(
    client: &mut AppServerClient<T>,
) -> Result<ConnectorChoices, ClientError>
where
    T: JsonRpcTransport,
{
    client
        .list_connectors()
        .map(|catalog| connector_choices(&catalog))
}

pub(crate) fn connect_device_oauth<T>(
    client: &mut AppServerClient<T>,
    connector_id: String,
    connection_generation: u64,
) -> Result<ConnectorChoices, ClientError>
where
    T: JsonRpcTransport,
{
    let catalog = client.list_connectors()?;
    let started = client.start_connector_device_oauth(ConnectorDeviceOAuthStartParams {
        command_id: new_command_id("connector-device-oauth").to_string(),
        expected_generation: catalog.generation,
        connector_id,
        connection_generation,
    })?;
    let authorization = (|| {
        crate::host::clipboard::write_text(&started.user_code).map_err(ClientError::Transport)?;
        crate::host::browser::open_url(&started.verification_uri)
            .map_err(ClientError::Transport)?;
        let deadline =
            std::time::Instant::now() + std::time::Duration::from_secs(started.expires_in_seconds);
        let mut retry_after = started.poll_interval_seconds;
        loop {
            if std::time::Instant::now() >= deadline {
                return Err(ClientError::Transport(
                    "Connector device authorization expired".into(),
                ));
            }
            std::thread::sleep(std::time::Duration::from_secs(retry_after.min(30)));
            match client.poll_connector_device_oauth(ConnectorDeviceOAuthPollParams {
                flow_id: started.flow_id.clone(),
            })? {
                ConnectorDeviceOAuthPollResult::Pending {
                    retry_after_seconds,
                } => retry_after = retry_after_seconds,
                ConnectorDeviceOAuthPollResult::Connected { .. } => return Ok(()),
            }
        }
    })();
    if authorization.is_err() {
        let _ = client.cancel_connector_device_oauth(ConnectorOAuthCancelParams {
            flow_id: started.flow_id,
        });
    }
    authorization?;
    load_selection(client)
}

pub(crate) fn disconnect<T>(
    client: &mut AppServerClient<T>,
    connector_id: String,
) -> Result<ConnectorChoices, ClientError>
where
    T: JsonRpcTransport,
{
    let catalog = client.list_connectors()?;
    client.disconnect_connector(ConnectorDisconnectParams {
        command_id: new_command_id("connector-disconnect").to_string(),
        expected_generation: catalog.generation,
        connector_id,
    })?;
    load_selection(client)
}
