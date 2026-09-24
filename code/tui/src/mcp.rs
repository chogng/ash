mod request;
mod settings;

/// A completed MCP settings operation delivered to the TUI state owner.
pub(crate) enum Event {
    SettingsOpened(McpChoices),
    SettingsUpdated(McpChoices),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Command {
    SetEnablement {
        server_id: String,
        enablement: ash_app_server_protocol::protocol::config::McpServerEnablementDto,
    },
}

pub(crate) use request::execute;
pub(crate) use request::load_selection;
pub(crate) use settings::McpChoices;
pub(crate) use settings::McpSelectionAction;
pub(crate) use settings::mcp_choices;
