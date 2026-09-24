mod request;
pub(crate) use request::execute;

use crate::keymap::bindings;
use crate::nls::Language;
use crate::nls::Text;
use crate::widgets::list_selection::ListSelection;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::list_selection::ListSelectionOutcome;
use crate::widgets::list_selection::ListSelectionState;
use crate::widgets::search_box::SearchBoxModel;
use ash_app_server_protocol::protocol::config::LanguageServerConfigDto;
use ash_app_server_protocol::protocol::config::LanguageServerModeDto;
use ash_app_server_protocol::protocol::environment::SessionDirSelector;
use ash_app_server_protocol::protocol::language::LanguageServerDescriptorDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceCapabilityKindDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceSearchParams;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct Scope {
    pub(crate) language_id: Option<String>,
    pub(crate) directory: Option<SessionDirSelector>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Command {
    Load(Scope),
    Configure {
        scope: Scope,
        revision: u64,
        server_id: String,
        config: LanguageServerConfigDto,
    },
    Remove {
        scope: Scope,
        revision: u64,
        server_id: String,
    },
}

pub(crate) struct Event(pub(crate) Page);

#[derive(Clone, Debug)]
pub(crate) struct Page {
    pub(crate) scope: Scope,
    pub(crate) revision: u64,
    pub(crate) configured: BTreeMap<String, LanguageServerConfigDto>,
    pub(crate) servers: Vec<LanguageServerDescriptorDto>,
    pub(crate) directories: Vec<SessionDirSelector>,
    pub(crate) error: Option<String>,
}

#[derive(Clone, Debug)]
enum Action {
    Request(Command),
    Server(String),
    Find,
    Add,
    Executable(String),
    Back,
}

#[derive(Debug)]
enum Input {
    Language,
    Server,
    Executable(String),
}

#[derive(Debug)]
pub(crate) enum Outcome {
    Command(Command),
    Marketplace(crate::marketplace::Command),
    Consumed,
    Dismiss,
}

/// Owns language-server preferences and directory selection in the terminal.
#[derive(Debug)]
pub(crate) struct Panel {
    page: Page,
    list: ListSelection<Action>,
    pending: bool,
    input_hints: crate::widgets::key_hint::KeyHints,
    input: Option<Input>,
    detail: bool,
    language: Language,
}

impl Panel {
    pub(crate) fn new(page: Page) -> Self {
        let mut actions = BTreeMap::new();
        let mut available = Vec::new();
        push(
            &mut available,
            &mut actions,
            "find",
            "Find language servers in Marketplace",
            "Match the exact language route in the package manifest",
            Action::Find,
        );
        push(
            &mut available,
            &mut actions,
            "add",
            "Configure a server by ID",
            "Set mode and optional program path",
            Action::Add,
        );
        push(
            &mut available,
            &mut actions,
            "refresh",
            "Refresh servers",
            "Lists enabled, resolved servers without starting processes",
            Action::Request(Command::Load(page.scope.clone())),
        );
        for server in &page.servers {
            push(
                &mut available,
                &mut actions,
                &server.id,
                Text::literal(&server.id),
                Text::template(
                    "Available · {0}",
                    vec![Text::literal(server.language_ids.join(", "))],
                ),
                Action::Server(server.id.clone()),
            );
        }
        let mut configured = Vec::new();
        for (id, config) in &page.configured {
            push(
                &mut configured,
                &mut actions,
                id,
                Text::literal(id),
                Text::template(
                    "{0} · {1}",
                    vec![
                        mode_label(config.mode).into(),
                        config
                            .executable
                            .as_ref()
                            .map(Text::literal)
                            .unwrap_or_else(|| "provider executable".into()),
                    ],
                ),
                Action::Server(id.clone()),
            );
        }
        let mut dirs = Vec::new();
        for dir in &page.directories {
            let label = dir.path.display().to_string();
            let mut scope = page.scope.clone();
            scope.directory = Some(dir.clone());
            push(
                &mut dirs,
                &mut actions,
                &format!("dir:{label}"),
                Text::literal(&label),
                if page.scope.directory.as_ref() == Some(dir) {
                    "Current directory"
                } else {
                    "Inspect servers in this directory"
                },
                Action::Request(Command::Load(scope)),
            );
        }
        let mut groups = vec![
            ListSelectionGroup::new("Available", available),
            ListSelectionGroup::new("Configured", configured),
        ];
        if !dirs.is_empty() {
            groups.push(ListSelectionGroup::new("Directories", dirs));
        }
        let mut list = ListSelection::new(
            ListSelectionModel::new("Language servers", groups)
                .with_activation(bindings::ACCEPT)
                .with_search(SearchBoxModel::new("Filter server IDs"))
                .with_empty_message("No language servers in this view"),
            actions,
        );
        list.state_mut().set_message(page.error.clone().or_else(|| {
            page.scope
                .directory
                .as_ref()
                .map(|dir| format!("Directory: {}", dir.path.display()))
        }));
        Self {
            page,
            list,
            input: None,
            detail: false,
            language: Language::English,
            pending: false,
            input_hints: crate::widgets::key_hint::KeyHints::compact()
                .with_compact_action("Enter", "continue")
                .with_compact_action("Esc", "return"),
        }
    }

    pub(crate) fn localize(&mut self, language: Language) {
        self.language = language;
        self.list.state_mut().localize(language);
        if !self.pending
            && !self.detail
            && self.input.is_none()
            && self.page.error.is_none()
            && let Some(dir) = &self.page.scope.directory
        {
            let mut message = Text::template(
                "Directory: {0}",
                vec![Text::literal(dir.path.display().to_string())],
            );
            message.localize(language);
            self.list.state_mut().set_message(Some(message.to_string()));
        }
    }

    pub(crate) fn begin_request(&mut self) {
        self.pending = true;
        self.list
            .state_mut()
            .set_message(Some(crate::nls::localize_owned(self.language, "Loading…")));
    }
    pub(crate) fn fail(&mut self, error: String) {
        self.pending = false;
        self.list
            .state_mut()
            .set_message(Some(crate::nls::localize_owned(self.language, error)));
    }
    pub(crate) fn state(&self) -> &ListSelectionState {
        self.list.state()
    }
    pub(crate) fn state_mut(&mut self) -> &mut ListSelectionState {
        self.list.state_mut()
    }
    pub(crate) fn key_hints(&self) -> &crate::widgets::key_hint::KeyHints {
        if self.pending {
            &bindings::CLOSE_HINTS
        } else if self
            .state()
            .search()
            .is_some_and(|input| input.input_active())
            && self.input.is_some()
        {
            &self.input_hints
        } else {
            self.list.key_hints()
        }
    }
    pub(crate) fn handle_paste(&mut self, text: String) {
        if !self.pending {
            self.list.handle_paste(text);
        }
    }
    pub(crate) fn refresh(&self) -> Option<Command> {
        (!self.pending && !self.detail && self.input.is_none())
            .then(|| Command::Load(self.page.scope.clone()))
    }

    pub(crate) fn handle_key(&mut self, key: KeyEvent) -> Outcome {
        if self.pending {
            return if key.kind == KeyEventKind::Press && bindings::CANCEL.matches(key) {
                Outcome::Dismiss
            } else {
                Outcome::Consumed
            };
        }
        if key.kind == KeyEventKind::Press
            && bindings::CANCEL.matches(key)
            && (self.input.is_some() || self.detail)
        {
            let language = self.language;
            *self = Self::new(self.page.clone());
            self.localize(language);
            return Outcome::Consumed;
        }
        if key.kind == KeyEventKind::Press
            && bindings::ACCEPT.matches(key)
            && self
                .state()
                .search()
                .is_some_and(|input| input.input_active())
            && self.input.is_some()
        {
            let text = self.state().query().trim().to_owned();
            if text.is_empty() {
                return Outcome::Consumed;
            }
            return match self.input.as_ref().unwrap() {
                Input::Language => Outcome::Marketplace(crate::marketplace::Command::Browse(
                    MarketplaceSearchParams {
                        language_id: Some(text),
                        capability_kind: Some(MarketplaceCapabilityKindDto::Executable),
                        ..Default::default()
                    },
                )),
                Input::Server => {
                    self.server(text);
                    Outcome::Consumed
                }
                Input::Executable(id) => {
                    let mut config = self.config(id);
                    config.executable = Some(text);
                    Outcome::Command(self.configure(id.clone(), config))
                }
            };
        }
        match self.list.handle_key(key) {
            ListSelectionOutcome::Activate(Action::Request(command)) => Outcome::Command(command),
            ListSelectionOutcome::Activate(Action::Server(id)) => {
                self.server(id);
                Outcome::Consumed
            }
            ListSelectionOutcome::Activate(Action::Find) => {
                if let Some(language_id) = &self.page.scope.language_id {
                    return Outcome::Marketplace(crate::marketplace::Command::Browse(
                        MarketplaceSearchParams {
                            language_id: Some(language_id.clone()),
                            capability_kind: Some(MarketplaceCapabilityKindDto::Executable),
                            ..Default::default()
                        },
                    ));
                }
                self.prompt(
                    Input::Language,
                    "Find language servers",
                    "Language ID, for example rust or typescript",
                );
                Outcome::Consumed
            }
            ListSelectionOutcome::Activate(Action::Add) => {
                self.prompt(
                    Input::Server,
                    "Configure language server",
                    "Server ID, for example rust-analyzer",
                );
                Outcome::Consumed
            }
            ListSelectionOutcome::Activate(Action::Executable(id)) => {
                self.prompt(
                    Input::Executable(id),
                    "Language server program",
                    "Absolute executable path",
                );
                Outcome::Consumed
            }
            ListSelectionOutcome::Activate(Action::Back) => {
                let language = self.language;
                *self = Self::new(self.page.clone());
                self.localize(language);
                Outcome::Consumed
            }
            ListSelectionOutcome::Dismiss => Outcome::Dismiss,
            _ => Outcome::Consumed,
        }
    }

    fn config(&self, id: &str) -> LanguageServerConfigDto {
        self.page
            .configured
            .get(id)
            .cloned()
            .unwrap_or(LanguageServerConfigDto {
                mode: if self.page.servers.iter().any(|server| server.id == id) {
                    LanguageServerModeDto::Enabled
                } else {
                    LanguageServerModeDto::Disabled
                },
                executable: None,
            })
    }

    fn configure(&self, server_id: String, config: LanguageServerConfigDto) -> Command {
        Command::Configure {
            scope: self.page.scope.clone(),
            revision: self.page.revision,
            server_id,
            config,
        }
    }

    fn server(&mut self, id: String) {
        let mut actions = BTreeMap::new();
        let mut items = Vec::new();
        push(
            &mut items,
            &mut actions,
            "back",
            "Back to language servers",
            "",
            Action::Back,
        );
        let mut config = self.config(&id);
        let current = config.mode;
        config.mode = if current == LanguageServerModeDto::Enabled {
            LanguageServerModeDto::Disabled
        } else {
            LanguageServerModeDto::Enabled
        };
        push(
            &mut items,
            &mut actions,
            "mode",
            if current == LanguageServerModeDto::Enabled {
                "Disable server"
            } else {
                "Enable server"
            },
            Text::template("Currently {0}", vec![mode_label(current).into()]),
            Action::Request(self.configure(id.clone(), config)),
        );
        push(
            &mut items,
            &mut actions,
            "path",
            "Set program path",
            self.config(&id)
                .executable
                .map(Text::literal)
                .unwrap_or_else(|| "Using provider executable".into()),
            Action::Executable(id.clone()),
        );
        let mut config = self.config(&id);
        config.executable = None;
        push(
            &mut items,
            &mut actions,
            "provider",
            "Use provider executable",
            "Keep the current enabled/disabled setting",
            Action::Request(self.configure(id.clone(), config)),
        );
        if self.page.configured.contains_key(&id) {
            push(
                &mut items,
                &mut actions,
                "defaults",
                "Restore provider defaults",
                "Remove this explicit configuration",
                Action::Request(Command::Remove {
                    scope: self.page.scope.clone(),
                    revision: self.page.revision,
                    server_id: id.clone(),
                }),
            );
        }
        self.list = ListSelection::new(
            ListSelectionModel::new(
                Text::template("Language server · {0}", vec![Text::literal(id)]),
                vec![ListSelectionGroup::new("", items)],
            )
            .without_tab_bar()
            .with_activation(bindings::ACCEPT),
            actions,
        );
        self.input = None;
        self.detail = true;
        self.localize(self.language);
    }

    fn prompt(&mut self, input: Input, title: &str, placeholder: &str) {
        self.list = ListSelection::new(
            ListSelectionModel::new(title, vec![ListSelectionGroup::new("", Vec::new())])
                .without_tab_bar()
                .with_activation(bindings::ACCEPT)
                .with_input(SearchBoxModel::new(placeholder))
                .with_empty_message(""),
            BTreeMap::new(),
        );
        self.list.state_mut().focus_search();
        self.input = Some(input);
        self.localize(self.language);
    }
}

fn push(
    items: &mut Vec<ListSelectionItem>,
    actions: &mut BTreeMap<ListSelectionItemId, Action>,
    id: &str,
    label: impl Into<Text>,
    description: impl Into<Text>,
    action: Action,
) {
    let description = description.into();
    let id = ListSelectionItemId::new(id);
    let item = ListSelectionItem::new(label).with_id(id.clone());
    items.push(if description.is_empty() {
        item
    } else {
        item.with_description(description)
    });
    actions.insert(id, action);
}

fn mode_label(mode: LanguageServerModeDto) -> &'static str {
    match mode {
        LanguageServerModeDto::Enabled => "enabled",
        LanguageServerModeDto::Disabled => "disabled",
    }
}
