//! Read-only Hook event browser and configuration handoff.

use crate::keymap::bindings;
use crate::nls::Text;
use crate::widgets::detail_list::{DetailList, DetailListRow};
use crate::widgets::key_hint::KeyHints;
use crate::widgets::list_selection::ListSelection;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::list_selection::ListSelectionOutcome;
use crate::widgets::list_selection::ListSelectionState;
use crate::widgets::search_box::SearchBoxModel;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::ClientError;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::config::HookActionDto;
use ash_app_server_protocol::protocol::config::HookConfigDto;
use ash_app_server_protocol::protocol::config::HookEnablementDto;
use ash_app_server_protocol::protocol::config::HookEventDto;
use ash_app_server_protocol::protocol::config::HookListParams;
use ash_app_server_protocol::protocol::config::HookListResult;
use ash_app_server_protocol::protocol::config::HookSourceDto;
use ash_protocol::SessionId;
use crossterm::event::KeyEvent;
use ratatui::layout::Rect;
use std::collections::BTreeMap;
use std::path::PathBuf;

const REFRESH: bindings::Keybinding = bindings::HOOK_REFRESH;

pub(crate) enum Event {
    Opened(HookListResult),
    Updated(HookListResult),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Command {
    Refresh,
}

pub(crate) fn load<T>(
    client: &mut AppServerClient<T>,
    session_id: Option<&SessionId>,
) -> Result<HookListResult, ClientError>
where
    T: JsonRpcTransport,
{
    client.list_hooks(HookListParams {
        session_id: session_id.cloned(),
    })
}

pub(crate) fn execute<T>(
    client: &mut AppServerClient<T>,
    session_id: Option<&SessionId>,
    command: Command,
) -> Result<Event, String>
where
    T: JsonRpcTransport,
{
    match command {
        Command::Refresh => load(client, session_id)
            .map(Event::Updated)
            .map_err(|error| error.to_string()),
    }
}

#[derive(Clone, Debug)]
enum Action {
    Event(HookEventDto),
    Hook(String),
    Configure,
    Edit(PathBuf),
    Assist,
    Draft(PathBuf),
}

#[derive(Clone, Debug)]
enum Location {
    Root,
    Event(HookEventDto),
    Hook(String),
    Configure,
    Assist,
}

#[derive(Debug)]
struct Page {
    location: Location,
    selection: ListSelection<Action>,
    detail: Option<DetailList>,
    detail_scroll: u16,
    hints: KeyHints,
}

#[derive(Debug)]
pub(crate) enum Outcome {
    Consumed,
    Dismiss,
    Command(Command),
    Edit(PathBuf),
    Draft(String),
}

#[derive(Debug)]
pub(crate) struct Panel {
    catalog: HookListResult,
    project_config: PathBuf,
    connection: crate::TuiConnectionKind,
    page: Page,
    history: Vec<Page>,
    language: crate::nls::Language,
}

impl Panel {
    pub(crate) fn new(catalog: HookListResult, context: &crate::TuiStartupContext) -> Self {
        let page = Page {
            location: Location::Root,
            selection: ListSelection::new(root_model(&catalog), root_actions(&catalog)),
            detail: None,
            detail_scroll: 0,
            hints: KeyHints::new(),
        };
        let mut panel = Self {
            catalog,
            project_config: context.workspace.join(".ash/config.toml"),
            connection: context.connection,
            page,
            history: Vec::new(),
            language: crate::nls::Language::English,
        };
        panel.localize(panel.language);
        panel
    }

    pub(crate) fn update(&mut self, catalog: HookListResult) {
        self.catalog = catalog;
        let (model, actions) = self.selection_model(&self.page.location);
        self.page.selection.replace(model, actions);
        // Saved pages retain focus and search, but must not retain stale configuration contents.
        let models: Vec<_> = self
            .history
            .iter()
            .map(|page| self.selection_model(&page.location))
            .collect();
        for (page, (model, actions)) in self.history.iter_mut().zip(models) {
            page.selection.replace(model, actions);
        }
        self.localize(self.language);
    }

