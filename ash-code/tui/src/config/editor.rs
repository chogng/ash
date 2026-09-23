use crate::config::TerminalSettings;
use crate::keymap::bindings;
use crate::nls;
use crate::nls::Language;
use crate::nls::Message;
use crate::status::StatusLineSettings;
use crate::thread::composer::ChatInputMode;
use crate::widgets::key_hint::KeyHints;
use crate::widgets::list_selection::ListSelection;
use crate::widgets::list_selection::ListSelectionAdjustment;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::list_selection::ListSelectionOutcome;
use crate::widgets::list_selection::ListSelectionSpec;
use crate::widgets::search_box::SearchBoxModel;
use crate::widgets::text_prompt::TextPrompt;
use crate::widgets::text_prompt::TextPromptOutcome;
use crate::widgets::text_prompt::TextPromptSpec;
use ash_app_server_protocol::protocol::config::ConfigReadResult;
use ash_app_server_protocol::protocol::config::GitAutoFetchModeDto;
use ash_app_server_protocol::protocol::provider::{
    ProviderApiKeyPolicyDto, ProviderCatalogEntryDto, ProviderListResult,
};
use std::collections::BTreeMap;
use std::fmt;
use std::sync::LazyLock;
use zeroize::Zeroizing;

const ISSUE_REFRESH_ROW: &str = "issue-refresh";
const ISSUE_REFRESH_INTERVALS: [u32; 5] = [0, 5, 10, 30, 60];
const GIT_FETCH_INTERVALS: [u32; 7] = [30, 60, 180, 300, 600, 1800, 3600];

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ConfigEdit {
    pub(crate) terminal: TerminalSettings,
    pub(crate) status_line: StatusLineSettings,
    pub(crate) server_config: ConfigReadResult,
    pub(crate) providers: ProviderListResult,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ConfigSelectionAction {
    SetMemories(ConfigEdit),
    SetIssues(super::IssueConfigEdit),
    AdjustIssueRefresh(super::IssueConfigEdit),
    OpenProvider(super::provider::Settings),
    Connection(super::provider::Request),
    OpenSubscription(super::SubscriptionProvider),
    Subscription(super::SubscriptionCommand),
    SetTerminalSettings(ConfigEdit),
    SetUpdatePolicy(ConfigEdit),
    SetVimMode(ConfigEdit),
    SetShowGitChangesAsDiff(ConfigEdit),
    SetGitMode(ConfigEdit),
    SetGitPeriod(ConfigEdit),
    SetStatusLineStyle(ConfigEdit),
    SetLanguage(ConfigEdit),
    OpenProviderApiKey {
        provider: String,
        display_name: String,
    },
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct ProviderApiKeyEdit {
    provider: String,
    api_key: Zeroizing<String>,
}

impl ProviderApiKeyEdit {
    pub(crate) fn new(provider: String, api_key: String) -> Self {
        Self {
            provider,
            api_key: Zeroizing::new(api_key),
        }
    }

    pub(crate) fn into_parts(mut self) -> (String, String) {
        let provider = std::mem::take(&mut self.provider);
        let api_key = std::mem::take(&mut *self.api_key);
        (provider, api_key)
    }
}

impl fmt::Debug for ProviderApiKeyEdit {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderApiKeyEdit")
            .field("provider", &self.provider)
            .field("api_key", &"[REDACTED]")
            .finish()
    }
}

pub(crate) type ConfigChoices = ListSelectionSpec<ConfigSelectionAction>;

pub(crate) struct ProviderApiKeyPrompt {
    pub(crate) spec: TextPromptSpec,
    pub(crate) provider: String,
}

#[derive(Debug)]
pub(crate) struct ConfigEditor {
    revision: u64,
    selection: ListSelection<ConfigSelectionAction>,
    provider_panel: Option<super::provider::Panel>,
    subscription: Option<ListSelection<ConfigSelectionAction>>,
    prompt: Option<ProviderApiKeyPromptState>,
    removing: Option<super::provider::Request>,
}

#[derive(Debug)]
struct ProviderApiKeyPromptState {
    provider: String,
    prompt: TextPrompt,
    key_hints: crate::widgets::key_hint::KeyHints,
}

#[derive(Debug)]
pub(crate) enum ConfigEditorOutcome {
    Action(ConfigSelectionAction),
    SaveApiKey(ProviderApiKeyEdit),
    Consumed,
    Dismiss,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum ConfigEditorPage<'a> {
    Selection(&'a crate::widgets::list_selection::ListSelectionState),
    Prompt(&'a TextPrompt),
    Provider(&'a super::provider::Panel),
}

impl ConfigEditor {
    pub(crate) fn new(spec: ConfigChoices) -> Self {
        Self {
            revision: config_revision(&spec),
            selection: ListSelection::new(spec.model, spec.actions),
            provider_panel: None,
            subscription: None,
            prompt: None,
            removing: None,
        }
    }

    pub(crate) fn parent_title(&self) -> Option<&str> {
        (self.provider_panel.is_some() || self.prompt.is_some() || self.subscription.is_some())
            .then(|| self.selection.state().title())
    }

    pub(crate) fn return_to_parent(&mut self) {
        if self
            .provider_panel
            .as_ref()
            .is_some_and(|panel| panel.is_saving_pending())
        {
            return;
        }
        self.provider_panel = None;
        self.prompt = None;
        self.subscription = None;
    }

    pub(crate) fn provider_mut(&mut self) -> Option<&mut super::provider::Panel> {
        self.provider_panel.as_mut()
    }

    pub(crate) fn replace(&mut self, spec: ConfigChoices) {
        let revision = config_revision(&spec);
        if revision < self.revision {
            return;
        }
        self.revision = revision;
        if let Some(provider_panel) = &mut self.provider_panel {
            if let Some(ConfigSelectionAction::OpenProvider(settings)) = spec
                .actions
                .values()
                .find(|action| matches!(action, ConfigSelectionAction::OpenProvider(settings) if settings.config.provider == provider_panel.provider_id()))
            {
                provider_panel.replace(settings.clone());
            }
        }
        self.selection.replace(spec.model, spec.actions);
    }

    pub(crate) fn close_prompt_and_replace(&mut self, spec: ConfigChoices) {
        self.prompt = None;
        self.replace(spec);
    }

    pub(crate) fn handle_key(&mut self, key: crossterm::event::KeyEvent) -> ConfigEditorOutcome {
        if let Some(subscription) = self.subscription.as_mut() {
            let outcome = subscription.handle_key(key);
            return self.handle_subscription_outcome(outcome);
        }
        if let Some(prompt) = self.prompt.as_mut() {
            return match prompt.prompt.handle_key(key) {
                TextPromptOutcome::Consumed => ConfigEditorOutcome::Consumed,
                TextPromptOutcome::Dismiss => {
                    self.prompt = None;
                    ConfigEditorOutcome::Consumed
                }
                TextPromptOutcome::Submit(value) => ConfigEditorOutcome::SaveApiKey(
                    ProviderApiKeyEdit::new(prompt.provider.clone(), value),
                ),
            };
        }
        if let Some(provider_panel) = &mut self.provider_panel {
            let outcome = provider_panel.handle_key(key);
            if matches!(outcome, ConfigEditorOutcome::Dismiss) {
                self.provider_panel = None;
                return ConfigEditorOutcome::Consumed;
            }
            return outcome;
        }
        if key.code == crossterm::event::KeyCode::Char('r')
            && key.modifiers.is_empty()
            && self.selection.state().items_focused()
        {
            return if key.kind == crossterm::event::KeyEventKind::Press {
                self.reset_action()
                    .map_or(ConfigEditorOutcome::Consumed, ConfigEditorOutcome::Action)
            } else {
                ConfigEditorOutcome::Consumed
            };
        }
        if key.code == crossterm::event::KeyCode::Delete
            && key.modifiers.is_empty()
            && self.selection.state().items_focused()
            && key.kind == crossterm::event::KeyEventKind::Press
        {
            if self.removing.is_some() {
                return ConfigEditorOutcome::Consumed;
            }
            if let Some(id) = self
                .selection
                .state()
                .selected_item()
                .and_then(ListSelectionItem::id)
                .cloned()
            {
                if let Some(ConfigSelectionAction::OpenProvider(settings)) =
                    self.selection.action(&id)
                {
                    if settings.config.custom.is_some() {
                        let request = super::provider::Request {
                            id: crate::client::new_command_id("provider-remove"),
                            revision: self.revision,
                            config: settings.config.clone(),
                            key: None,
                            operation: super::provider::Operation::Remove,
                            model: None,
                        };
                        self.removing = Some(request.clone());
                        return ConfigEditorOutcome::Action(ConfigSelectionAction::Connection(
                            request,
                        ));
                    }
                }
            }
            return ConfigEditorOutcome::Consumed;
        }
        let outcome = self.selection.handle_key(key);
        self.handle_selection_outcome(outcome)
    }

    pub(crate) fn handle_click(
        &mut self,
        target: &crate::widgets::list_selection::ListSelectionPointerTarget,
        click: crate::widgets::list_selection::ListSelectionClick,
    ) -> ConfigEditorOutcome {
        let focused = self
            .selection_mut()
            .is_some_and(|selection| selection.focus_pointer(target));
        if !focused
            || !matches!(
                target,
                crate::widgets::list_selection::ListSelectionPointerTarget::Item(_)
            )
        {
            return ConfigEditorOutcome::Consumed;
        }
        // General settings select on a single click; other pages retain direct activation.
        let general = self.subscription.is_none() && self.selected_setting().is_some();
        if general && click == crate::widgets::list_selection::ListSelectionClick::Single {
            return ConfigEditorOutcome::Consumed;
        }
        self.handle_key(crossterm::event::KeyEvent::new(
            crossterm::event::KeyCode::Enter,
            crossterm::event::KeyModifiers::NONE,
        ))
    }

    fn selected_setting(&self) -> Option<&ConfigSelectionAction> {
        let id = self.selection.state().selected_item()?.id()?;
        let action = self.selection.action(id)?;
        matches!(
            action,
            ConfigSelectionAction::SetVimMode(_)
                | ConfigSelectionAction::SetLanguage(_)
                | ConfigSelectionAction::SetUpdatePolicy(_)
                | ConfigSelectionAction::SetShowGitChangesAsDiff(_)
                | ConfigSelectionAction::SetGitMode(_)
                | ConfigSelectionAction::SetGitPeriod(_)
                | ConfigSelectionAction::SetStatusLineStyle(_)
                | ConfigSelectionAction::SetTerminalSettings(_)
                | ConfigSelectionAction::SetMemories(_)
        )
        .then_some(action)
    }

    fn reset_action(&self) -> Option<ConfigSelectionAction> {
        let id = self.selection.state().selected_item()?.id()?;
        let mut action = self.selected_setting()?.clone();
        let defaults = TerminalSettings::default();
        let status_defaults = StatusLineSettings::default();
        match &mut action {
            ConfigSelectionAction::SetMemories(edit) => {
                for state in &mut edit.server_config.features {
                    if state.feature == features::Feature::Memories {
                        state.enabled = features::Feature::Memories.default_enabled();
                    }
                }
            }
            ConfigSelectionAction::SetVimMode(edit) => {
                edit.terminal.set_input_mode(defaults.input_mode());
            }
            ConfigSelectionAction::SetLanguage(edit) => {
                edit.terminal.set_language(defaults.language());
            }
            ConfigSelectionAction::SetUpdatePolicy(edit) => {
                edit.terminal.set_auto_update(defaults.auto_update());
            }
            ConfigSelectionAction::SetShowGitChangesAsDiff(edit) => {
                edit.status_line
                    .set_show_git_changes_as_diff(status_defaults.show_git_changes_as_diff());
            }
            ConfigSelectionAction::SetGitMode(edit) => {
                edit.server_config.git.autofetch = GitAutoFetchModeDto::Off;
            }
            ConfigSelectionAction::SetGitPeriod(edit) => {
                edit.server_config.git.autofetch_period = 180;
            }
            ConfigSelectionAction::SetStatusLineStyle(edit) => {
                edit.status_line.set_style(status_defaults.style());
            }
            ConfigSelectionAction::SetTerminalSettings(edit) => {
                if *id == ListSelectionItemId::new("screen-mode") {
                    edit.terminal.set_screen_mode(defaults.screen_mode());
                } else if *id == ListSelectionItemId::new("key-hint-style") {
                    edit.terminal.set_key_hint_style(defaults.key_hint_style());
                } else if *id == ListSelectionItemId::new("memory-diagnostics") {
                    edit.terminal
                        .set_memory_diagnostics(defaults.memory_diagnostics());
                } else {
                    return None;
                }
            }
            _ => return None,
        }
        Some(action)
    }

    fn handle_selection_outcome(
        &mut self,
        outcome: ListSelectionOutcome<ConfigSelectionAction>,
    ) -> ConfigEditorOutcome {
        match outcome {
            ListSelectionOutcome::Activate(ConfigSelectionAction::SetLanguage(edit)) => {
                language_outcome(edit, ListSelectionAdjustment::Next)
            }
            ListSelectionOutcome::Activate(ConfigSelectionAction::SetUpdatePolicy(edit)) => {
                update_policy_outcome(edit, ListSelectionAdjustment::Next)
            }
            ListSelectionOutcome::Activate(ConfigSelectionAction::AdjustIssueRefresh(edit)) => {
                issue_refresh_outcome(edit, ListSelectionAdjustment::Next)
            }
            ListSelectionOutcome::Activate(ConfigSelectionAction::SetGitMode(edit)) => {
                git_mode_outcome(edit, ListSelectionAdjustment::Next)
            }
            ListSelectionOutcome::Activate(ConfigSelectionAction::SetGitPeriod(edit)) => {
                git_period_outcome(edit, ListSelectionAdjustment::Next)
            }
            ListSelectionOutcome::Activate(ConfigSelectionAction::OpenProvider(settings)) => {
                self.provider_panel = Some(super::provider::Panel::new(settings));
                ConfigEditorOutcome::Consumed
            }
            ListSelectionOutcome::Activate(ConfigSelectionAction::OpenProviderApiKey {
                provider,
                display_name,
            }) => {
                self.open_provider_prompt(provider, display_name);
                ConfigEditorOutcome::Consumed
            }
            ListSelectionOutcome::Activate(action) => ConfigEditorOutcome::Action(action),
            ListSelectionOutcome::Adjust(action, adjustment) => match action {
                ConfigSelectionAction::OpenProviderApiKey { .. }
                | ConfigSelectionAction::OpenProvider(_)
                | ConfigSelectionAction::Connection(_)
                | ConfigSelectionAction::OpenSubscription(_)
                | ConfigSelectionAction::Subscription(_) => ConfigEditorOutcome::Consumed,
                ConfigSelectionAction::SetLanguage(edit) => language_outcome(edit, adjustment),
                ConfigSelectionAction::SetUpdatePolicy(edit) => {
                    update_policy_outcome(edit, adjustment)
                }
                ConfigSelectionAction::AdjustIssueRefresh(edit) => {
                    issue_refresh_outcome(edit, adjustment)
                }
                ConfigSelectionAction::SetGitMode(edit) => git_mode_outcome(edit, adjustment),
                ConfigSelectionAction::SetGitPeriod(edit) => git_period_outcome(edit, adjustment),
                action => ConfigEditorOutcome::Action(action),
            },
            ListSelectionOutcome::Consumed | ListSelectionOutcome::FocusPrevious => {
                ConfigEditorOutcome::Consumed
            }
            ListSelectionOutcome::Dismiss => {
                if self.provider_panel.take().is_some() {
                    ConfigEditorOutcome::Consumed
                } else {
                    ConfigEditorOutcome::Dismiss
                }
            }
        }
    }

    pub(crate) fn handle_paste(&mut self, pasted: String) {
        if let Some(subscription) = self.subscription.as_mut() {
            subscription.handle_paste(pasted);
        } else if let Some(prompt) = self.prompt.as_mut() {
            prompt.prompt.handle_paste(pasted);
        } else if let Some(provider_panel) = self.provider_panel.as_mut() {
            provider_panel.handle_paste(pasted);
        } else {
            self.selection.handle_paste(pasted);
        }
    }

    pub(crate) fn page(&self) -> ConfigEditorPage<'_> {
        if let Some(subscription) = &self.subscription {
            return ConfigEditorPage::Selection(subscription.state());
        }
        match &self.prompt {
            Some(prompt) => ConfigEditorPage::Prompt(&prompt.prompt),
            None => self.provider_panel.as_ref().map_or_else(
                || ConfigEditorPage::Selection(self.selection.state()),
                ConfigEditorPage::Provider,
            ),
        }
    }

    pub(crate) fn key_hints(&self) -> &KeyHints {
        static CUSTOM_PROVIDER: LazyLock<KeyHints> = LazyLock::new(|| {
            KeyHints::new()
                .with_action("Enter", "edit")
                .with_action("Delete", "remove provider")
                .with_action("Esc", "return")
        });
        static RESET: LazyLock<KeyHints> = LazyLock::new(|| {
            KeyHints::compact()
                .with_compact_action("Enter", "change")
                .with_compact_action("r", "reset")
                .with_compact_action("←/→", "details")
                .with_compact_action("Tab", "tabs")
                .with_compact_action("/", "search")
                .with_compact_action("Esc", "close")
        });
        if let Some(subscription) = &self.subscription {
            return subscription.key_hints();
        }
        self.prompt
            .as_ref()
            .map(|prompt| &prompt.key_hints)
            .unwrap_or_else(|| {
                if let Some(provider_panel) = &self.provider_panel {
                    provider_panel.key_hints()
                } else {
                    if self.selection.state().items_focused() && self.selected_setting().is_some() {
                        return &RESET;
                    }
                    if self.selection.state().items_focused() && self.selection.state().selected_item().and_then(ListSelectionItem::id).and_then(|id| self.selection.action(id)).is_some_and(|action| matches!(action, ConfigSelectionAction::OpenProvider(settings) if settings.config.custom.is_some())) {
                        &CUSTOM_PROVIDER
                    } else { self.selection.key_hints() }
                }
            })
    }

    pub(crate) fn selection(&self) -> Option<&crate::widgets::list_selection::ListSelectionState> {
        if let Some(subscription) = &self.subscription {
            return Some(subscription.state());
        }
        (self.prompt.is_none() && self.provider_panel.is_none()).then(|| self.selection.state())
    }

    pub(crate) fn selection_mut(
        &mut self,
    ) -> Option<&mut crate::widgets::list_selection::ListSelectionState> {
        if let Some(subscription) = &mut self.subscription {
            return Some(subscription.state_mut());
        }
        (self.prompt.is_none() && self.provider_panel.is_none()).then(|| self.selection.state_mut())
    }

    pub(crate) fn open_subscription(&mut self, spec: ConfigChoices) {
        self.subscription = Some(ListSelection::new(spec.model, spec.actions));
    }

    pub(crate) fn is_testing(&self) -> bool {
        self.provider_panel
            .as_ref()
            .is_some_and(|panel| panel.is_testing())
    }

    pub(crate) fn complete_connection(&mut self, reply: super::provider::Reply) {
        let removing = self
            .removing
            .as_ref()
            .is_some_and(|request| request.id == reply.id);
        let saving = self
            .provider_panel
            .as_ref()
            .is_some_and(|panel| panel.is_saving(&reply.id));
        if !removing
            && self
                .provider_panel
                .as_ref()
                .is_none_or(|panel| !panel.accepts(&reply.id))
        {
            return;
        }
        let focus = if removing {
            None
        } else {
            self.provider_panel
                .as_ref()
                .map(|panel| ListSelectionItemId::new(panel.provider_id()))
        };
        if removing {
            self.removing = None;
        }
        if saving || removing {
            match &reply.result {
                Ok((choices, _)) if config_revision(choices) >= self.revision => {
                    self.revision = config_revision(choices);
                    if saving {
                        self.selection =
                            ListSelection::new(choices.model.clone(), choices.actions.clone());
                    } else {
                        self.selection
                            .replace(choices.model.clone(), choices.actions.clone());
                    }
                    if let Some(id) = focus {
                        self.selection.state_mut().focus_item(&id);
                    }
                }
                Err(message) if removing => self
                    .selection
                    .state_mut()
                    .set_message(Some(message.clone())),
                _ => {}
            }
        }
        if let Some(panel) = self.provider_panel.as_mut() {
            panel.complete(reply);
        }
    }

    pub(crate) fn update_subscription(&mut self, spec: ConfigChoices) {
        if let Some(subscription) = self.subscription.as_mut() {
            subscription.replace(spec.model, spec.actions);
        }
    }

    fn handle_subscription_outcome(
        &mut self,
        outcome: ListSelectionOutcome<ConfigSelectionAction>,
    ) -> ConfigEditorOutcome {
        match outcome {
            ListSelectionOutcome::Activate(action) => ConfigEditorOutcome::Action(action),
            ListSelectionOutcome::Dismiss => {
                self.subscription = None;
                ConfigEditorOutcome::Consumed
            }
            _ => ConfigEditorOutcome::Consumed,
        }
    }

    fn open_provider_prompt(&mut self, provider: String, display_name: String) {
        let prompt = provider_api_key_prompt(provider, display_name);
        self.prompt = Some(ProviderApiKeyPromptState {
            provider: prompt.provider,
            prompt: TextPrompt::new(prompt.spec),
            key_hints: crate::widgets::key_hint::KeyHints::new()
                .with_binding(bindings::SAVE)
                .with_binding(bindings::CANCEL),
        });
    }
}

fn config_revision(choices: &ConfigChoices) -> u64 {
    choices
        .actions
        .values()
        .find_map(|action| match action {
            ConfigSelectionAction::OpenProvider(settings) => Some(settings.revision),
            ConfigSelectionAction::SetIssues(edit)
            | ConfigSelectionAction::AdjustIssueRefresh(edit) => Some(edit.expected_revision),
            _ => None,
        })
        .unwrap_or_default()
}

pub(crate) fn config_choices(
    config: &ConfigReadResult,
    providers: &ProviderListResult,
    terminal: TerminalSettings,
    status_line: StatusLineSettings,
) -> ConfigChoices {
    let mut actions = BTreeMap::new();
    let language = terminal.language();
    let memories_id = ListSelectionItemId::new("memories");
    let mut memories_config = config.clone();
    let memories = memories_config
        .features
        .iter_mut()
        .find(|state| state.feature == features::Feature::Memories)
        .expect("config includes the memories feature");
    let memories_enabled = memories.enabled;
    memories.enabled = !memories_enabled;
    actions.insert(
        memories_id.clone(),
        ConfigSelectionAction::SetMemories(ConfigEdit {
            terminal,
            status_line: status_line.clone(),
            server_config: memories_config,
            providers: providers.clone(),
        }),
    );
    let screen_id = ListSelectionItemId::new("screen-mode");
    let mut next_screen = terminal;
    next_screen.set_screen_mode(terminal.screen_mode().next());
    actions.insert(
        screen_id.clone(),
        ConfigSelectionAction::SetTerminalSettings(ConfigEdit {
            terminal: next_screen,
            status_line: status_line.clone(),
            server_config: config.clone(),
            providers: providers.clone(),
        }),
    );
    let language_id = ListSelectionItemId::new("language");
    actions.insert(
        language_id.clone(),
        ConfigSelectionAction::SetLanguage(ConfigEdit {
            terminal,
            status_line: status_line.clone(),
            server_config: config.clone(),
            providers: providers.clone(),
        }),
    );
    let vim_mode_id = ListSelectionItemId::new("terminal-vim-mode");
    let vim_mode = terminal.input_mode() == ChatInputMode::Vim;
    let mut toggled_terminal = terminal;
    toggled_terminal.set_input_mode(if vim_mode {
        ChatInputMode::Standard
    } else {
        ChatInputMode::Vim
    });
    actions.insert(
        vim_mode_id.clone(),
        ConfigSelectionAction::SetVimMode(ConfigEdit {
            terminal: toggled_terminal,
            status_line: status_line.clone(),
            server_config: config.clone(),
            providers: providers.clone(),
        }),
    );
    let key_hint_style_id = ListSelectionItemId::new("key-hint-style");
    let mut next_key_hint_style = terminal;
    next_key_hint_style.set_key_hint_style(terminal.key_hint_style().next());
    actions.insert(
        key_hint_style_id.clone(),
        ConfigSelectionAction::SetTerminalSettings(ConfigEdit {
            terminal: next_key_hint_style,
            status_line: status_line.clone(),
            server_config: config.clone(),
            providers: providers.clone(),
        }),
    );
    let (key_hint_style_label, key_hint_style_description) = match terminal.key_hint_style() {
        crate::config::KeyHintStyle::Contrast => (
            Message::ConfigKeyHintContrast,
            Message::ConfigKeyHintContrastDescription,
        ),
        crate::config::KeyHintStyle::Muted => (
            Message::ConfigKeyHintMuted,
            Message::ConfigKeyHintMutedDescription,
        ),
    };
    let memory_diagnostics_id = ListSelectionItemId::new("memory-diagnostics");
    let memory_diagnostics = terminal.memory_diagnostics();
    let mut toggled_terminal = terminal;
    toggled_terminal.set_memory_diagnostics(!memory_diagnostics);
    actions.insert(
        memory_diagnostics_id.clone(),
        ConfigSelectionAction::SetTerminalSettings(ConfigEdit {
            terminal: toggled_terminal,
            status_line: status_line.clone(),
            server_config: config.clone(),
            providers: providers.clone(),
        }),
    );
    let auto_update_id = ListSelectionItemId::new("auto-update");
    let auto_update = terminal.auto_update();
    actions.insert(
        auto_update_id.clone(),
        ConfigSelectionAction::SetUpdatePolicy(ConfigEdit {
            terminal,
            status_line: status_line.clone(),
            server_config: config.clone(),
            providers: providers.clone(),
        }),
    );
    let git_changes_id = ListSelectionItemId::new("show-git-changes-as-diff");
    let git_mode_id = ListSelectionItemId::new("git-autofetch");
    actions.insert(
        git_mode_id.clone(),
        ConfigSelectionAction::SetGitMode(ConfigEdit {
            terminal,
            status_line: status_line.clone(),
            server_config: config.clone(),
            providers: providers.clone(),
        }),
    );
    let git_period_id = ListSelectionItemId::new("git-autofetch-period");
    actions.insert(
        git_period_id.clone(),
        ConfigSelectionAction::SetGitPeriod(ConfigEdit {
            terminal,
            status_line: status_line.clone(),
            server_config: config.clone(),
            providers: providers.clone(),
        }),
    );
    let show_git_changes_as_diff = status_line.show_git_changes_as_diff();
    let mut toggled_status_line = status_line.clone();
    toggled_status_line.set_show_git_changes_as_diff(!show_git_changes_as_diff);
    actions.insert(
        git_changes_id.clone(),
        ConfigSelectionAction::SetShowGitChangesAsDiff(ConfigEdit {
            terminal,
            status_line: toggled_status_line,
            server_config: config.clone(),
            providers: providers.clone(),
        }),
    );
    let style_id = ListSelectionItemId::new("status-line-style");
    let mut next_status_line = status_line.clone();
    next_status_line.set_style(status_line.style().next());
    actions.insert(
        style_id.clone(),
        ConfigSelectionAction::SetStatusLineStyle(ConfigEdit {
            terminal,
            status_line: next_status_line,
            server_config: config.clone(),
            providers: providers.clone(),
        }),
    );
    let (style_label, style_description) = match status_line.style() {
        crate::status::StatusLineStyle::Compact => (
            Message::ConfigStatusLineSimple,
            Message::ConfigStatusLineSimpleDescription,
        ),
        crate::status::StatusLineStyle::Rich => (
            Message::ConfigStatusLineExpressive,
            Message::ConfigStatusLineExpressiveDescription,
        ),
    };
    let mut issue_items = Vec::new();
    let issue_refresh_id = ListSelectionItemId::new(ISSUE_REFRESH_ROW);
    actions.insert(
        issue_refresh_id.clone(),
        ConfigSelectionAction::AdjustIssueRefresh(super::IssueConfigEdit {
            expected_revision: config.revision,
            config: config.issues.clone(),
        }),
    );
    issue_items.push(
        ListSelectionItem::new("Auto refresh")
            .with_id(issue_refresh_id)
            .with_columns(
                "Auto refresh",
                "",
                issue_refresh_label(config.issues.auto_refresh_minutes),
            ),
    );
    let issue_tab =
        ListSelectionGroup::new(nls::text(language, Message::ConfigIssues), issue_items);
    let config_items = vec![
        ListSelectionItem::new(nls::text(language, Message::ConfigVimMode))
            .with_id(vim_mode_id)
            .with_columns(
                nls::text(language, Message::ConfigVimMode),
                nls::text(language, Message::ConfigVimModeDescription),
                switch_value(vim_mode),
            ),
        ListSelectionItem::new(nls::text(language, Message::ConfigMemoryDiagnostics))
            .with_id(memory_diagnostics_id)
            .with_columns(
                nls::text(language, Message::ConfigMemoryDiagnostics),
                nls::text(language, Message::ConfigMemoryDiagnosticsDescription),
                switch_value(memory_diagnostics),
            ),
        ListSelectionItem::new(nls::text(language, Message::ConfigAutoUpdate))
            .with_id(auto_update_id)
            .with_columns(
                nls::text(language, Message::ConfigAutoUpdate),
                nls::text(language, Message::ConfigAutoUpdateDescription),
                update_policy_label(language, auto_update),
            ),
        ListSelectionItem::new(nls::text(language, Message::ConfigGitChangesAsDiff))
            .with_id(git_changes_id)
            .with_columns(
                nls::text(language, Message::ConfigGitChangesAsDiff),
                nls::text(language, Message::ConfigGitChangesAsDiffDescription),
                switch_value(show_git_changes_as_diff),
            ),
        ListSelectionItem::new(nls::text(language, Message::ConfigLanguage))
            .with_id(language_id)
            .with_columns(
                nls::text(language, Message::ConfigLanguage),
                nls::text(language, Message::ConfigLanguageDescription),
                language.label(),
            ),
        ListSelectionItem::new(nls::text(language, Message::ConfigStatusLineStyle))
            .with_id(style_id)
            .with_columns(
                nls::text(language, Message::ConfigStatusLineStyle),
                nls::text(language, style_description),
                nls::text(language, style_label),
            ),
        ListSelectionItem::new(nls::text(language, Message::ConfigKeyHintStyle))
            .with_id(key_hint_style_id)
            .with_columns(
                nls::text(language, Message::ConfigKeyHintStyle),
                nls::text(language, key_hint_style_description),
                nls::text(language, key_hint_style_label),
            ),
        ListSelectionItem::new(nls::text(language, Message::ConfigScreenMode))
            .with_id(screen_id)
            .with_columns(
                nls::text(language, Message::ConfigScreenMode),
                nls::text(language, Message::ConfigScreenModeDescription),
                terminal.screen_mode().label(),
            ),
    ];
    let mut config_items = config_items;
    config_items.push(
        ListSelectionItem::new(nls::localize(language, "Memories"))
            .with_id(memories_id)
            .with_columns(
                nls::localize(language, "Memories"),
                nls::localize(
                    language,
                    "Allow model recall and saving; existing memories are kept when off",
                ),
                switch_value(memories_enabled),
            ),
    );
    config_items.push(
        ListSelectionItem::new(nls::text(language, Message::ConfigGitAutoFetch))
            .with_id(git_mode_id)
            .with_columns(
                nls::text(language, Message::ConfigGitAutoFetch),
                nls::text(language, Message::ConfigGitAutoFetchDescription),
                git_mode_label(language, config.git.autofetch),
            ),
    );
    config_items.push(
        ListSelectionItem::new(nls::text(language, Message::ConfigGitAutoFetchPeriod))
            .with_id(git_period_id)
            .with_columns(
                nls::text(language, Message::ConfigGitAutoFetchPeriod),
                nls::text(language, Message::ConfigGitAutoFetchPeriodDescription),
                format!("{}s", config.git.autofetch_period),
            ),
    );
    let provider_items = provider_items(config, providers, &mut actions);
    let mut choices = ConfigChoices {
        model: ListSelectionModel::new(
            nls::text(language, Message::ConfigTitle),
            vec![
                ListSelectionGroup::new(nls::text(language, Message::ConfigGeneral), config_items),
                ListSelectionGroup::new(
                    nls::text(language, Message::ConfigProviders),
                    provider_items,
                ),
                issue_tab,
            ],
        )
        .with_expandable_descriptions()
        .with_activation(bindings::CONFIG_CHANGE)
        .with_search(SearchBoxModel::new(nls::text(
            language,
            Message::ConfigSearch,
        )))
        .with_empty_message(nls::text(language, Message::ConfigNoMatches)),
        actions,
    };
    choices.model.localize(language);
    choices
}

fn language_outcome(
    mut edit: ConfigEdit,
    adjustment: ListSelectionAdjustment,
) -> ConfigEditorOutcome {
    let language = match adjustment {
        ListSelectionAdjustment::Previous => edit.terminal.language().previous(),
        ListSelectionAdjustment::Next => edit.terminal.language().next(),
    };
    edit.terminal.set_language(language);
    ConfigEditorOutcome::Action(ConfigSelectionAction::SetLanguage(edit))
}

fn update_policy_outcome(
    mut edit: ConfigEdit,
    adjustment: ListSelectionAdjustment,
) -> ConfigEditorOutcome {
    let policy = match adjustment {
        ListSelectionAdjustment::Previous => previous_update_policy(edit.terminal.auto_update()),
        ListSelectionAdjustment::Next => next_update_policy(edit.terminal.auto_update()),
    };
    edit.terminal.set_auto_update(policy);
    ConfigEditorOutcome::Action(ConfigSelectionAction::SetUpdatePolicy(edit))
}

const fn next_update_policy(policy: crate::UpdatePolicy) -> crate::UpdatePolicy {
    match policy {
        crate::UpdatePolicy::Latest => crate::UpdatePolicy::Stable,
        crate::UpdatePolicy::Stable => crate::UpdatePolicy::Never,
        crate::UpdatePolicy::Never => crate::UpdatePolicy::Latest,
    }
}

const fn previous_update_policy(policy: crate::UpdatePolicy) -> crate::UpdatePolicy {
    match policy {
        crate::UpdatePolicy::Latest => crate::UpdatePolicy::Never,
        crate::UpdatePolicy::Stable => crate::UpdatePolicy::Latest,
        crate::UpdatePolicy::Never => crate::UpdatePolicy::Stable,
    }
}

fn update_policy_label(language: Language, policy: crate::UpdatePolicy) -> &'static str {
    match policy {
        crate::UpdatePolicy::Latest => nls::text(language, Message::ConfigUpdateLatest),
        crate::UpdatePolicy::Stable => nls::text(language, Message::ConfigUpdateStable),
        crate::UpdatePolicy::Never => nls::text(language, Message::ConfigUpdateNever),
    }
}

fn git_mode_outcome(
    mut edit: ConfigEdit,
    adjustment: ListSelectionAdjustment,
) -> ConfigEditorOutcome {
    edit.server_config.git.autofetch = match (edit.server_config.git.autofetch, adjustment) {
        (GitAutoFetchModeDto::Off, ListSelectionAdjustment::Next)
        | (GitAutoFetchModeDto::All, ListSelectionAdjustment::Previous) => {
            GitAutoFetchModeDto::Default
        }
        (GitAutoFetchModeDto::Default, ListSelectionAdjustment::Next)
        | (GitAutoFetchModeDto::Off, ListSelectionAdjustment::Previous) => GitAutoFetchModeDto::All,
        (GitAutoFetchModeDto::All, ListSelectionAdjustment::Next)
        | (GitAutoFetchModeDto::Default, ListSelectionAdjustment::Previous) => {
            GitAutoFetchModeDto::Off
        }
    };
    ConfigEditorOutcome::Action(ConfigSelectionAction::SetGitMode(edit))
}

fn git_period_outcome(
    mut edit: ConfigEdit,
    adjustment: ListSelectionAdjustment,
) -> ConfigEditorOutcome {
    let current = edit.server_config.git.autofetch_period;
    edit.server_config.git.autofetch_period = match adjustment {
        ListSelectionAdjustment::Next => GIT_FETCH_INTERVALS
            .iter()
            .copied()
            .find(|period| *period > current)
            .unwrap_or(GIT_FETCH_INTERVALS[0]),
        ListSelectionAdjustment::Previous => GIT_FETCH_INTERVALS
            .iter()
            .copied()
            .rev()
            .find(|period| *period < current)
            .unwrap_or(GIT_FETCH_INTERVALS[GIT_FETCH_INTERVALS.len() - 1]),
    };
    ConfigEditorOutcome::Action(ConfigSelectionAction::SetGitPeriod(edit))
}

fn git_mode_label(language: Language, mode: GitAutoFetchModeDto) -> &'static str {
    match mode {
        GitAutoFetchModeDto::Off => nls::text(language, Message::ConfigGitFetchOff),
        GitAutoFetchModeDto::Default => nls::text(language, Message::ConfigGitFetchDefault),
        GitAutoFetchModeDto::All => nls::text(language, Message::ConfigGitFetchAll),
    }
}

fn issue_refresh_outcome(
    mut edit: super::IssueConfigEdit,
    adjustment: ListSelectionAdjustment,
) -> ConfigEditorOutcome {
    let current = ISSUE_REFRESH_INTERVALS
        .iter()
        .position(|minutes| *minutes == edit.config.auto_refresh_minutes)
        .expect("validated issue refresh interval");
    let next = match adjustment {
        ListSelectionAdjustment::Previous => current
            .checked_sub(1)
            .unwrap_or(ISSUE_REFRESH_INTERVALS.len() - 1),
        ListSelectionAdjustment::Next => (current + 1) % ISSUE_REFRESH_INTERVALS.len(),
    };
    edit.config.auto_refresh_minutes = ISSUE_REFRESH_INTERVALS[next];
    ConfigEditorOutcome::Action(ConfigSelectionAction::SetIssues(edit))
}

fn issue_refresh_label(minutes: u32) -> &'static str {
    match minutes {
        0 => "Never",
        5 => "5m",
        10 => "10m",
        30 => "30m",
        60 => "1h",
        _ => unreachable!("validated issue refresh interval"),
    }
}

