//! TUI editor for declarative user Hooks.

use crate::client::new_command_id;
use crate::keymap::bindings;
use crate::nls::Text;
use crate::widgets::key_hint::KeyHints;
use crate::widgets::list_selection::ListSelection;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::list_selection::ListSelectionOutcome;
use crate::widgets::list_selection::ListSelectionState;
use crate::widgets::search_box::SearchBoxModel;
use crate::widgets::text_prompt::TextPrompt;
use crate::widgets::text_prompt::TextPromptOutcome;
use crate::widgets::text_prompt::TextPromptSpec;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::ClientError;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::config::HookActionDto;
use ash_app_server_protocol::protocol::config::HookConfigDto;
use ash_app_server_protocol::protocol::config::HookEnablementDto;
use ash_app_server_protocol::protocol::config::HookEventDto;
use ash_app_server_protocol::protocol::config::HookMatcherDto;
use ash_app_server_protocol::protocol::config::HookRemoveParams;
use ash_app_server_protocol::protocol::config::HookSetEnablementParams;
use ash_app_server_protocol::protocol::config::HookUpsertParams;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use std::collections::BTreeMap;

pub(crate) enum Event {
    Opened(BTreeMap<String, HookConfigDto>),
    Updated(BTreeMap<String, HookConfigDto>),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Command {
    Upsert(HookConfigDto),
    Remove(String),
    SetEnablement(String, HookEnablementDto),
}

pub(crate) fn load<T>(
    client: &mut AppServerClient<T>,
) -> Result<BTreeMap<String, HookConfigDto>, ClientError>
where
    T: JsonRpcTransport,
{
    Ok(client.read_config()?.hooks)
}

pub(crate) fn execute<T>(client: &mut AppServerClient<T>, command: Command) -> Result<Event, String>
where
    T: JsonRpcTransport,
{
    let config = client.read_config().map_err(|error| error.to_string())?;
    match command {
        Command::Upsert(hook) => client.upsert_hook(HookUpsertParams {
            command_id: new_command_id("hook-upsert"),
            expected_revision: config.revision,
            hook,
        }),
        Command::Remove(hook_id) => client.remove_hook(HookRemoveParams {
            command_id: new_command_id("hook-remove"),
            expected_revision: config.revision,
            hook_id,
        }),
        Command::SetEnablement(hook_id, enablement) => {
            client.set_hook_enablement(HookSetEnablementParams {
                command_id: new_command_id("hook-enablement"),
                expected_revision: config.revision,
                hook_id,
                enablement,
            })
        }
    }
    .map_err(|error| error.to_string())?;
    load(client)
        .map(Event::Updated)
        .map_err(|error| error.to_string())
}

#[derive(Clone, Debug)]
enum Action {
    Add,
    Open(String),
    Toggle,
    Edit,
    Delete,
    ConfirmDelete,
    CancelDelete,
    Field(Field),
    CycleEvent,
    Save,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Field {
    Id,
    ToolNames,
    Program,
    Arguments,
}

enum Page {
    Root(ListSelection<Action>),
    Detail(String, ListSelection<Action>),
    Editor {
        original_id: Option<String>,
        draft: HookConfigDto,
        selection: ListSelection<Action>,
    },
    Prompt {
        original_id: Option<String>,
        draft: HookConfigDto,
        field: Field,
        prompt: TextPrompt,
    },
    ConfirmDelete(String, ListSelection<Action>),
}

pub(crate) enum PageView<'a> {
    Selection(&'a ListSelectionState),
    Prompt(&'a TextPrompt),
}

#[derive(Debug)]
pub(crate) enum Outcome {
    Consumed,
    Dismiss,
    Command(Command),
}

pub(crate) struct Panel {
    hooks: BTreeMap<String, HookConfigDto>,
    page: Option<Page>,
    prompt_hints: KeyHints,
    language: crate::nls::Language,
    pending_saved_id: Option<String>,
}

impl std::fmt::Debug for Panel {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("HooksPanel").finish_non_exhaustive()
    }
}

impl Panel {
    pub(crate) fn new(hooks: BTreeMap<String, HookConfigDto>) -> Self {
        let root = root_selection(&hooks);
        Self {
            hooks,
            page: Some(Page::Root(root)),
            prompt_hints: KeyHints::new()
                .with_binding(bindings::SAVE)
                .with_action("Ctrl+U", "clear input")
                .with_binding(bindings::CANCEL),
            language: crate::nls::Language::English,
            pending_saved_id: None,
        }
    }

