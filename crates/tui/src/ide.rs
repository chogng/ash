//! TUI connection commands and presentation for live Ash IDE windows.
use crate::nls::Text;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::list_selection::ListSelectionSpec;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::ClientError;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::ide::IdeOrigin;
use ash_app_server_protocol::protocol::ide::IdeRequest;
use ash_app_server_protocol::protocol::ide::IdeResult;
use ash_app_server_protocol::protocol::ide::IdeWindow;
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Command {
    Connect(String),
}

pub(crate) enum Event {
    Opened(ListSelectionSpec<Command>),
    Notice(Text),
    ConnectionChanged {
        window: Option<IdeWindow>,
        notice: Text,
    },
}

/// Ash integrated terminals attach to their exact owning window before the first message.
pub(crate) fn attach<T: JsonRpcTransport>(
    client: &mut AppServerClient<T>,
    window_key: String,
) -> Result<Event, String> {
    let result = update_connection(client, IdeRequest::Attach { window_key })?;
    // Automatic attachment is shown in the status line, without adding a startup chat notice.
    Ok(match result {
        Event::ConnectionChanged { window, .. } => Event::ConnectionChanged {
            window,
            notice: "".into(),
        },
        other => other,
    })
}

pub(crate) fn execute<T: JsonRpcTransport>(
    client: &mut AppServerClient<T>,
    command: Command,
) -> Result<Event, String> {
    let Command::Connect(window_id) = command;
    update_connection(client, IdeRequest::Connect { window_id })
}

fn update_connection<T: JsonRpcTransport>(
    client: &mut AppServerClient<T>,
    request: IdeRequest,
) -> Result<Event, String> {
    let response = match client.request_ide(request) {
        Ok(response) => response,
        Err(error) => {
            return Ok(Event::Notice(Text::template(
                "Could not update IDE connection: {0}",
                vec![Text::literal(error.to_string())],
            )));
        }
    };
    match response {
        IdeResult::Connected { window } => Ok(Event::ConnectionChanged {
            notice: connection_notice(window.as_ref()),
            window,
        }),
        _ => Err("Unexpected IDE connection response".into()),
    }
}

pub(crate) enum DesktopHandoff {
    Opened,
    Stay(Text),
}

pub(crate) fn open_conversation<T: JsonRpcTransport>(
    client: &mut AppServerClient<T>,
    session_id: ash_protocol::SessionId,
    thread_id: ash_protocol::ThreadId,
) -> Result<DesktopHandoff, ClientError> {
    Ok(match client.request_ide(IdeRequest::OpenConversation { session_id, thread_id })? {
        IdeResult::ConversationOpened {} => DesktopHandoff::Opened,
        IdeResult::ConversationBusy {} => DesktopHandoff::Stay("Finish or stop the current task and clear queued messages, then run /desktop.".into()),
        IdeResult::ConversationUnavailable {} => DesktopHandoff::Stay("Open this project in Ash IDE and connect with /ide, then run /desktop. Desktop handoff requires a local active conversation.".into()),
        _ => return Err(ClientError::Protocol("Unexpected desktop handoff response".into())),
    })
}

/// `/ide` toggles attachment. The normal path connects to the current workspace directly;
/// a picker is needed only when more than one matching window exists.
pub(crate) fn toggle<T: JsonRpcTransport>(
    client: &mut AppServerClient<T>,
    workspace: &Path,
    arguments: &str,
) -> Result<Event, ClientError> {
    if !arguments.is_empty() {
        return Ok(Event::Notice("Usage: /ide".into()));
    }
    let IdeResult::Windows {
        windows,
        selected,
        preferred,
    } = client.request_ide(IdeRequest::List {})?
    else {
        return Err(ClientError::Protocol(
            "Unexpected IDE discovery response".into(),
        ));
    };
    if selected.is_some() {
        return update_connection(client, IdeRequest::Disconnect {}).map_err(ClientError::Protocol);
    }
    if let Some(origin) = preferred {
        return match origin {
            IdeOrigin::Available { window } => execute(client, Command::Connect(window.id)).map_err(ClientError::Protocol),
            IdeOrigin::Unavailable {} => Ok(Event::ConnectionChanged {
                window: None,
                notice: "This terminal's Ash IDE window is unavailable. Reconnect the IDE, then run /ide.".into(),
            }),
        };
    }
    let workspace = workspace
        .canonicalize()
        .unwrap_or_else(|_| workspace.to_path_buf());
    let matching = windows
        .into_iter()
        .filter(|window| window.roots.iter().any(|root| workspace.starts_with(root)))
        .collect::<Vec<_>>();
    match matching.as_slice() {
        [] => Ok(Event::ConnectionChanged {
            window: None,
            notice: "Open this project in Ash IDE, then run /ide to include editor context.".into(),
        }),
        [window] => {
            execute(client, Command::Connect(window.id.clone())).map_err(ClientError::Protocol)
        }
        _ => Ok(Event::Opened(choices(&matching))),
    }
}

fn connection_notice(window: Option<&IdeWindow>) -> Text {
    match window {
        Some(window) => Text::template(
            "Connected to {0}. New messages include editor context.",
            vec![Text::literal(&window.title)],
        ),
        None => "IDE context is off. Run /ide to enable it.".into(),
    }
}

fn choices(windows: &[IdeWindow]) -> ListSelectionSpec<Command> {
    let mut actions = BTreeMap::new();
    let items = windows
        .iter()
        .map(|window| {
            let id = ListSelectionItemId::new(&window.id);
            actions.insert(id.clone(), Command::Connect(window.id.clone()));
            ListSelectionItem::new(Text::literal(&window.title))
                .with_id(id)
                .with_description(Text::literal(window.roots.join(", ")))
        })
        .collect();
    let model = ListSelectionModel::new(
        "Ash IDE",
        vec![ListSelectionGroup::new("IDE windows", items)],
    )
    .with_activation(crate::keymap::bindings::ACCEPT)
    .with_empty_message("Open a project in Ash IDE to connect. Press Esc to return.");
    ListSelectionSpec { model, actions }
}

#[cfg(test)]
#[path = "ide_tests.rs"]
mod tests;
