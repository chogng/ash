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
use ash_app_server_protocol::protocol::ide::IdeRequest;
use ash_app_server_protocol::protocol::ide::IdeResult;
use ash_app_server_protocol::protocol::ide::IdeWindow;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Command {
    Connect(String),
    Disconnect,
}

pub(crate) enum Event {
    Opened(ListSelectionSpec<Command>),
    Notice(Text),
}

pub(crate) fn execute<T: JsonRpcTransport>(
    client: &mut AppServerClient<T>,
    command: Command,
) -> Result<Event, String> {
    let request = match command {
        Command::Connect(window_id) => IdeRequest::Connect { window_id },
        Command::Disconnect => IdeRequest::Disconnect {},
    };
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
        IdeResult::Connected { window } => Ok(Event::Notice(connection_notice(window.as_ref()))),
        _ => Err("Unexpected IDE connection response".into()),
    }
}

pub(crate) fn open<T: JsonRpcTransport>(
    client: &mut AppServerClient<T>,
    arguments: &str,
) -> Result<Event, ClientError> {
    match arguments {
        "disconnect" | "off" => execute(client, Command::Disconnect).map_err(ClientError::Protocol),
        "" | "status" => {
            let IdeResult::Windows { windows, selected } =
                client.request_ide(IdeRequest::List {})?
            else {
                return Err(ClientError::Protocol(
                    "Unexpected IDE discovery response".into(),
                ));
            };
            if arguments == "status" {
                return Ok(Event::Notice(connection_notice(selected.as_ref())));
            }
            Ok(Event::Opened(choices(&windows, selected.as_ref())))
        }
        _ => Ok(Event::Notice("Usage: /ide [status|disconnect]".into())),
    }
}

fn connection_notice(window: Option<&IdeWindow>) -> Text {
    match window {
        Some(window) => Text::template(
            "Connected to {0}. New messages include editor context.",
            vec![Text::literal(&window.title)],
        ),
        None => "IDE is disconnected. Use /ide to choose a window.".into(),
    }
}

fn choices(windows: &[IdeWindow], selected: Option<&IdeWindow>) -> ListSelectionSpec<Command> {
    let mut actions = BTreeMap::new();
    let items = windows
        .iter()
        .map(|window| {
            let id = ListSelectionItemId::new(&window.id);
            actions.insert(id.clone(), Command::Connect(window.id.clone()));
            let status = if selected.is_some_and(|selected| selected.id == window.id) {
                "Connected"
            } else {
                "Available"
            };
            ListSelectionItem::new(Text::literal(&window.title))
                .with_id(id)
                .with_description(Text::template(
                    "{0} · {1}",
                    vec![status.into(), Text::literal(window.roots.join(", "))],
                ))
        })
        .collect();
    let mut model =
        ListSelectionModel::new("Ash IDE", vec![ListSelectionGroup::new("IDE windows", items)])
            .with_activation(crate::keymap::bindings::ACCEPT)
            .with_empty_message("Open a project in Ash IDE to connect. Press Esc to return.");
    if selected.is_some() {
        let id = ListSelectionItemId::new("disconnect");
        actions.insert(id.clone(), Command::Disconnect);
        model = model.with_action(ListSelectionItem::new("Disconnect IDE").with_id(id));
    }
    ListSelectionSpec { model, actions }
}

#[cfg(test)]
#[path = "ide_tests.rs"]
mod tests;