    pub(crate) fn update(&mut self, hooks: BTreeMap<String, HookConfigDto>) {
        self.hooks = hooks;
        if let Some(id) = self.pending_saved_id.take()
            && let Some(hook) = self.hooks.get(&id)
        {
            self.page = Some(Page::Detail(id, detail_selection(hook)));
        }
        match self.page.as_mut() {
            Some(Page::Root(_)) => {
                self.page = Some(Page::Root(root_selection(&self.hooks)));
            }
            Some(Page::Detail(id, _)) => {
                self.page = Some(self.hooks.get(id).map_or_else(
                    || Page::Root(root_selection(&self.hooks)),
                    |hook| Page::Detail(id.clone(), detail_selection(hook)),
                ));
            }
            Some(Page::ConfirmDelete(id, _)) if !self.hooks.contains_key(id) => {
                self.page = Some(Page::Root(root_selection(&self.hooks)));
            }
            _ => {}
        }
        self.localize(self.language);
    }

    pub(crate) fn page(&self) -> PageView<'_> {
        match self.page.as_ref().expect("Hooks panel page exists") {
            Page::Root(selection)
            | Page::Detail(_, selection)
            | Page::Editor { selection, .. }
            | Page::ConfirmDelete(_, selection) => PageView::Selection(selection.state()),
            Page::Prompt { prompt, .. } => PageView::Prompt(prompt),
        }
    }

    pub(crate) fn selection_mut(&mut self) -> Option<&mut ListSelectionState> {
        match self.page.as_mut()? {
            Page::Root(selection)
            | Page::Detail(_, selection)
            | Page::Editor { selection, .. }
            | Page::ConfirmDelete(_, selection) => Some(selection.state_mut()),
            Page::Prompt { .. } => None,
        }
    }

    pub(crate) fn key_hints(&self) -> &KeyHints {
        match self.page.as_ref().expect("Hooks panel page exists") {
            Page::Root(selection)
            | Page::Detail(_, selection)
            | Page::Editor { selection, .. }
            | Page::ConfirmDelete(_, selection) => selection.key_hints(),
            Page::Prompt { .. } => &self.prompt_hints,
        }
    }

    pub(crate) fn parent_title(&self) -> Option<&'static str> {
        match self.page.as_ref() {
            Some(Page::Root(_)) | None => None,
            _ => Some("Hooks"),
        }
    }

    pub(crate) fn return_to_parent(&mut self) {
        self.pending_saved_id = None;
        self.page = Some(match self.page.take().expect("Hooks panel page exists") {
            Page::Prompt {
                original_id, draft, ..
            } => editor_page(original_id, draft),
            Page::ConfirmDelete(id, _) => {
                Page::Detail(id.clone(), detail_selection(&self.hooks[&id]))
            }
            Page::Editor {
                original_id: Some(id),
                ..
            } => Page::Detail(id.clone(), detail_selection(&self.hooks[&id])),
            Page::Root(_)
            | Page::Detail(_, _)
            | Page::Editor {
                original_id: None, ..
            } => Page::Root(root_selection(&self.hooks)),
        });
        self.localize(self.language);
    }

    pub(crate) fn localize(&mut self, language: crate::nls::Language) {
        self.language = language;
        match self.page.as_mut() {
            Some(Page::Prompt { prompt, .. }) => prompt.localize(language),
            _ => {
                if let Some(selection) = self.selection_mut() {
                    selection.localize(language);
                }
            }
        }
    }

    pub(crate) fn handle_paste(&mut self, pasted: String) {
        match self.page.as_mut().expect("Hooks panel page exists") {
            Page::Root(selection)
            | Page::Detail(_, selection)
            | Page::Editor { selection, .. }
            | Page::ConfirmDelete(_, selection) => selection.handle_paste(pasted),
            Page::Prompt { prompt, .. } => prompt.handle_paste(pasted),
        }
    }