    pub(crate) fn page(&self) -> &ListSelectionState {
        self.page.selection.state()
    }
    pub(crate) fn selection_mut(&mut self) -> Option<&mut ListSelectionState> {
        Some(self.page.selection.state_mut())
    }
    pub(crate) fn key_hints(&self) -> &KeyHints {
        if self
            .page()
            .search()
            .is_some_and(|search| search.input_active())
        {
            self.page.selection.key_hints()
        } else {
            &self.page.hints
        }
    }
    pub(crate) fn parent_title(&self) -> Option<&'static str> {
        (!self.history.is_empty()).then_some("Hooks")
    }
    pub(crate) fn return_to_parent(&mut self) {
        if let Some(page) = self.history.pop() {
            self.page = page;
        }
    }
    pub(crate) fn localize(&mut self, language: crate::nls::Language) {
        self.language = language;
        let details: Vec<_> = std::iter::once(&self.page)
            .chain(self.history.iter())
            .map(|page| self.detail_model(&page.location))
            .collect();
        for (page, detail) in std::iter::once(&mut self.page)
            .chain(self.history.iter_mut())
            .zip(details)
        {
            page.detail = detail;
            page.selection.state_mut().localize(language);
            let mut hints = KeyHints::compact()
                .with_compact_action(bindings::ACCEPT.keys(), bindings::ACCEPT.action());
            if matches!(page.location, Location::Root) {
                hints = hints.with_compact_action("Tab", "tabs");
            }
            if matches!(page.location, Location::Root | Location::Event(_)) {
                hints =
                    hints.with_compact_action(bindings::SEARCH.keys(), bindings::SEARCH.action());
            }
            if page.detail.is_some() {
                hints = hints.with_compact_action("PgUp/PgDn", "scroll");
            }
            page.hints = hints
                .with_compact_action(REFRESH.keys(), REFRESH.action())
                .with_compact_action(
                    "Esc",
                    if matches!(page.location, Location::Root) {
                        "close"
                    } else {
                        "return"
                    },
                );
        }
    }
    pub(crate) fn detail(&self) -> Option<(&DetailList, u16)> {
        self.page
            .detail
            .as_ref()
            .map(|detail| (detail, self.page.detail_scroll))
    }
    pub(crate) fn handle_paste(&mut self, pasted: String) {
        self.page.selection.handle_paste(pasted);
    }

    pub(crate) fn handle_key(&mut self, key: KeyEvent, area: Rect) -> Outcome {
        if key.kind == crossterm::event::KeyEventKind::Release {
            return Outcome::Consumed;
        }
        if let Some(detail) = self.page.detail.as_ref() {
            let detail_area = crate::widgets::detail_list::split_with_actions(
                area,
                self.page().body_rows(area.width),
            )[0];
            let limit = detail
                .content_height(detail_area.width)
                .saturating_sub(usize::from(detail_area.height))
                .min(usize::from(u16::MAX)) as u16;
            self.page.detail_scroll = self.page.detail_scroll.min(limit);
            if bindings::PAGE_PREVIOUS.matches(key) {
                self.page.detail_scroll =
                    self.page.detail_scroll.saturating_sub(detail_area.height);
                return Outcome::Consumed;
            }
            if bindings::PAGE_NEXT.matches(key) {
                self.page.detail_scroll = self
                    .page
                    .detail_scroll
                    .saturating_add(detail_area.height)
                    .min(limit);
                return Outcome::Consumed;
            }
        }
        if !self
            .page()
            .search()
            .is_some_and(|search| search.input_active())
            && REFRESH.matches(key)
        {
            return Outcome::Command(Command::Refresh);
        }
        match self.page.selection.handle_key(key) {
            ListSelectionOutcome::Activate(action) => match action {
                Action::Event(event) => self.open(Location::Event(event)),
                Action::Hook(id) => self.open(Location::Hook(id)),
                Action::Configure => self.open(Location::Configure),
                Action::Assist => self.open(Location::Assist),
                Action::Edit(path) => return Outcome::Edit(path),
                Action::Draft(path) => return Outcome::Draft(self.assistance_prompt(&path)),
            },
            ListSelectionOutcome::Dismiss if self.history.is_empty() => return Outcome::Dismiss,
            ListSelectionOutcome::Dismiss => self.return_to_parent(),
            _ => {}
        }
        Outcome::Consumed
    }

    fn open(&mut self, location: Location) {
        let (model, actions) = self.selection_model(&location);
        let mut selection = ListSelection::new(model, actions);
        selection.state_mut().localize(self.language);
        let old = std::mem::replace(
            &mut self.page,
            Page {
                location,
                selection,
                detail: None,
                detail_scroll: 0,
                hints: KeyHints::new(),
            },
        );
        self.history.push(old);
        self.localize(self.language);
    }

    fn selected_event(&self) -> Option<HookEventDto> {
        std::iter::once(&self.page)
            .chain(self.history.iter().rev())
            .find_map(|page| match &page.location {
                Location::Event(event) => Some(*event),
                Location::Hook(id) => self.find_hook(id).map(|(_, hook)| hook.event),
                _ => None,
            })
    }

