use crate::thread::composer::TuiSlashCommandAction;

/// A typed side-effect intent emitted by the single-writer application state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum AppCommand {
    Config(crate::config::Command),
    Connectors(crate::connectors::Command),
    Dirs(crate::dirs::Command),
    Git(crate::git::Command),
    Host(crate::host::Command),
    Issues(crate::issues::Command),
    Keymap(crate::keymap_setup::Command),
    Marketplace(crate::marketplace::Command),
    Lsp(crate::lsp::Command),
    Mcp(crate::mcp::Command),
    Memories(crate::memories::Command),
    Models(crate::models::Command),
    Projects(crate::projects::Command),
    Sessions(crate::sessions::Command),
    Skills(crate::skills::Command),
    Status(crate::status::Command),
    Theme(crate::theme::Command),
    Thread(crate::thread::Command),
    Quit,
    Suspend,
}

impl AppCommand {
    pub(super) fn panel_title(&self) -> Option<&'static str> {
        match self {
            Self::Config(crate::config::Command::OpenEditor) => Some("Settings"),
            Self::Git(crate::git::Command::OpenPicker) => Some("Switch branch"),
            Self::Projects(crate::projects::Command::OpenRoots) => Some("Switch project folder"),
            Self::Projects(crate::projects::Command::OpenAddRoot) => Some("Add project folder"),
            Self::Status(crate::status::Command::OpenPanel) => Some("Status"),
            Self::Keymap(crate::keymap_setup::Command::OpenEditor) => Some("Shortcuts"),
            Self::Status(crate::status::Command::OpenLineEditor) => Some("Status line"),
            Self::Theme(crate::theme::Command::OpenPicker) => Some("Theme"),
            Self::Thread(crate::thread::Command::OpenRewindPicker) => Some("Rewind"),
            Self::Thread(crate::thread::Command::ExecuteProductCommand(invocation)) => {
                match invocation
                    .command
                    .name
                    .parse::<TuiSlashCommandAction>()
                    .ok()?
                {
                    TuiSlashCommandAction::Marketplace => Some("Marketplace"),
                    TuiSlashCommandAction::Plugins => Some("Plugins"),
                    TuiSlashCommandAction::Lsp => Some("Language servers"),
                    _ if !invocation.arguments.is_empty() => None,
                    TuiSlashCommandAction::Model => Some("Model"),
                    TuiSlashCommandAction::Resume => Some("Resume session"),
                    TuiSlashCommandAction::Skills => Some("Skills"),
                    TuiSlashCommandAction::Memories => Some("Memories"),
                    TuiSlashCommandAction::Mcp => Some("MCP"),
                    TuiSlashCommandAction::Connectors => Some("Connectors"),
                    TuiSlashCommandAction::Status => Some("Status"),
                    TuiSlashCommandAction::Usage => Some("Usage"),
                    TuiSlashCommandAction::Rewind => Some("Rewind"),
                    TuiSlashCommandAction::AddDir => Some("Directories"),
                    _ => None,
                }
            }
            _ => None,
        }
    }
}

macro_rules! app_command_from {
    ($command:ty, $variant:ident) => {
        impl From<$command> for AppCommand {
            fn from(command: $command) -> Self {
                Self::$variant(command)
            }
        }
    };
}

app_command_from!(crate::config::Command, Config);
app_command_from!(crate::connectors::Command, Connectors);
app_command_from!(crate::dirs::Command, Dirs);
app_command_from!(crate::git::Command, Git);
app_command_from!(crate::host::Command, Host);
app_command_from!(crate::keymap_setup::Command, Keymap);
app_command_from!(crate::marketplace::Command, Marketplace);
app_command_from!(crate::lsp::Command, Lsp);
app_command_from!(crate::mcp::Command, Mcp);
app_command_from!(crate::models::Command, Models);
app_command_from!(crate::projects::Command, Projects);
app_command_from!(crate::sessions::Command, Sessions);
app_command_from!(crate::skills::Command, Skills);
app_command_from!(crate::status::Command, Status);
app_command_from!(crate::theme::Command, Theme);
app_command_from!(crate::thread::Command, Thread);

app_command_from!(crate::issues::Command, Issues);

app_command_from!(crate::memories::Command, Memories);