const fn switch_value(checked: bool) -> &'static str {
    if checked { "on" } else { "off" }
}

pub(crate) fn provider_api_key_prompt(
    provider: String,
    display_name: String,
) -> ProviderApiKeyPrompt {
    ProviderApiKeyPrompt {
        spec: TextPromptSpec {
            title: format!("{display_name} API key"),
            explanation: "The key is hidden and stored in the profile secret store".into(),
            placeholder: "Enter API key".into(),
            masked: true,
        },
        provider,
    }
}

fn provider_items(
    config: &ConfigReadResult,
    catalog: &ProviderListResult,
    actions: &mut BTreeMap<ListSelectionItemId, ConfigSelectionAction>,
) -> Vec<ListSelectionItem> {
    let mut custom = config
        .providers
        .values()
        .filter(|entry| entry.custom.is_some())
        .collect::<Vec<_>>();
    custom.sort_by(|left, right| {
        right
            .custom
            .as_ref()
            .unwrap()
            .order
            .cmp(&left.custom.as_ref().unwrap().order)
            .then_with(|| left.provider.cmp(&right.provider))
    });
    let mut items = Vec::new();
    for entry in custom {
        let id = ListSelectionItemId::new(&entry.provider);
        actions.insert(
            id.clone(),
            ConfigSelectionAction::OpenProvider(super::provider::Settings::new(
                config,
                catalog,
                &entry.provider,
            )),
        );
        items.push(ListSelectionItem::new(&entry.custom.as_ref().unwrap().name).with_id(id));
    }
    for provider in &catalog.providers {
        if config
            .providers
            .get(&provider.provider)
            .is_some_and(|entry| entry.custom.is_some())
            || provider.provider == "openai-compatible"
        {
            continue;
        }
        if provider.provider == "xai-subscription" {
            let id = ListSelectionItemId::new("xai-subscription");
            actions.insert(
                id.clone(),
                ConfigSelectionAction::OpenSubscription(super::SubscriptionProvider::Xai),
            );
            items.push(ListSelectionItem::new("xAI Subscription").with_id(id));
        } else if provider.provider == "openai-chatgpt" {
            let id = ListSelectionItemId::new("openai-chatgpt");
            actions.insert(
                id.clone(),
                ConfigSelectionAction::OpenSubscription(super::SubscriptionProvider::ChatGpt),
            );
            items.push(ListSelectionItem::new("ChatGPT").with_id(id));
        } else {
            items.push(provider_item(provider, actions));
        }
    }
    if !catalog
        .providers
        .iter()
        .any(|provider| provider.provider == "openai-chatgpt")
    {
        let id = ListSelectionItemId::new("openai-chatgpt");
        actions.insert(
            id.clone(),
            ConfigSelectionAction::OpenSubscription(super::SubscriptionProvider::ChatGpt),
        );
        items.push(ListSelectionItem::new("ChatGPT").with_id(id));
    }
    let id = ListSelectionItemId::new("new-custom-provider");
    actions.insert(
        id.clone(),
        ConfigSelectionAction::OpenProvider(super::provider::Settings::new(config, catalog, "")),
    );
    items.push(ListSelectionItem::new("New custom provider").with_id(id));
    items
}

fn provider_item(
    provider: &ProviderCatalogEntryDto,
    actions: &mut BTreeMap<ListSelectionItemId, ConfigSelectionAction>,
) -> ListSelectionItem {
    let item = ListSelectionItem::new(&provider.display_name);
    if provider.api_key_policy == ProviderApiKeyPolicyDto::Unsupported {
        return item;
    }
    let id = ListSelectionItemId::new(format!("provider-api-key-{}", provider.provider));
    actions.insert(
        id.clone(),
        ConfigSelectionAction::OpenProviderApiKey {
            provider: provider.provider.clone(),
            display_name: provider.display_name.clone(),
        },
    );
    item.with_id(id)
}

#[cfg(test)]
#[path = "editor_tests.rs"]
mod tests;
