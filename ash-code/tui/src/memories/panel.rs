use super::Command;
use super::Editor;
use super::Page;
use super::editor::Field;
use crate::keymap::bindings;
use crate::widgets::list_selection::ListSelection;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::list_selection::ListSelectionOutcome;
use crate::widgets::list_selection::ListSelectionState;
use crate::widgets::search_box::SearchBoxModel;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use crossterm::event::KeyModifiers;
use memories::Memory;
use memories::MemoryScope;
use std::collections::BTreeMap;

#[derive(Clone, Debug)]
enum Action {
    Command(Command),
    Add(MemoryScope),
    Edit(Memory),
    Delete(Memory),
    Search(MemoryScope),
    Reference,
}

#[derive(Debug)]
struct Draft {
    command_id: ash_protocol::CommandId,
    scope: MemoryScope,
    memory: Option<Memory>,
    title: String,
}

#[derive(Debug)]
pub(crate) struct Panel {
    selection: ListSelection<Action>,
    editor: Option<Editor>,
    draft: Option<Draft>,
    pending: bool,
    language: crate::nls::Language,
}

impl Panel {
    pub(crate) fn new(page: Page) -> Self {
        let mut rows = Vec::new();
        match page {
            Page::Scopes(scopes) => {
                for scope in scopes {
                    rows.push((
                        scope.label,
                        format!(
                            "Reading: {} · Model saving: {}",
                            if scope.policy.automatic_read == memories::MemoryReadMode::Disabled {
                                "off"
                            } else {
                                "on"
                            },
                            if scope.policy.model_write == memories::MemoryWriteMode::Disabled {
                                "off"
                            } else {
                                "on"
                            }
                        ),
                        Some(Action::Command(Command::Browse {
                            scope: scope.policy.scope,
                            cursor: None,
                        })),
                    ));
                }
                rows.push((
                    "Open memory reference".into(),
                    "Paste an exact memory: reference".into(),
                    Some(Action::Reference),
                ));
            }
            Page::List {
                policy,
                entries,
                cursor,
            } => {
                rows.push((
                    "Add memory".into(),
                    "Save a preference or reusable decision".into(),
                    Some(Action::Add(policy.scope.clone())),
                ));
                rows.push((
                    "Search all memories in this scope".into(),
                    String::new(),
                    Some(Action::Search(policy.scope.clone())),
                ));
                let mut read = policy.clone();
                read.automatic_read = match read.automatic_read {
                    memories::MemoryReadMode::Disabled => memories::MemoryReadMode::FirstInvocation,
                    memories::MemoryReadMode::FirstInvocation => memories::MemoryReadMode::Disabled,
                };
                rows.push((
                    format!(
                        "{} memory reading",
                        if read.automatic_read == memories::MemoryReadMode::Disabled {
                            "Disable"
                        } else {
                            "Enable"
                        }
                    ),
                    "Controls automatic recall and model searches".into(),
                    Some(Action::Command(Command::Policy(read))),
                ));
                let mut write = policy.clone();
                write.model_write = match write.model_write {
                    memories::MemoryWriteMode::Disabled => memories::MemoryWriteMode::Enabled,
                    memories::MemoryWriteMode::Enabled => memories::MemoryWriteMode::Disabled,
                };
                rows.push((
                    format!(
                        "{} model saving",
                        if write.model_write == memories::MemoryWriteMode::Disabled {
                            "Disable"
                        } else {
                            "Enable"
                        }
                    ),
                    "Save durable facts in this scope".into(),
                    Some(Action::Command(Command::Policy(write))),
                ));
                for entry in entries {
                    rows.push((
                        entry.title,
                        format!(
                            "Revision {} · {}",
                            entry.revision,
                            if entry.source == memories::MemorySource::User {
                                "User"
                            } else {
                                "Model"
                            }
                        ),
                        Some(Action::Command(Command::Read {
                            scope: entry.scope,
                            id: entry.memory_id,
                        })),
                    ));
                }
                if let Some(cursor) = cursor {
                    rows.push((
                        "Next page".into(),
                        String::new(),
                        Some(Action::Command(Command::Browse {
                            scope: policy.scope,
                            cursor: Some(cursor),
                        })),
                    ));
                }
                rows.push((
                    "Back to scopes".into(),
                    String::new(),
                    Some(Action::Command(Command::Scopes)),
                ));
            }
            Page::Read(memory) => {
                let reference = memories::MemoryCitation {
                    memory_id: memory.memory_id.clone(),
                    scope: memory.scope.clone(),
                    revision: memory.revision,
                    start_byte: 0,
                    end_byte: memory.body.len() as u32,
                }
                .reference()
                .expect("stored memory citation");
                rows.push((
                    "View full content".into(),
                    memory.title.clone(),
                    Some(Action::Command(Command::Citation(reference))),
                ));
                rows.push((
                    "Edit memory".into(),
                    format!(
                        "Revision {} · Editing takes user ownership",
                        memory.revision
                    ),
                    Some(Action::Edit(memory.clone())),
                ));
                rows.push((
                    "Delete memory".into(),
                    String::new(),
                    Some(Action::Delete(memory.clone())),
                ));
                rows.push((
                    "Back to list".into(),
                    String::new(),
                    Some(Action::Command(Command::Browse {
                        scope: memory.scope.clone(),
                        cursor: None,
                    })),
                ));
                rows.push((memory.title, memory.body, None));
            }
            Page::Citation(entry) => {
                rows.push((entry.title, entry.body, None));
                rows.push((
                    "Back to scopes".into(),
                    String::new(),
                    Some(Action::Command(Command::Scopes)),
                ));
            }
        }
        Self {
            selection: selection(rows),
            editor: None,
            draft: None,
            pending: false,
            language: crate::nls::Language::English,
        }
    }
    pub(crate) fn localize(&mut self, language: crate::nls::Language) {
        self.language = language;
        self.selection.state_mut().localize(language);
    }
    pub(crate) fn selection(&self) -> Option<&ListSelectionState> {
        self.editor.is_none().then(|| self.selection.state())
    }
    pub(crate) fn selection_mut(&mut self) -> Option<&mut ListSelectionState> {
        self.editor.is_none().then(|| self.selection.state_mut())
    }
    pub(crate) fn editor(&self) -> Option<&Editor> {
        self.editor.as_ref()
    }
    pub(crate) fn key_hints(&self) -> &crate::widgets::key_hint::KeyHints {
        if self.editor.is_some() {
            &bindings::CLOSE_HINTS
        } else {
            self.selection.key_hints()
        }
    }
    pub(crate) fn paste(&mut self, value: String) {
        if self.pending {
            return;
        }
        if let Some(editor) = &mut self.editor {
            editor.paste(value);
        } else {
            self.selection.handle_paste(value);
        }
    }
    pub(crate) fn fail(&mut self, message: String) {
        self.pending = false;
        self.notice(message);
    }
    pub(crate) fn notice(&mut self, message: String) {
        if let Some(editor) = &mut self.editor {
            editor.message = Some(message);
        } else {
            self.selection.state_mut().set_message(Some(message));
        }
    }
    pub(crate) fn handle_key(&mut self, key: KeyEvent) -> ListSelectionOutcome<Command> {
        if key.kind != KeyEventKind::Press {
            return ListSelectionOutcome::Consumed;
        }
        if self.pending {
            return if key.code == KeyCode::Esc {
                ListSelectionOutcome::Dismiss
            } else {
                ListSelectionOutcome::Consumed
            };
        }
        if let Some(editor) = &mut self.editor {
            if key.code == KeyCode::Esc {
                self.editor = None;
                self.draft = None;
                return ListSelectionOutcome::Consumed;
            }
            if key.modifiers == KeyModifiers::CONTROL && key.code == KeyCode::Char('s') {
                if editor.text().trim().is_empty() {
                    return ListSelectionOutcome::Consumed;
                }
                let text = editor.text().to_owned();
                let field = editor.field;
                match field {
                    Field::Title => {
                        let draft = self.draft.as_mut().expect("title draft");
                        draft.title = text;
                        self.editor = Some(Editor::new(
                            Field::Body,
                            draft
                                .memory
                                .as_ref()
                                .map_or(String::new(), |memory| memory.body.clone()),
                        ));
                    }
                    Field::Body => {
                        let draft = self.draft.as_ref().expect("body draft");
                        self.pending = true;
                        return ListSelectionOutcome::Activate(match draft.memory.clone() {
                            Some(memory) => Command::Update {
                                command_id: draft.command_id.clone(),
                                memory,
                                title: draft.title.clone(),
                                body: text,
                            },
                            None => Command::Add {
                                command_id: draft.command_id.clone(),
                                scope: draft.scope.clone(),
                                title: draft.title.clone(),
                                body: text,
                            },
                        });
                    }
                    Field::Query => {
                        let draft = self.draft.take().expect("search scope");
                        self.editor = None;
                        return ListSelectionOutcome::Activate(Command::Search {
                            scope: draft.scope,
                            query: text,
                        });
                    }
                    Field::Reference => {
                        self.editor = None;
                        return ListSelectionOutcome::Activate(Command::Citation(text));
                    }
                }
            } else {
                editor.handle_key(key);
            }
            return ListSelectionOutcome::Consumed;
        }
        match self.selection.handle_key(key) {
            ListSelectionOutcome::Activate(action) => match action {
                Action::Command(command) => ListSelectionOutcome::Activate(command),
                Action::Reference => {
                    self.editor = Some(Editor::new(Field::Reference, String::new()));
                    ListSelectionOutcome::Consumed
                }
                Action::Search(scope) => {
                    self.draft = Some(Draft {
                        command_id: crate::client::new_command_id("memory-save"),
                        scope,
                        memory: None,
                        title: String::new(),
                    });
                    self.editor = Some(Editor::new(Field::Query, String::new()));
                    ListSelectionOutcome::Consumed
                }
                Action::Add(scope) => {
                    let field = Field::Title;
                    self.draft = Some(Draft {
                        command_id: crate::client::new_command_id("memory-save"),
                        scope,
                        memory: None,
                        title: String::new(),
                    });
                    self.editor = Some(Editor::new(field, String::new()));
                    ListSelectionOutcome::Consumed
                }
                Action::Edit(memory) => {
                    self.editor = Some(Editor::new(Field::Title, memory.title.clone()));
                    self.draft = Some(Draft {
                        command_id: crate::client::new_command_id("memory-save"),
                        scope: memory.scope.clone(),
                        title: memory.title.clone(),
                        memory: Some(memory),
                    });
                    ListSelectionOutcome::Consumed
                }
                Action::Delete(memory) => {
                    self.selection = selection(vec![
                        (
                            "Cancel".into(),
                            String::new(),
                            Some(Action::Command(Command::Read {
                                scope: memory.scope.clone(),
                                id: memory.memory_id.clone(),
                            })),
                        ),
                        (
                            "Delete this memory".into(),
                            memory.title.clone(),
                            Some(Action::Command(Command::Delete {
                                command_id: crate::client::new_command_id("memory-delete"),
                                memory,
                            })),
                        ),
                    ]);
                    self.selection.state_mut().localize(self.language);
                    ListSelectionOutcome::Consumed
                }
            },
            ListSelectionOutcome::Dismiss => ListSelectionOutcome::Dismiss,
            _ => ListSelectionOutcome::Consumed,
        }
    }
}

fn selection(rows: Vec<(String, String, Option<Action>)>) -> ListSelection<Action> {
    let mut actions = BTreeMap::new();
    let items = rows
        .into_iter()
        .enumerate()
        .map(|(index, (title, description, action))| {
            let id = ListSelectionItemId::new(format!("memory-{index}"));
            if let Some(action) = action {
                actions.insert(id.clone(), action);
            }
            let item = ListSelectionItem::new(title).with_id(id);
            if description.is_empty() {
                item
            } else {
                item.with_description(description)
            }
        })
        .collect();
    ListSelection::new(
        ListSelectionModel::new("Memories", vec![ListSelectionGroup::new("", items)])
            .without_tab_bar()
            .with_search(SearchBoxModel::new("Filter memories and actions")),
        actions,
    )
}
