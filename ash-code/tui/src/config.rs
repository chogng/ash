mod editor;
pub(crate) mod provider;
mod request;
mod settings;
mod subscription;

pub(crate) use subscription::Subscription;
pub(crate) use subscription::SubscriptionCommand;
pub(crate) use subscription::SubscriptionEvent;
pub(crate) use subscription::SubscriptionProvider;

pub(crate) use editor::ConfigChoices;
pub(crate) use editor::ConfigEdit;
pub(crate) use editor::ConfigEditor;
pub(crate) use editor::ConfigEditorOutcome;
pub(crate) use editor::ConfigEditorPage;
pub(crate) use editor::ConfigSelectionAction;
pub(crate) use editor::LanguageServerEdit;
pub(crate) use editor::ProviderApiKeyEdit;
pub(crate) use editor::config_choices;
pub(crate) use request::execute;
#[cfg(test)]
pub(crate) use request::set_settings;
pub(crate) use settings::KeyHintStyle;
pub(crate) use settings::TerminalSettings;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct IssueConfigEdit {
    pub(crate) expected_revision: u64,
    pub(crate) config: ash_app_server_protocol::protocol::issues::IssueConfigDto,
}

pub(crate) struct ConfigEditResult {
    pub(crate) terminal: TerminalSettings,
    pub(crate) status_line: crate::status::StatusLineSettings,
    pub(crate) choices: ConfigChoices,
}

/// A completed configuration operation delivered to the TUI state owner.
pub(crate) enum Event {
    Connection(provider::Reply),
    Subscription(SubscriptionEvent),
    SubscriptionReply(SubscriptionProvider, SubscriptionEvent),
    SettingsReceived(TerminalSettings),
    Updated(ConfigEditResult),
    EditorOpened(ConfigChoices),
    ApiKeySaved {
        provider: String,
        choices: ConfigChoices,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Command {
    SetMemories(ConfigEdit),
    SetIssues(IssueConfigEdit),
    Connection(provider::Request),
    Subscription(SubscriptionProvider, SubscriptionCommand),
    OpenEditor,
    Edit(ConfigEdit),
    SetLanguageServerMode(LanguageServerEdit),
    SetProviderApiKey(ProviderApiKeyEdit),
}
