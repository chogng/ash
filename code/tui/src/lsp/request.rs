use super::Command;
use super::Event;
use super::Page;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::config::LanguageServerConfigureParams;
use ash_app_server_protocol::protocol::config::LanguageServerRemoveParams;
use ash_app_server_protocol::protocol::environment::SessionDirListParams;
use ash_app_server_protocol::protocol::environment::SessionDirSelector;
use ash_app_server_protocol::protocol::language::LanguageServersParams;
use ash_protocol::SessionId;

pub(crate) fn execute<T: JsonRpcTransport>(
    client: &mut AppServerClient<T>,
    session_id: Option<&SessionId>,
    command: Command,
) -> Result<Event, String> {
    let mut scope = match command {
        Command::Load(scope) => scope,
        Command::Configure {
            scope,
            revision,
            server_id,
            config,
        } => {
            client
                .configure_language_server(LanguageServerConfigureParams {
                    command_id: crate::client::new_command_id("lsp-configure"),
                    expected_revision: revision,
                    server_id,
                    config,
                })
                .map_err(|error| error.to_string())?;
            scope
        }
        Command::Remove {
            scope,
            revision,
            server_id,
        } => {
            client
                .remove_language_server_configuration(LanguageServerRemoveParams {
                    command_id: crate::client::new_command_id("lsp-remove"),
                    expected_revision: revision,
                    server_id,
                })
                .map_err(|error| error.to_string())?;
            scope
        }
    };
    let config = client.read_config().map_err(|error| error.to_string())?;
    let directories = if let Some(session_id) = session_id {
        client
            .list_session_dirs(SessionDirListParams {
                session_id: session_id.clone(),
            })
            .map_err(|error| error.to_string())?
            .dirs
            .into_iter()
            .map(|dir| SessionDirSelector {
                session_id: session_id.clone(),
                path: dir.path,
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    if scope.directory.is_none() {
        scope.directory = directories.first().cloned();
    }
    let result = client.list_language_servers(LanguageServersParams {
        session_directory: scope.directory.clone(),
        ..Default::default()
    });
    let (servers, error) = match result {
        Ok(result) => (result.servers, None),
        Err(error) => (Vec::new(), Some(error.to_string())),
    };
    Ok(Event(Page {
        scope,
        revision: config.revision,
        configured: config.language_servers,
        servers,
        directories,
        error,
    }))
}