    fn find_hook(&self, id: &str) -> Option<(&HookSourceDto, &HookConfigDto)> {
        self.catalog.sources.iter().find_map(|source| {
            source
                .hooks
                .iter()
                .find(|hook| hook.id == id)
                .map(|hook| (source, hook))
        })
    }

    fn detail_model(&self, location: &Location) -> Option<DetailList> {
        let Location::Hook(id) = location else {
            return None;
        };
        let (source, hook) = self.find_hook(id)?;
        let HookActionDto::Process { program, args } = &hook.action;
        Some(DetailList::new(
            id,
            [
                ("Event", event_label(hook.event).to_owned()),
                (
                    "Enablement",
                    crate::nls::localize_owned(self.language, enablement_label(hook.enablement)),
                ),
                ("Source file", source.config_path.display().to_string()),
                (
                    "Tool names",
                    serde_json::to_string(&hook.matcher.tool_names).expect("tool names serialize"),
                ),
                ("Program", program.clone()),
                (
                    "Arguments",
                    serde_json::to_string(args).expect("Hook arguments serialize"),
                ),
            ]
            .into_iter()
            .map(|(label, value)| {
                DetailListRow::new(crate::nls::localize_owned(self.language, label), value)
            })
            .collect(),
        ))
    }

    fn assistance_prompt(&self, path: &std::path::Path) -> String {
        let event = match self.selected_event() {
            Some(event) => Text::literal(event_label(event)),
            None => Text::from("custom"),
        };
        let namespace = self
            .catalog
            .sources
            .iter()
            .find(|source| source.config_path == path)
            .map(|source| source.namespace.as_str());
        let template = if namespace.is_some() {
            "Help me configure {0} Hooks in {1}. Inspect the existing TOML and preserve other settings. Use the configuration source's namespace ({2}) for Hook IDs. Explain the trigger, command and scope, then validate the configuration. My requirement: "
        } else {
            "Help me configure {0} Hooks in {1}. Inspect the existing TOML and preserve other settings. Resolve the project directory's namespace through App Server before choosing Hook IDs. Explain the trigger, command and scope, then validate the configuration. My requirement: "
        };
        let mut args = vec![event, Text::literal(path.display().to_string())];
        if let Some(namespace) = namespace {
            args.push(Text::literal(namespace));
        }
        let mut prompt = Text::template(template, args);
        prompt.localize(self.language);
        prompt.to_string()
    }

    fn selection_model(
        &self,
        location: &Location,
    ) -> (ListSelectionModel, BTreeMap<ListSelectionItemId, Action>) {
        match location {
            Location::Root => (root_model(&self.catalog), root_actions(&self.catalog)),
            Location::Event(event) => {
                let mut actions = BTreeMap::new();
                let mut items = Vec::new();
                for source in &self.catalog.sources {
                    for hook in source.hooks.iter().filter(|hook| hook.event == *event) {
                        let id = ListSelectionItemId::new(&hook.id);
                        actions.insert(id.clone(), Action::Hook(hook.id.clone()));
                        items.push(
                            ListSelectionItem::new(Text::literal(&hook.id))
                                .with_id(id)
                                .with_description(Text::template(
                                    "{0}  ·  {1}",
                                    vec![
                                        enablement_label(hook.enablement).into(),
                                        Text::literal(source.config_path.display().to_string()),
                                    ],
                                )),
                        );
                    }
                }
                let model = simple_model(Text::literal(event_label(*event)), items)
                    .with_action(configure_item())
                    .with_search(SearchBoxModel::new("Search Hooks"))
                    .with_empty_message("No configured Hooks for this event");
                actions.insert(
                    ListSelectionItemId::new("configure-hooks"),
                    Action::Configure,
                );
                (model, actions)
            }
            Location::Hook(id) => {
                let mut items = Vec::new();
                let mut actions = BTreeMap::new();
                if let Some((source, _)) = self.find_hook(id) {
                    if self.connection == crate::TuiConnectionKind::Local {
                        items.push(
                            ListSelectionItem::new("Edit configuration")
                                .with_id(ListSelectionItemId::new("edit-source")),
                        );
                        actions.insert(
                            ListSelectionItemId::new("edit-source"),
                            Action::Edit(source.config_path.clone()),
                        );
                    }
                    items.push(
                        ListSelectionItem::new("Ask Ash to configure")
                            .with_id(ListSelectionItemId::new("ask-ash")),
                    );
                    actions.insert(
                        ListSelectionItemId::new("ask-ash"),
                        Action::Draft(source.config_path.clone()),
                    );
                }
                (
                    simple_model(Text::literal(id), items)
                        .with_empty_message("This Hook was removed from its configuration"),
                    actions,
                )
            }
            Location::Configure | Location::Assist => {
                let mut actions = BTreeMap::new();
                let mut items = Vec::new();
                let assist = matches!(location, Location::Assist);
                if assist || self.connection == crate::TuiConnectionKind::Local {
                    for (id, label, path) in [
                        (
                            "edit-user-config",
                            "User configuration",
                            self.catalog
                                .sources
                                .iter()
                                .find(|source| source.namespace == "user")
                                .expect("Hook catalog includes user source")
                                .config_path
                                .clone(),
                        ),
                        (
                            "edit-project-config",
                            "Project configuration",
                            self.project_config.clone(),
                        ),
                    ] {
                        items.push(
                            ListSelectionItem::new(label)
                                .with_id(ListSelectionItemId::new(id))
                                .with_description(Text::literal(path.display().to_string())),
                        );
                        actions.insert(
                            ListSelectionItemId::new(id),
                            if assist {
                                Action::Draft(path)
                            } else {
                                Action::Edit(path)
                            },
                        );
                    }
                } else {
                    items.push(ListSelectionItem::new(
                        "Edit the configuration on the connected host",
                    ));
                }
                if !assist {
                    items.push(
                        ListSelectionItem::new("Ask Ash to configure")
                            .with_id(ListSelectionItemId::new("ask-ash")),
                    );
                    actions.insert(ListSelectionItemId::new("ask-ash"), Action::Assist);
                }
                (
                    simple_model(
                        if assist {
                            "Choose configuration scope"
                        } else {
                            "Configure Hooks"
                        }
                        .into(),
                        items,
                    ),
                    actions,
                )
            }
        }
    }
}