    pub(crate) fn handle_key(&mut self, key: KeyEvent) -> Outcome {
        if key.code == KeyCode::Esc {
            self.pending_saved_id = None;
        }
        let page = self.page.take().expect("Hooks panel page exists");
        let (next, outcome) = match page {
            Page::Root(mut selection) => match selection.handle_key(key) {
                ListSelectionOutcome::Activate(Action::Add) => {
                    (editor_page(None, empty_hook()), Outcome::Consumed)
                }
                ListSelectionOutcome::Activate(Action::Open(id)) => (
                    Page::Detail(id.clone(), detail_selection(&self.hooks[&id])),
                    Outcome::Consumed,
                ),
                ListSelectionOutcome::Dismiss => (Page::Root(selection), Outcome::Dismiss),
                _ => (Page::Root(selection), Outcome::Consumed),
            },
            Page::Detail(id, mut selection) => match selection.handle_key(key) {
                ListSelectionOutcome::Activate(Action::Toggle) => {
                    let hook = &self.hooks[&id];
                    let next = match hook.enablement {
                        HookEnablementDto::Enabled => HookEnablementDto::Disabled,
                        HookEnablementDto::Disabled => HookEnablementDto::Enabled,
                    };
                    (
                        Page::Detail(id.clone(), selection),
                        Outcome::Command(Command::SetEnablement(id, next)),
                    )
                }
                ListSelectionOutcome::Activate(Action::Edit) => (
                    editor_page(Some(id.clone()), self.hooks[&id].clone()),
                    Outcome::Consumed,
                ),
                ListSelectionOutcome::Activate(Action::Delete) => (
                    Page::ConfirmDelete(id.clone(), delete_selection(&id)),
                    Outcome::Consumed,
                ),
                ListSelectionOutcome::Dismiss => {
                    (Page::Root(root_selection(&self.hooks)), Outcome::Consumed)
                }
                _ => (Page::Detail(id, selection), Outcome::Consumed),
            },
            Page::ConfirmDelete(id, mut selection) => match selection.handle_key(key) {
                ListSelectionOutcome::Activate(Action::ConfirmDelete) => (
                    Page::ConfirmDelete(id.clone(), selection),
                    Outcome::Command(Command::Remove(id)),
                ),
                ListSelectionOutcome::Activate(Action::CancelDelete)
                | ListSelectionOutcome::Dismiss => (
                    Page::Detail(id.clone(), detail_selection(&self.hooks[&id])),
                    Outcome::Consumed,
                ),
                _ => (Page::ConfirmDelete(id, selection), Outcome::Consumed),
            },
            Page::Editor {
                original_id,
                draft,
                mut selection,
            } => match selection.handle_key(key) {
                ListSelectionOutcome::Activate(Action::Field(field)) => {
                    let prompt = prompt_for(field, &draft, None);
                    (
                        Page::Prompt {
                            original_id,
                            draft,
                            field,
                            prompt,
                        },
                        Outcome::Consumed,
                    )
                }
                ListSelectionOutcome::Activate(Action::CycleEvent) => {
                    let mut draft = draft;
                    draft.event = match draft.event {
                        HookEventDto::BeforeTool => HookEventDto::AfterTool,
                        HookEventDto::AfterTool => HookEventDto::TurnCompleted,
                        HookEventDto::TurnCompleted => HookEventDto::BeforeTool,
                    };
                    // A completed Turn has no tool subject, so the server rejects tool matchers.
                    if draft.event == HookEventDto::TurnCompleted {
                        draft.matcher.tool_names.clear();
                    }
                    (editor_page(original_id, draft), Outcome::Consumed)
                }
                ListSelectionOutcome::Activate(Action::Save)
                    if !draft.id.is_empty() && !process_program(&draft).is_empty() =>
                {
                    if original_id.is_none() && self.hooks.contains_key(&draft.id) {
                        let prompt =
                            prompt_for(Field::Id, &draft, Some("Hook name already exists"));
                        (
                            Page::Prompt {
                                original_id,
                                draft,
                                field: Field::Id,
                                prompt,
                            },
                            Outcome::Consumed,
                        )
                    } else {
                        (
                            Page::Editor {
                                original_id,
                                draft: draft.clone(),
                                selection,
                            },
                            Outcome::Command(Command::Upsert(draft)),
                        )
                    }
                }
                ListSelectionOutcome::Dismiss => {
                    let next = original_id
                        .as_ref()
                        .map(|id| Page::Detail(id.clone(), detail_selection(&self.hooks[id])))
                        .unwrap_or_else(|| Page::Root(root_selection(&self.hooks)));
                    (next, Outcome::Consumed)
                }
                _ => (
                    Page::Editor {
                        original_id,
                        draft,
                        selection,
                    },
                    Outcome::Consumed,
                ),
            },
            Page::Prompt {
                original_id,
                mut draft,
                field,
                mut prompt,
            } => match prompt.handle_key(key) {
                TextPromptOutcome::Dismiss => (editor_page(original_id, draft), Outcome::Consumed),
                TextPromptOutcome::Consumed => (
                    Page::Prompt {
                        original_id,
                        draft,
                        field,
                        prompt,
                    },
                    Outcome::Consumed,
                ),
                TextPromptOutcome::Submit(value) => {
                    let result = apply_field(&mut draft, field, &value);
                    if let Err(message) = result {
                        let prompt =
                            prompt_for(field, &draft, Some(message)).with_initial_value(value);
                        (
                            Page::Prompt {
                                original_id,
                                draft,
                                field,
                                prompt,
                            },
                            Outcome::Consumed,
                        )
                    } else {
                        (editor_page(original_id, draft), Outcome::Consumed)
                    }
                }
            },
        };
        self.page = Some(next);
        if let Outcome::Command(Command::Upsert(hook)) = &outcome {
            self.pending_saved_id = Some(hook.id.clone());
        }
        self.localize(self.language);
        outcome
    }
}

