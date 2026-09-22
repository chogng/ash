#[cfg(test)]
use crate::widgets::list_selection::ListSelectionModel;

/// A fact delivered to the single writer of TUI presentation state.
pub(crate) enum AppEvent {
    Config(crate::config::Event),
    Connectors(crate::connectors::Event),
    Dirs(crate::dirs::Event),
    Git(crate::git::Event),
    Host(crate::host::Event),
    Issues(crate::issues::Event),
    Keymap(crate::keymap_setup::Event),
    Marketplace(crate::marketplace::Event),
    Lsp(crate::lsp::Event),
    Mcp(crate::mcp::Event),
    Memories(crate::memories::Event),
    Models(crate::models::Event),
    Projects(crate::projects::Event),
    Sessions(crate::sessions::Event),
    Skills(crate::skills::Event),
    Status(crate::status::Event),
    Usage(crate::usage::Event),
    Theme(crate::theme::Event),
    Thread(crate::thread::Event),
    CommandPanelClosed,
    #[cfg(test)]
    HelpOpened(ListSelectionModel),
}

macro_rules! app_event_from {
    ($event:ty, $variant:ident) => {
        impl From<$event> for AppEvent {
            fn from(event: $event) -> Self {
                Self::$variant(event)
            }
        }
    };
}

app_event_from!(crate::config::Event, Config);
app_event_from!(crate::connectors::Event, Connectors);
app_event_from!(crate::dirs::Event, Dirs);
app_event_from!(crate::git::Event, Git);
app_event_from!(crate::host::Event, Host);
app_event_from!(crate::keymap_setup::Event, Keymap);
app_event_from!(crate::marketplace::Event, Marketplace);
app_event_from!(crate::lsp::Event, Lsp);
app_event_from!(crate::mcp::Event, Mcp);
app_event_from!(crate::models::Event, Models);
app_event_from!(crate::projects::Event, Projects);
app_event_from!(crate::sessions::Event, Sessions);
app_event_from!(crate::skills::Event, Skills);
app_event_from!(crate::status::Event, Status);
app_event_from!(crate::usage::Event, Usage);
app_event_from!(crate::theme::Event, Theme);
app_event_from!(crate::thread::Event, Thread);

app_event_from!(crate::issues::Event, Issues);

app_event_from!(crate::memories::Event, Memories);