fn event_id(event: HookEventDto) -> ListSelectionItemId {
    ListSelectionItemId::new(format!("hook-event-{}", event_label(event)))
}

fn events(catalog: &HookListResult) -> Vec<HookEventDto> {
    let mut events = HookEventDto::ALL.to_vec();
    // Older declarations retain their event semantics and remain inspectable without adding them to the new catalog.
    for event in [
        HookEventDto::BeforeTool,
        HookEventDto::AfterTool,
        HookEventDto::TurnCompleted,
    ] {
        if catalog
            .sources
            .iter()
            .any(|source| source.hooks.iter().any(|hook| hook.event == event))
        {
            events.push(event);
        }
    }
    events
}

fn configure_item() -> ListSelectionItem {
    ListSelectionItem::new("Configure Hooks").with_id(ListSelectionItemId::new("configure-hooks"))
}

fn root_actions(catalog: &HookListResult) -> BTreeMap<ListSelectionItemId, Action> {
    events(catalog)
        .into_iter()
        .map(|event| (event_id(event), Action::Event(event)))
        .chain([(
            ListSelectionItemId::new("configure-hooks"),
            Action::Configure,
        )])
        .collect()
}

fn root_model(catalog: &HookListResult) -> ListSelectionModel {
    let items = events(catalog)
        .into_iter()
        .map(|event| {
            let count = catalog
                .sources
                .iter()
                .flat_map(|source| &source.hooks)
                .filter(|hook| hook.event == event)
                .count();
            ListSelectionItem::new(Text::template(
                "{0} ({1})",
                vec![
                    Text::literal(event_label(event)),
                    Text::literal(count.to_string()),
                ],
            ))
            .with_id(event_id(event))
            .with_description(event_description(event))
        })
        .collect();
    crate::extensions::model(crate::extensions::Tab::Hooks, items)
        .with_activation(bindings::ACCEPT)
        .with_action(configure_item())
        .with_search(SearchBoxModel::new("Search Hook events"))
        .with_empty_message("No Hook events found")
        .with_key_hint_action(REFRESH)
}

fn simple_model(title: Text, items: Vec<ListSelectionItem>) -> ListSelectionModel {
    ListSelectionModel::new(title, vec![ListSelectionGroup::new("", items)])
        .without_tab_bar()
        .with_activation(bindings::ACCEPT)
        .with_dismiss(bindings::RETURN_LIST)
        .with_key_hint_action(REFRESH)
}