fn empty_hook() -> HookConfigDto {
    HookConfigDto {
        id: String::new(),
        event: HookEventDto::BeforeTool,
        matcher: HookMatcherDto {
            tool_names: Vec::new(),
        },
        action: HookActionDto::Process {
            program: String::new(),
            args: Vec::new(),
        },
        enablement: HookEnablementDto::Disabled,
    }
}

fn root_actions(hooks: &BTreeMap<String, HookConfigDto>) -> BTreeMap<ListSelectionItemId, Action> {
    hooks
        .keys()
        .map(|id| (ListSelectionItemId::new(id), Action::Open(id.clone())))
        .chain([(ListSelectionItemId::new("add-hook"), Action::Add)])
        .collect()
}

fn root_selection(hooks: &BTreeMap<String, HookConfigDto>) -> ListSelection<Action> {
    let items = hooks
        .values()
        .map(|hook| {
            ListSelectionItem::new(Text::literal(&hook.id))
                .with_id(ListSelectionItemId::new(&hook.id))
                .with_description(Text::template(
                    "{0}  ·  {1}",
                    vec![
                        event_label(hook.event).into(),
                        enablement_label(hook.enablement).into(),
                    ],
                ))
        })
        .collect();
    let model = ListSelectionModel::new("Hooks", vec![ListSelectionGroup::new("", items)])
        .without_tab_bar()
        .with_activation(bindings::ACCEPT)
        .with_action(
            ListSelectionItem::new("Add Hook").with_id(ListSelectionItemId::new("add-hook")),
        )
        .with_search(SearchBoxModel::new("Search Hooks"))
        .with_empty_message("No Hooks found");
    let mut selection = ListSelection::new(model, root_actions(hooks));
    if hooks.is_empty() {
        selection
            .state_mut()
            .focus_pointer(&crate::widgets::list_selection::ListSelectionPointerTarget::Action);
    }
    selection
}

fn detail_selection(hook: &HookConfigDto) -> ListSelection<Action> {
    let items = vec![
        (
            "Enablement",
            enablement_label(hook.enablement).into(),
            Action::Toggle,
        ),
        (
            "Edit Hook",
            Text::template(
                "{0}  ·  {1}",
                vec![
                    event_label(hook.event).into(),
                    Text::literal(process_program(hook)),
                ],
            ),
            Action::Edit,
        ),
        ("Delete Hook", Text::literal(&hook.id), Action::Delete),
    ];
    simple_selection(&hook.id, items)
}

fn delete_selection(id: &str) -> ListSelection<Action> {
    simple_selection(
        "Delete Hook?",
        vec![
            ("Cancel", Text::literal(id), Action::CancelDelete),
            ("Delete Hook", Text::literal(id), Action::ConfirmDelete),
        ],
    )
}

