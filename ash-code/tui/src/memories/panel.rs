use super::Command;
use super::Entry;
use super::Failure;
use super::Listing;
use super::Page;
use super::editor::Editor;
use super::editor::Field;
use crate::render::RenderContext;
use crate::widgets::key_hint::KeyHints;
use crate::widgets::list_selection::*;
use crate::widgets::search_box::SearchBoxModel;
use crate::widgets::text_prompt;
use crate::widgets::text_prompt::TextPrompt;
use crate::widgets::text_prompt::TextPromptOutcome;
use crate::widgets::text_prompt::TextPromptSpec;
use ash_app_server_protocol::protocol::memory::MemoryChanged;
use ash_app_server_protocol::protocol::memory::MemoryScopeDescriptor;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use crossterm::event::KeyModifiers;
use memories::Memory;
use memories::MemoryScope;
use ratatui::Frame;
use ratatui::layout::Position;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::widgets::Paragraph;
use ratatui::widgets::Wrap;
use std::cell::Cell;
use std::collections::BTreeMap;

#[derive(Clone, Debug)]
enum Action {
    New,
    Scopes,
    Permissions,
    Reference,
    Refresh,
    Configure,
    Read(memories::MemoryId),
    Scope(MemoryScope),
    More,
    ReadPolicy,
    WritePolicy,
    ReloadPolicy,
    Continue,
    Discard,
    Delete,
    Back,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Target {
    List(ListSelectionPointerTarget),
    Field(Field),
}

#[derive(Debug)]
pub(crate) struct Panel {
    scopes: Vec<MemoryScopeDescriptor>,
    chosen: [Option<MemoryScope>; 3],
    lists: BTreeMap<MemoryScope, Listing>,
    selection: ListSelection<Action>,
    menu: Option<ListSelection<Action>>,
    editor: Option<Editor>,
    reference: Option<TextPrompt>,
    detail: Option<Memory>,
    citation: Option<memories::MemoryCitationResult>,
    latest: Option<Memory>,
    showing_latest: bool,
    editing: Option<Memory>,
    conflict: bool,
    pending: Option<Command>,
    attempt: Option<Command>,
    refresh: bool,
    enabled: bool,
    message: Option<String>,
    scroll: Cell<u16>,
    language: crate::nls::Language,
    hints: KeyHints,
}

impl Panel {
    pub(crate) fn new(page: Page) -> Self {
        let mut panel = Self {
            scopes: Vec::new(),
            chosen: [None, None, None],
            lists: BTreeMap::new(),
            selection: ListSelection::new(
                ListSelectionModel::new("Memories", groups()),
                BTreeMap::new(),
            ),
            menu: None,
            editor: None,
            reference: None,
            detail: None,
            citation: None,
            latest: None,
            showing_latest: false,
            editing: None,
            conflict: false,
            pending: None,
            attempt: None,
            refresh: false,
            enabled: false,
            message: None,
            scroll: Cell::new(0),
            language: crate::nls::Language::English,
            hints: KeyHints::new(),
        };
        match page {
            Page::Scopes {
                enabled,
                scopes,
                list,
            } => {
                panel.enabled = enabled;
                for scope in &scopes {
                    panel.chosen[kind(&scope.policy.scope)]
                        .get_or_insert_with(|| scope.policy.scope.clone());
                }
                let index = kind(&list.scope);
                panel.chosen[index] = Some(list.scope.clone());
                panel.lists.insert(list.scope.clone(), list);
                panel.scopes = scopes;
                panel.rebuild();
                panel
                    .selection
                    .state_mut()
                    .focus_pointer(&ListSelectionPointerTarget::Tab(index));
                panel
                    .selection
                    .handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
            }
            Page::Citation(entry) => panel.citation = Some(entry),
            _ => unreachable!("a memories panel opens with scopes or an exact reference"),
        }
        panel.update_hints();
        panel
    }
    pub(crate) fn localize(&mut self, language: crate::nls::Language) {
        self.language = language;
        self.rebuild();
        if let Some(menu) = &mut self.menu {
            menu.state_mut().localize(language);
        }
    }
    fn scope(&self) -> Option<&MemoryScope> {
        self.chosen[self.selection.state().active_tab_index()].as_ref()
    }
    fn listing(&self) -> Option<&Listing> {
        self.scope().and_then(|scope| self.lists.get(scope))
    }
    fn request(&mut self, mut command: Command) -> ListSelectionOutcome<Command> {
        match (&mut command, &self.attempt) {
            (
                Command::Delete { command_id, memory },
                Some(Command::Delete {
                    command_id: prior,
                    memory: old,
                }),
            ) if memory == old => *command_id = prior.clone(),
            (
                Command::Policy { command_id, policy },
                Some(Command::Policy {
                    command_id: prior,
                    policy: old,
                }),
            ) if policy == old => *command_id = prior.clone(),
            _ => {}
        }
        if matches!(
            command,
            Command::Add { .. }
                | Command::Update { .. }
                | Command::Delete { .. }
                | Command::Policy { .. }
        ) {
            self.attempt = Some(command.clone());
        }
        self.pending = Some(command.clone());
        self.message = None;
        self.update_hints();
        ListSelectionOutcome::Activate(command)
    }
    fn browse(&mut self, cursor: Option<String>) -> ListSelectionOutcome<Command> {
        let Some(scope) = self.scope().cloned() else {
            return ListSelectionOutcome::Consumed;
        };
        let query = self.selection.state().query().trim().to_owned();
        if query.chars().count() > 512 {
            self.message = Some("Search is limited to 512 characters.".into());
            return ListSelectionOutcome::Consumed;
        }
        let loaded = self
            .listing()
            .filter(|list| list.query == query)
            .map_or(20, |list| list.entries.len().max(20));
        self.request(Command::Browse {
            scope,
            query,
            cursor,
            loaded,
        })
    }
    pub(crate) fn take_refresh(&mut self) -> Option<Command> {
        if !self.refresh
            || self.pending.is_some()
            || self.editor.is_some()
            || self.reference.is_some()
            || self.menu.is_some()
        {
            return None;
        }
        self.refresh = false;
        if let Some(memory) = &self.detail {
            let command = Command::Read {
                scope: memory.scope.clone(),
                id: memory.memory_id.clone(),
            };
            if let ListSelectionOutcome::Activate(command) = self.request(command) {
                return Some(command);
            }
        }
        match self.browse(None) {
            ListSelectionOutcome::Activate(command) => Some(command),
            _ => None,
        }
    }
    pub(crate) fn changed(&mut self, changed: MemoryChanged) {
        let Some(list) = self.lists.get(&changed.scope) else {
            return;
        };
        if changed.catalog_revision <= list.revision {
            return;
        }
        if self.scope() == Some(&changed.scope) {
            self.refresh = true;
            if self.editor.is_some() {
                self.message = Some("Memories changed. Your draft is kept.".into());
            }
        } else {
            self.lists.remove(&changed.scope);
        }
    }
    pub(crate) fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }
    pub(crate) fn finish(&mut self, command: Command, result: Result<Page, Failure>) {
        if self.pending.as_ref() != Some(&command) {
            return;
        }
        self.pending = None;
        match result {
            Err(error) => {
                self.conflict |= error.code == Some(-32133) && self.editor.is_some();
                self.message = Some(error.message.clone());
            }
            Ok(Page::List(mut list)) => {
                let append = matches!(
                    command,
                    Command::Browse {
                        cursor: Some(_),
                        ..
                    }
                );
                if append && let Some(previous) = self.lists.get_mut(&list.scope) {
                    if previous.query == list.query && previous.revision == list.revision {
                        previous.entries.append(&mut list.entries);
                        previous.cursor = list.cursor;
                    }
                } else {
                    self.lists.insert(list.scope.clone(), list);
                }
                self.rebuild();
            }
            Ok(Page::Read(memory)) => {
                if self.editor.is_some() && matches!(command, Command::Read { .. }) {
                    self.latest = Some(memory);
                    self.showing_latest = true;
                } else {
                    let saved = matches!(command, Command::Add { .. } | Command::Update { .. });
                    if saved {
                        self.editor = None;
                        self.editing = None;
                        self.attempt = None;
                        self.conflict = false;
                        self.latest = None;
                    }
                    if let Some(list) = self.lists.get_mut(&memory.scope) {
                        if let Some(entry) = list
                            .entries
                            .iter_mut()
                            .find(|entry| entry.id == memory.memory_id)
                        {
                            entry.title = memory.title.clone();
                            entry.source = memory.source.clone();
                            entry.updated = memory.updated_at_unix_ms;
                        } else if list.query.is_empty() {
                            list.entries.push(summary(&memory));
                        }
                        if saved {
                            list.cursor = None;
                        }
                    }
                    self.detail = Some(memory);
                    self.refresh |= saved;
                    self.rebuild();
                }
                self.scroll.set(0);
            }
            Ok(Page::Deleted) => {
                self.attempt = None;
                if let Some(memory) = self.detail.take()
                    && let Some(list) = self.lists.get_mut(&memory.scope)
                {
                    list.entries.retain(|entry| entry.id != memory.memory_id);
                    list.cursor = None;
                }
                self.menu = None;
                self.refresh = true;
                self.rebuild();
            }
            Ok(Page::Policy(policy)) => {
                self.attempt = None;
                if let Some(scope) = self
                    .scopes
                    .iter_mut()
                    .find(|scope| scope.policy.scope == policy.scope)
                {
                    scope.policy = policy;
                }
                self.policy_menu();
                self.refresh = true;
            }
            Ok(Page::Citation(entry)) => {
                self.reference = None;
                self.citation = Some(entry);
                self.scroll.set(0);
            }
            Ok(Page::Scopes { .. }) => unreachable!("scope loading creates a panel"),
        }
        self.update_hints();
    }
    fn rebuild(&mut self) {
        let mut actions = BTreeMap::new();
        let groups = ["Personal", "Projects", "Directories"]
            .into_iter()
            .enumerate()
            .map(|(index, label)| {
                let items = self.chosen[index]
                    .as_ref()
                    .and_then(|scope| self.lists.get(scope))
                    .map(|list| {
                        let mut items: Vec<_> = list
                            .entries
                            .iter()
                            .map(|entry| {
                                let id = item_id(&list.scope, &entry.id);
                                actions.insert(id.clone(), Action::Read(entry.id.clone()));
                                let source = crate::nls::localize(
                                    self.language,
                                    if entry.source == memories::MemorySource::User {
                                        "User maintained"
                                    } else {
                                        "Model maintained"
                                    },
                                );
                                let updated =
                                    chrono::DateTime::from_timestamp_millis(entry.updated as i64)
                                        .map(|date| date.format("%m-%d").to_string())
                                        .unwrap_or_default();
                                ListSelectionItem::new(&entry.title)
                                    .with_id(id)
                                    .with_columns(
                                        &entry.title,
                                        &entry.excerpt,
                                        format!("{source} · {updated}"),
                                    )
                            })
                            .collect();
                        if list.cursor.is_some() {
                            let id = ListSelectionItemId::new(format!("more-{index}"));
                            actions.insert(id.clone(), Action::More);
                            items.push(ListSelectionItem::new("Load more").with_id(id));
                        }
                        items
                    })
                    .unwrap_or_default();
                ListSelectionGroup::new(label, items)
            })
            .collect();
        let model = ListSelectionModel::new("Memories", groups)
            .with_input(SearchBoxModel::new("Search this scope"))
            .with_empty_message(if self.scope().is_none() {
                "No authorized scope in this tab."
            } else if self.listing().is_some_and(|list| !list.query.is_empty()) {
                "No matching memories. Change the search or clear it."
            } else {
                "No memories in this scope. Press n to add one."
            });
        self.selection.replace(model, actions);
        self.selection.state_mut().localize(self.language);
    }
    fn displayed_list(&self) -> Option<&ListSelectionState> {
        if let Some(menu) = &self.menu {
            Some(menu.state())
        } else if self.editor.is_none()
            && self.reference.is_none()
            && self.detail.is_none()
            && self.citation.is_none()
        {
            Some(self.selection.state())
        } else {
            None
        }
    }
    fn update_hints(&mut self) {
        self.hints = if self.pending.is_some() {
            KeyHints::compact().with_note("Working…")
        } else if self.showing_latest {
            KeyHints::compact()
                .with_compact_action("u", "use this revision")
                .with_compact_action("Esc", "draft")
        } else if self.menu.is_some() {
            KeyHints::compact()
                .with_compact_action("Enter", "select")
                .with_compact_action("Esc", "back")
        } else if self.editor.is_some() {
            let hints = KeyHints::compact()
                .with_compact_action("Tab", "fields")
                .with_compact_action("Ctrl+S", "save");
            if self.conflict {
                hints
                    .with_compact_action("Ctrl+R", "latest")
                    .with_compact_action("Esc", "back")
            } else {
                hints.with_compact_action("Esc", "back")
            }
        } else if self.reference.is_some() {
            KeyHints::compact()
                .with_compact_action("Enter", "open")
                .with_compact_action("Esc", "back")
        } else if self.citation.is_some() {
            KeyHints::compact()
                .with_compact_action("↑/↓", "scroll")
                .with_compact_action("Esc", "back")
        } else if self.detail.is_some() {
            KeyHints::compact()
                .with_compact_action("e", "edit")
                .with_compact_action("Delete", "delete")
                .with_compact_action("↑/↓", "scroll")
                .with_compact_action("Esc", "back")
        } else if self.selection.state().tabs_focused() {
            crate::keymap::bindings::TAB_HINTS.clone()
        } else if self
            .selection
            .state()
            .search()
            .is_some_and(|search| search.input_active())
        {
            KeyHints::compact()
                .with_compact_action("Enter", "search")
                .with_compact_action("Tab", "tabs")
                .with_compact_action("Esc", "list")
        } else {
            KeyHints::compact()
                .with_compact_action("Enter", "view")
                .with_compact_action("n", "new")
                .with_compact_action("a", "actions")
                .with_compact_action("Tab", "tabs")
                .with_compact_action("/", "search")
                .with_compact_action("Esc", "close")
        };
    }
    pub(crate) fn key_hints(&self) -> &KeyHints {
        &self.hints
    }
    pub(crate) fn paste(&mut self, text: String) {
        if self.pending.is_some() {
            return;
        }
        if let Some(editor) = &mut self.editor {
            editor.paste(text);
        } else if let Some(prompt) = &mut self.reference {
            prompt.handle_paste(text);
        } else if self.menu.is_none() && self.detail.is_none() && self.citation.is_none() {
            self.selection.handle_paste(text);
        }
    }
    pub(crate) fn handle_key(&mut self, key: KeyEvent) -> ListSelectionOutcome<Command> {
        if key.kind != KeyEventKind::Press {
            return ListSelectionOutcome::Consumed;
        }
        let outcome = self.key(key);
        self.update_hints();
        outcome
    }
    fn key(&mut self, key: KeyEvent) -> ListSelectionOutcome<Command> {
        if self.pending.is_some() {
            return ListSelectionOutcome::Consumed;
        }
        if let Some(menu) = &mut self.menu {
            let outcome = menu.handle_key(key);
            return match outcome {
                ListSelectionOutcome::Activate(action) => self.activate(action),
                ListSelectionOutcome::Dismiss => {
                    self.menu = None;
                    ListSelectionOutcome::Consumed
                }
                _ => ListSelectionOutcome::Consumed,
            };
        }
        if self.showing_latest {
            if key.code == KeyCode::Esc {
                self.showing_latest = false;
            } else if key.code == KeyCode::Char('u') {
                self.editing = self.latest.take();
                self.showing_latest = false;
                self.conflict = false;
                self.attempt = None;
                self.message = None;
                if let Some(editor) = &mut self.editor {
                    editor.message = None;
                }
            } else {
                self.scroll_key(key);
            }
            return ListSelectionOutcome::Consumed;
        }
        if let Some(editor) = &mut self.editor {
            if key.code == KeyCode::Esc {
                if editor.dirty() {
                    self.open_menu(
                        "Unsaved changes",
                        vec![
                            ("Continue editing".into(), Action::Continue),
                            ("Discard changes".into(), Action::Discard),
                        ],
                    );
                } else {
                    self.editor = None;
                    self.editing = None;
                }
            } else if key.modifiers == KeyModifiers::CONTROL
                && key.code == KeyCode::Char('r')
                && self.conflict
            {
                if let Some(memory) = &self.editing {
                    return self.request(Command::Read {
                        scope: memory.scope.clone(),
                        id: memory.memory_id.clone(),
                    });
                }
            } else if key.modifiers == KeyModifiers::CONTROL && key.code == KeyCode::Char('s') {
                if self.conflict || !editor.validate() {
                    return ListSelectionOutcome::Consumed;
                }
                let (title, body) = editor.values();
                let (title, body) = (title.to_owned(), body.to_owned());
                let id = match &self.attempt {
                    Some(
                        Command::Add {
                            command_id,
                            title: old_title,
                            body: old_body,
                            ..
                        }
                        | Command::Update {
                            command_id,
                            title: old_title,
                            body: old_body,
                            ..
                        },
                    ) if *old_title == title && *old_body == body => command_id.clone(),
                    _ => crate::client::new_command_id("memory-save"),
                };
                let command = if let Some(memory) = &self.editing {
                    Command::Update {
                        command_id: id,
                        memory: memory.clone(),
                        title,
                        body,
                    }
                } else {
                    Command::Add {
                        command_id: id,
                        scope: self.scope().expect("new memory scope").clone(),
                        title,
                        body,
                    }
                };
                self.attempt = Some(command.clone());
                return self.request(command);
            } else {
                editor.handle_key(key);
            }
            return ListSelectionOutcome::Consumed;
        }
        if let Some(prompt) = &mut self.reference {
            return match prompt.handle_key(key) {
                TextPromptOutcome::Submit(value) => self.request(Command::Citation(value)),
                TextPromptOutcome::Dismiss => {
                    self.reference = None;
                    ListSelectionOutcome::Consumed
                }
                _ => ListSelectionOutcome::Consumed,
            };
        }
        if self.detail.is_some() || self.citation.is_some() {
            if key.code == KeyCode::Esc {
                if self.scopes.is_empty() {
                    return ListSelectionOutcome::Dismiss;
                }
                self.detail = None;
                self.citation = None;
                self.refresh = true;
            } else if key.code == KeyCode::Char('e')
                && let Some(memory) = &self.detail
            {
                self.editor = Some(Editor::new(memory.title.clone(), memory.body.clone()));
                self.editing = Some(memory.clone());
            } else if key.code == KeyCode::Delete && self.detail.is_some() {
                self.open_menu(
                    "Delete this memory?",
                    vec![
                        ("Cancel".into(), Action::Back),
                        (self.detail.as_ref().unwrap().title.clone(), Action::Delete),
                    ],
                );
            } else {
                self.scroll_key(key);
            }
            return ListSelectionOutcome::Consumed;
        }
        if self
            .selection
            .state()
            .search()
            .is_some_and(|search| search.input_active())
            && key.code == KeyCode::Enter
        {
            self.selection.handle_key(key);
            return self.browse(None);
        }
        if key.modifiers.is_empty() && self.selection.state().items_focused() {
            match key.code {
                KeyCode::Char('a') => {
                    self.open_menu(
                        "Memory actions",
                        vec![
                            ("Add memory".into(), Action::New),
                            ("Choose scope".into(), Action::Scopes),
                            ("Scope permissions".into(), Action::Permissions),
                            ("Open memory reference".into(), Action::Reference),
                            ("Refresh memories".into(), Action::Refresh),
                            ("Open Config".into(), Action::Configure),
                        ],
                    );
                    return ListSelectionOutcome::Consumed;
                }
                KeyCode::Char('n') if self.scope().is_some() => {
                    self.editor = Some(Editor::new(String::new(), String::new()));
                    self.editing = None;
                    self.attempt = None;
                    self.conflict = false;
                    return ListSelectionOutcome::Consumed;
                }
                KeyCode::Char('r') => return self.browse(None),
                KeyCode::Char('c') => return self.request(Command::Configure),
                KeyCode::Char('p') => {
                    self.policy_menu();
                    return ListSelectionOutcome::Consumed;
                }
                KeyCode::Char('s') => {
                    let index = self.selection.state().active_tab_index();
                    let rows = self
                        .scopes
                        .iter()
                        .filter(|scope| kind(&scope.policy.scope) == index)
                        .map(|scope| {
                            (
                                scope.label.clone(),
                                Action::Scope(scope.policy.scope.clone()),
                            )
                        })
                        .collect();
                    self.open_menu("Choose scope", rows);
                    return ListSelectionOutcome::Consumed;
                }
                KeyCode::Char('o') => {
                    self.reference = Some(TextPrompt::new(TextPromptSpec {
                        title: "Open memory reference".into(),
                        explanation: "Paste an exact memory: reference".into(),
                        placeholder: "memory:…".into(),
                        masked: false,
                    }));
                    return ListSelectionOutcome::Consumed;
                }
                _ => {}
            }
        }
        let index = self.selection.state().active_tab_index();
        let outcome = self.selection.handle_key(key);
        if index != self.selection.state().active_tab_index() {
            self.message = None;
            self.refresh = true;
            self.rebuild();
        }
        match outcome {
            ListSelectionOutcome::Activate(action) => self.activate(action),
            ListSelectionOutcome::Dismiss => ListSelectionOutcome::Dismiss,
            _ => ListSelectionOutcome::Consumed,
        }
    }
    fn activate(&mut self, action: Action) -> ListSelectionOutcome<Command> {
        match action {
            Action::New
            | Action::Scopes
            | Action::Permissions
            | Action::Reference
            | Action::Refresh
            | Action::Configure => {
                let key = match action {
                    Action::New => 'n',
                    Action::Scopes => 's',
                    Action::Permissions => 'p',
                    Action::Reference => 'o',
                    Action::Refresh => 'r',
                    Action::Configure => 'c',
                    _ => unreachable!(),
                };
                self.menu = None;
                self.key(KeyEvent::new(KeyCode::Char(key), KeyModifiers::NONE))
            }
            Action::Read(id) => self.request(Command::Read {
                scope: self.scope().unwrap().clone(),
                id,
            }),
            Action::More => self.browse(self.listing().and_then(|list| list.cursor.clone())),
            Action::ReloadPolicy => {
                self.request(Command::ReadPolicy(self.scope().unwrap().clone()))
            }
            Action::Scope(scope) => {
                let index = kind(&scope);
                self.chosen[index] = Some(scope);
                self.menu = None;
                self.rebuild();
                self.browse(None)
            }
            Action::ReadPolicy | Action::WritePolicy => {
                let mut policy = self
                    .scopes
                    .iter()
                    .find(|scope| Some(&scope.policy.scope) == self.scope())
                    .unwrap()
                    .policy
                    .clone();
                if matches!(action, Action::ReadPolicy) {
                    policy.automatic_read =
                        if policy.automatic_read == memories::MemoryReadMode::Disabled {
                            memories::MemoryReadMode::FirstInvocation
                        } else {
                            memories::MemoryReadMode::Disabled
                        };
                } else {
                    policy.model_write =
                        if policy.model_write == memories::MemoryWriteMode::Disabled {
                            memories::MemoryWriteMode::Enabled
                        } else {
                            memories::MemoryWriteMode::Disabled
                        };
                }
                self.request(Command::Policy {
                    command_id: crate::client::new_command_id("memory-policy"),
                    policy,
                })
            }
            Action::Continue | Action::Back => {
                self.menu = None;
                ListSelectionOutcome::Consumed
            }
            Action::Discard => {
                self.menu = None;
                self.editor = None;
                self.editing = None;
                self.conflict = false;
                self.attempt = None;
                self.latest = None;
                self.showing_latest = false;
                self.message = None;
                ListSelectionOutcome::Consumed
            }
            Action::Delete => self.request(Command::Delete {
                command_id: crate::client::new_command_id("memory-delete"),
                memory: self.detail.as_ref().unwrap().clone(),
            }),
        }
    }
    fn open_menu(&mut self, title: &str, rows: Vec<(String, Action)>) {
        let mut actions = BTreeMap::new();
        let items = rows
            .into_iter()
            .enumerate()
            .map(|(i, (label, action))| {
                let id = ListSelectionItemId::new(format!("action-{i}"));
                actions.insert(id.clone(), action);
                ListSelectionItem::new(label).with_id(id)
            })
            .collect();
        let mut menu = ListSelection::new(
            ListSelectionModel::new(title, vec![ListSelectionGroup::new("", items)])
                .without_tab_bar(),
            actions,
        );
        menu.state_mut().localize(self.language);
        self.menu = Some(menu);
    }
    fn policy_menu(&mut self) {
        let Some(scope) = self
            .scopes
            .iter()
            .find(|scope| Some(&scope.policy.scope) == self.scope())
        else {
            return;
        };
        let text = |label: &str, enabled| {
            format!(
                "{}: {}",
                crate::nls::localize(self.language, label),
                if enabled { "on" } else { "off" }
            )
        };
        self.open_menu(
            "Scope permissions",
            vec![
                (
                    text(
                        "Model reading",
                        scope.policy.automatic_read != memories::MemoryReadMode::Disabled,
                    ),
                    Action::ReadPolicy,
                ),
                (
                    text(
                        "Model saving",
                        scope.policy.model_write != memories::MemoryWriteMode::Disabled,
                    ),
                    Action::WritePolicy,
                ),
                ("Refresh permissions".into(), Action::ReloadPolicy),
            ],
        );
    }
    fn scroll_key(&self, key: KeyEvent) {
        let lines = match key.code {
            KeyCode::Up => -1,
            KeyCode::Down => 1,
            KeyCode::PageUp => -10,
            KeyCode::PageDown => 10,
            KeyCode::Home => {
                self.scroll.set(0);
                return;
            }
            _ => return,
        };
        self.scroll
            .set(self.scroll.get().saturating_add_signed(lines));
    }
    pub(crate) fn close(&mut self) -> bool {
        if self.pending.is_some() {
            return false;
        }
        if self.editor.as_ref().is_some_and(Editor::dirty) {
            self.open_menu(
                "Unsaved changes",
                vec![
                    ("Continue editing".into(), Action::Continue),
                    ("Discard changes".into(), Action::Discard),
                ],
            );
            self.update_hints();
            return false;
        }
        true
    }
    pub(crate) fn allows_backdrop_dismiss(&self) -> bool {
        self.editor.is_none() && self.pending.is_none()
    }
    pub(crate) fn title(&self) -> &str {
        if let Some(menu) = &self.menu {
            menu.state().title()
        } else if self.showing_latest {
            "Latest memory version"
        } else if self.editor.is_some() {
            "Edit memory"
        } else if self.reference.is_some() {
            "Open memory reference"
        } else if let Some(memory) = &self.detail {
            &memory.title
        } else if let Some(entry) = &self.citation {
            &entry.title
        } else {
            "Memories"
        }
    }
    pub(crate) fn parent_title(&self) -> Option<&str> {
        (self.menu.is_some()
            || self.editor.is_some()
            || self.reference.is_some()
            || self.detail.is_some()
            || self.citation.is_some())
        .then_some("Memories")
    }
    pub(crate) fn tab_rows(&self, width: u16) -> u16 {
        self.displayed_list().map_or(0, |list| list.tab_rows(width))
    }
    pub(crate) fn body_rows(&self, width: u16) -> u16 {
        self.displayed_list()
            .map_or(16, |list| list.body_rows(width) + 2)
    }
    pub(crate) fn draw_tabs(
        &self,
        frame: &mut Frame<'_>,
        area: Rect,
        hovered: Option<usize>,
        pressed: Option<usize>,
        context: RenderContext<'_>,
    ) {
        if let Some(list) = self.displayed_list() {
            crate::widgets::list_selection::draw_tabs(frame, area, list, hovered, pressed, context);
        }
    }
    fn content_area(area: Rect) -> Rect {
        Rect::new(
            area.x,
            area.y.saturating_add(2),
            area.width,
            area.height.saturating_sub(2),
        )
    }
    pub(crate) fn target_at(&self, tabs: Rect, body: Rect, position: Position) -> Option<Target> {
        if self.pending.is_some() {
            return None;
        }
        if let Some(list) = self.displayed_list() {
            return crate::widgets::list_selection::pointer_target_at(
                list,
                tabs,
                Self::content_area(body),
                position,
            )
            .map(Target::List);
        }
        if self.editor.is_some() && !self.showing_latest {
            return Editor::target_at(Self::content_area(body), position).map(Target::Field);
        }
        None
    }
    pub(crate) fn click(
        &mut self,
        target: &Target,
        click: ListSelectionClick,
    ) -> ListSelectionOutcome<Command> {
        let outcome = match target {
            Target::Field(field) => {
                if let Some(editor) = &mut self.editor {
                    editor.field = *field;
                }
                ListSelectionOutcome::Consumed
            }
            Target::List(target) => {
                let index = self.selection.state().active_tab_index();
                let list = self.menu.as_mut().unwrap_or(&mut self.selection);
                list.state_mut().focus_pointer(target);
                if index != self.selection.state().active_tab_index() {
                    self.refresh = true;
                    self.rebuild();
                }
                if matches!(target, ListSelectionPointerTarget::Item(_))
                    && click == ListSelectionClick::Double
                {
                    self.key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
                } else {
                    ListSelectionOutcome::Consumed
                }
            }
        };
        self.update_hints();
        outcome
    }
    pub(crate) fn scroll(&mut self, area: Rect, position: Position, lines: i16) {
        let content = Self::content_area(area);
        if !content.contains(position) {
            return;
        }
        if let Some(menu) = &mut self.menu {
            menu.state_mut().scroll(content, lines);
        } else if self.showing_latest
            || self.detail.is_some() && self.editor.is_none()
            || self.citation.is_some()
        {
            self.scroll
                .set(self.scroll.get().saturating_add_signed(lines));
        } else if let Some(editor) = &mut self.editor {
            if Editor::areas(content).1.contains(position) {
                editor.scroll(lines);
            }
        } else {
            self.selection.state_mut().scroll(content, lines);
        }
    }
    pub(crate) fn draw(
        &self,
        frame: &mut Frame<'_>,
        area: Rect,
        hovered: Option<&Target>,
        pressed: Option<&Target>,
        context: RenderContext<'_>,
    ) {
        let scope = self
            .scopes
            .iter()
            .find(|scope| Some(&scope.policy.scope) == self.scope())
            .map(|scope| scope.label.as_str())
            .unwrap_or("");
        let status = if let Some(message) = &self.message {
            context.localize(message).into_owned()
        } else if self.editor.is_some()
            && self
                .editing
                .as_ref()
                .is_some_and(|memory| memory.source != memories::MemorySource::User)
        {
            context
                .localize("Saving makes this memory user maintained.")
                .into_owned()
        } else if self.citation.is_some() {
            context.localize("Open memory reference").into_owned()
        } else if !self.enabled {
            format!(
                "{} · {}",
                scope,
                context.localize(if self.parent_title().is_none() {
                    "Memories off · c Config"
                } else {
                    "Memories off"
                })
            )
        } else {
            scope.to_owned()
        };
        frame.render_widget(
            Paragraph::new(status).style(Style::default().fg(context.muted())),
            Rect::new(area.x, area.y, area.width, area.height.min(1)),
        );
        let content = Self::content_area(area);
        if let Some(list) = self.displayed_list() {
            fn list_target(target: Option<&Target>) -> Option<&ListSelectionPointerTarget> {
                match target {
                    Some(Target::List(target)) => Some(target),
                    _ => None,
                }
            }
            let item_index = |target: Option<&Target>| match list_target(target) {
                Some(ListSelectionPointerTarget::Item(id)) => list
                    .visible_items()
                    .iter()
                    .position(|item| item.id() == Some(id)),
                _ => None,
            };
            crate::widgets::list_selection::draw_body_with_pointer(
                frame,
                content,
                list,
                matches!(
                    list_target(hovered),
                    Some(ListSelectionPointerTarget::Search)
                ),
                matches!(
                    list_target(pressed),
                    Some(ListSelectionPointerTarget::Search)
                ),
                item_index(hovered),
                item_index(pressed),
                context,
            );
        } else if let Some(editor) = &self.editor
            && !self.showing_latest
        {
            let field = |target: Option<&Target>| match target {
                Some(Target::Field(field)) => Some(*field),
                _ => None,
            };
            editor.draw(frame, content, field(hovered), field(pressed), context);
        } else if let Some(prompt) = &self.reference {
            text_prompt::draw(frame, content, prompt, context);
        } else {
            let memory = if self.showing_latest {
                self.latest.as_ref()
            } else {
                self.detail.as_ref()
            };
            let body = memory
                .map(|memory| memory.body.as_str())
                .or_else(|| self.citation.as_ref().map(|entry| entry.body.as_str()))
                .unwrap_or("");
            let content = if let Some(memory) = memory {
                let source = context.localize(if memory.source == memories::MemorySource::User {
                    "User maintained"
                } else {
                    "Model maintained"
                });
                let updated =
                    chrono::DateTime::from_timestamp_millis(memory.updated_at_unix_ms as i64)
                        .map(|date| date.format("%Y-%m-%d %H:%M UTC").to_string())
                        .unwrap_or_default();
                frame.render_widget(
                    Paragraph::new(format!("{source} · {updated} · r{}", memory.revision))
                        .style(Style::default().fg(context.muted())),
                    Rect::new(content.x, content.y, content.width, content.height.min(1)),
                );
                Self::content_area(content)
            } else {
                content
            };
            let paragraph = Paragraph::new(body)
                .wrap(Wrap { trim: false })
                .style(Style::default().fg(context.foreground()));
            let max = paragraph
                .line_count(content.width.max(1))
                .saturating_sub(usize::from(content.height));
            let scroll = self.scroll.get().min(max.min(u16::MAX as usize) as u16);
            self.scroll.set(scroll);
            frame.render_widget(paragraph.scroll((scroll, 0)), content);
        }
    }
}
fn kind(scope: &MemoryScope) -> usize {
    match scope {
        MemoryScope::Profile => 0,
        MemoryScope::Project { .. } => 1,
        MemoryScope::Dir { .. } => 2,
    }
}
fn groups() -> Vec<ListSelectionGroup> {
    ["Personal", "Projects", "Directories"]
        .into_iter()
        .map(|label| ListSelectionGroup::new(label, Vec::new()))
        .collect()
}
fn item_id(scope: &MemoryScope, id: &memories::MemoryId) -> ListSelectionItemId {
    ListSelectionItemId::new(format!("{}:{id}", scope.storage_key()))
}
fn summary(memory: &Memory) -> Entry {
    Entry {
        id: memory.memory_id.clone(),
        title: memory.title.clone(),
        source: memory.source.clone(),
        updated: memory.updated_at_unix_ms,
        excerpt: String::new(),
    }
}

#[cfg(test)]
#[path = "panel_tests.rs"]
mod tests;
