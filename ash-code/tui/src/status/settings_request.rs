use ash_app_server_client::AppServerClient;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::config::ConfigUpdateParams;
use ash_protocol::Patch;

use super::Command;
use super::Event;
use super::StatusLineChoices;
use super::StatusLineItem;
use super::StatusLineSettings;
use super::setup::list_selection;
use crate::client::new_command_id;

impl Command {
    pub(crate) const fn request_name(&self) -> &'static str {
        match self {
            Self::OpenPanel => "ash-tui-read-status",
            Self::OpenLineEditor => "ash-tui-read-status-line",
            Self::EditLine(_) => "ash-tui-set-status-line",
        }
    }
}

pub(crate) fn execute<T>(client: &mut AppServerClient<T>, command: Command) -> Result<Event, String>
where
    T: JsonRpcTransport,
{
    match command {
        Command::OpenPanel => Err("the status panel requires the active Thread scope".into()),
        Command::OpenLineEditor => read_status_line(client).map(Event::LineEditorOpened),
        Command::EditLine(edit) => set_status_line(client, edit).map(Event::LineEditorUpdated),
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct StatusLineEdit {
    pub(crate) expected_revision: u64,
    pub(crate) item: StatusLineItem,
    pub(crate) enabled: bool,
}

pub(crate) struct StatusLineEditorUpdate {
    pub(crate) settings: StatusLineSettings,
    pub(crate) choices: StatusLineChoices,
}

pub(crate) fn read_status_line<T>(
    client: &mut AppServerClient<T>,
) -> Result<StatusLineEditorUpdate, String>
where
    T: JsonRpcTransport,
{
    let config = client.read_config().map_err(|error| error.to_string())?;
    let settings = StatusLineSettings::from_tui(&config.tui)?;
    let choices = list_selection(&settings, config.revision);
    Ok(StatusLineEditorUpdate { settings, choices })
}

pub(crate) fn set_status_line<T>(
    client: &mut AppServerClient<T>,
    edit: StatusLineEdit,
) -> Result<StatusLineEditorUpdate, String>
where
    T: JsonRpcTransport,
{
    let config = client.read_config().map_err(|error| error.to_string())?;
    if config.revision != edit.expected_revision {
        return Err(
            "configuration changed after the status-line editor opened; reopen /statusline and try again"
                .into(),
        );
    }
    let mut settings = StatusLineSettings::from_tui(&config.tui)?;
    settings.set(edit.item, edit.enabled);
    let tui = settings.write_to_tui(&config.tui);
    client
        .update_config(ConfigUpdateParams {
            advisor: Default::default(),
            time_context: Default::default(),
            features: Default::default(),
            command_id: new_command_id("status-line"),
            expected_revision: config.revision,
            model: Patch::Missing,
            model_reasoning_effort: Patch::Missing,
            approval_review_model: Patch::Missing,
            commit_message_model: Patch::Missing,
            tool_mode: Patch::Missing,
            grep_backend: Patch::Missing,
            gui: Patch::Missing,
            tui: Patch::Value(tui),
        })
        .map_err(|error| error.to_string())?;

    let config = client.read_config().map_err(|error| error.to_string())?;
    let settings = StatusLineSettings::from_tui(&config.tui)?;
    let choices = list_selection(&settings, config.revision);
    Ok(StatusLineEditorUpdate { settings, choices })
}