fn event_label(event: HookEventDto) -> &'static str {
    match event {
        HookEventDto::PreToolUse => "PreToolUse",
        HookEventDto::PostToolUse => "PostToolUse",
        HookEventDto::PostToolUseFailure => "PostToolUseFailure",
        HookEventDto::PostToolBatch => "PostToolBatch",
        HookEventDto::PermissionDenied => "PermissionDenied",
        HookEventDto::Notification => "Notification",
        HookEventDto::UserPromptSubmit => "UserPromptSubmit",
        HookEventDto::UserPromptExpansion => "UserPromptExpansion",
        HookEventDto::SessionStart => "SessionStart",
        HookEventDto::Stop => "Stop",
        HookEventDto::StopFailure => "StopFailure",
        HookEventDto::SubagentStart => "SubagentStart",
        HookEventDto::SubagentStop => "SubagentStop",
        HookEventDto::PreCompact => "PreCompact",
        HookEventDto::PostCompact => "PostCompact",
        HookEventDto::PreModelSwitch => "PreModelSwitch",
        HookEventDto::PostModelSwitch => "PostModelSwitch",
        HookEventDto::SessionEnd => "SessionEnd",
        HookEventDto::PermissionRequest => "PermissionRequest",
        HookEventDto::Setup => "Setup",
        HookEventDto::TeammateIdle => "TeammateIdle",
        HookEventDto::TaskCreated => "TaskCreated",
        HookEventDto::TaskCompleted => "TaskCompleted",
        HookEventDto::Elicitation => "Elicitation",
        HookEventDto::ElicitationResult => "ElicitationResult",
        HookEventDto::ConfigChange => "ConfigChange",
        HookEventDto::InstructionsLoaded => "InstructionsLoaded",
        HookEventDto::WorktreeCreate => "WorktreeCreate",
        HookEventDto::WorktreeRemove => "WorktreeRemove",
        HookEventDto::CwdChanged => "CwdChanged",
        HookEventDto::FileChanged => "FileChanged",
        HookEventDto::DirectoryAdded => "DirectoryAdded",
        HookEventDto::MessageDisplay => "MessageDisplay",
        HookEventDto::BeforeTool => "Before tool",
        HookEventDto::AfterTool => "After tool",
        HookEventDto::TurnCompleted => "Turn completed",
    }
}

fn event_description(event: HookEventDto) -> &'static str {
    match event {
        HookEventDto::PreToolUse => "Before tool execution",
        HookEventDto::PostToolUse => "After successful tool execution",
        HookEventDto::PostToolUseFailure => "After tool execution fails",
        HookEventDto::PostToolBatch => "After a batch of tool calls resolves",
        HookEventDto::PermissionDenied => "After tool permission is denied",
        HookEventDto::Notification => "When a user notification is sent",
        HookEventDto::UserPromptSubmit => "When the user submits a prompt",
        HookEventDto::UserPromptExpansion => "When a slash command expands",
        HookEventDto::SessionStart => "When a session starts",
        HookEventDto::Stop => "After a turn completes",
        HookEventDto::StopFailure => "When a turn ends in failure",
        HookEventDto::SubagentStart => "When a subagent starts",
        HookEventDto::SubagentStop => "After a subagent produces its result",
        HookEventDto::PreCompact => "Before conversation compaction",
        HookEventDto::PostCompact => "After conversation compaction",
        HookEventDto::PreModelSwitch => "Before a requested model switch",
        HookEventDto::PostModelSwitch => "After the session model changes",
        HookEventDto::SessionEnd => "When a session ends",
        HookEventDto::PermissionRequest => "Before a permission request is shown",
        HookEventDto::Setup => "When repository setup starts",
        HookEventDto::TeammateIdle => "When a teammate finishes assigned work",
        HookEventDto::TaskCreated => "When a plan step is created",
        HookEventDto::TaskCompleted => "When a plan step is completed",
        HookEventDto::Elicitation => "Before an MCP server requests user input",
        HookEventDto::ElicitationResult => "After the user responds to an MCP request",
        HookEventDto::ConfigChange => "When configuration changes",
        HookEventDto::InstructionsLoaded => "When an instruction file is read",
        HookEventDto::WorktreeCreate => "Before a worktree is created",
        HookEventDto::WorktreeRemove => "Before a worktree is removed",
        HookEventDto::CwdChanged => "After the active directory changes",
        HookEventDto::FileChanged => "When a watched file changes",
        HookEventDto::DirectoryAdded => "After a directory is added to a session",
        HookEventDto::MessageDisplay => "When assistant text is sent to a client",
        HookEventDto::BeforeTool => "Before tool execution",
        HookEventDto::AfterTool => "After tool execution",
        HookEventDto::TurnCompleted => "After a turn completes",
    }
}

fn enablement_label(enablement: HookEnablementDto) -> &'static str {
    match enablement {
        HookEnablementDto::Enabled => "enabled",
        HookEnablementDto::Disabled => "disabled",
    }
}

#[cfg(test)]
#[path = "hooks_tests.rs"]
mod tests;