fn editor_page(original_id: Option<String>, draft: HookConfigDto) -> Page {
    let program = process_program(&draft);
    let args = process_args(&draft);
    let mut fields = Vec::new();
    if original_id.is_none() {
        fields.push(("ID", Text::literal(&draft.id), Action::Field(Field::Id)));
    }
    fields.extend([
        ("Event", event_label(draft.event).into(), Action::CycleEvent),
        (
            "Tool names",
            Text::literal(draft.matcher.tool_names.join(", ")),
            Action::Field(Field::ToolNames),
        ),
        (
            "Program",
            Text::literal(program),
            Action::Field(Field::Program),
        ),
        (
            "Arguments",
            Text::literal(serde_json::to_string(args).expect("Hook arguments serialize")),
            Action::Field(Field::Arguments),
        ),
        (
            "Save Hook",
            if draft.id.is_empty() || program.is_empty() {
                "ID and program required".into()
            } else {
                Text::literal("")
            },
            Action::Save,
        ),
    ]);
    let selection = simple_selection(
        if original_id.is_some() {
            "Edit Hook"
        } else {
            "Add Hook"
        },
        fields,
    );
    Page::Editor {
        original_id,
        draft,
        selection,
    }
}

fn simple_selection(title: &str, items: Vec<(&str, Text, Action)>) -> ListSelection<Action> {
    let mut actions = BTreeMap::new();
    let items = items
        .into_iter()
        .enumerate()
        .map(|(index, (label, description, action))| {
            let id = ListSelectionItemId::new(format!("hook-action-{index}"));
            actions.insert(id.clone(), action);
            let item = ListSelectionItem::new(label).with_id(id);
            if description.is_empty() {
                item
            } else {
                item.with_description(description)
            }
        })
        .collect();
    ListSelection::new(
        ListSelectionModel::new(title, vec![ListSelectionGroup::new("", items)])
            .without_tab_bar()
            .with_activation(bindings::ACCEPT)
            .with_dismiss(bindings::RETURN_LIST),
        actions,
    )
}

fn prompt_for(field: Field, draft: &HookConfigDto, error: Option<&str>) -> TextPrompt {
    let (title, explanation, value) = match field {
        Field::Id => (
            "Hook ID",
            "Enter a unique Hook name",
            if draft.id.is_empty() {
                String::new()
            } else {
                draft
                    .id
                    .strip_prefix("user:hook:")
                    .expect("new Hook uses user namespace")
                    .to_owned()
            },
        ),
        Field::ToolNames => (
            "Tool names",
            "Comma-separated exact tool names; enter - to clear",
            draft.matcher.tool_names.join(", "),
        ),
        Field::Program => (
            "Program",
            "Executable to run",
            process_program(draft).to_owned(),
        ),
        Field::Arguments => (
            "Arguments",
            "Enter a JSON array of arguments, for example [\"--flag\"]",
            serde_json::to_string(process_args(draft)).expect("Hook arguments serialize"),
        ),
    };
    TextPrompt::new(TextPromptSpec {
        title: title.into(),
        explanation: error.unwrap_or(explanation).into(),
        placeholder: title.into(),
        masked: false,
    })
    .with_initial_value(value)
}

fn apply_field(draft: &mut HookConfigDto, field: Field, value: &str) -> Result<(), &'static str> {
    match field {
        Field::Id => {
            if value.contains(':') || value.chars().any(char::is_whitespace) {
                return Err("Hook name cannot contain spaces or colons");
            }
            // User Hooks must use the user namespace; the editor asks only for the local name.
            draft.id = format!("user:hook:{value}");
        }
        Field::ToolNames => {
            if draft.event == HookEventDto::TurnCompleted && value != "-" {
                return Err("Turn-completed Hooks cannot match tools");
            }
            draft.matcher.tool_names = if value == "-" {
                Vec::new()
            } else {
                value
                    .split(',')
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .map(str::to_owned)
                    .collect()
            };
        }
        Field::Program => {
            let HookActionDto::Process { program, .. } = &mut draft.action;
            *program = value.to_owned();
        }
        Field::Arguments => {
            let parsed = serde_json::from_str::<Vec<String>>(value)
                .map_err(|_| "Enter a JSON array of strings")?;
            let HookActionDto::Process { args, .. } = &mut draft.action;
            *args = parsed;
        }
    }
    Ok(())
}

fn process_program(hook: &HookConfigDto) -> &str {
    match &hook.action {
        HookActionDto::Process { program, .. } => program,
    }
}

fn process_args(hook: &HookConfigDto) -> &[String] {
    match &hook.action {
        HookActionDto::Process { args, .. } => args,
    }
}

fn event_label(event: HookEventDto) -> &'static str {
    match event {
        HookEventDto::BeforeTool => "Before tool",
        HookEventDto::AfterTool => "After tool",
        HookEventDto::TurnCompleted => "Turn completed",
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
