//! Interactive shortcut selection, capture, and configuration commands.

mod settings;

use crate::keymap::KeymapActionSnapshot;
use crate::keymap::bindings;
use crate::keymap::compose_config_chord;
use crate::keymap::fixed_bindings;
use crate::keymap::key_event_to_config_key;
use crate::widgets::key_capture::KeyCapture;
use crate::widgets::list_selection::ListSelection;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::list_selection::ListSelectionOutcome;
use crate::widgets::list_selection::ListSelectionSpec;
use crate::widgets::search_box::SearchBoxModel;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
pub(crate) use settings::KeymapCaptureMode;
pub(crate) use settings::KeymapEdit;
pub(crate) use settings::KeymapEditIntent;
pub(crate) use settings::KeymapEditKind;
pub(crate) use settings::KeymapEditorUpdate;
pub(crate) use settings::KeymapSettings;
use settings::read_keymap;
pub(crate) use settings::set_keymap;
pub(crate) use settings::settings_from_tui;
use std::collections::BTreeMap;

/// A completed keymap operation delivered to the TUI state owner.
pub(crate) enum Event {
    SettingsReceived(KeymapSettings),
    EditorOpened(KeymapEditorUpdate),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Command {
    OpenEditor,
    Edit(KeymapEdit),
}

impl Command {
    pub(crate) const fn request_name(&self) -> &'static str {
        match self {
            Self::OpenEditor => "ash-tui-read-keymap",
            Self::Edit(_) => "ash-tui-set-keymap",
        }
    }
}

pub(crate) fn execute<T>(
    client: &mut ash_app_server_client::AppServerClient<T>,
    command: Command,
) -> Result<Event, String>
where
    T: ash_app_server_client::JsonRpcTransport,
{
    match command {
        Command::OpenEditor => read_keymap(client),
        Command::Edit(edit) => set_keymap(client, edit),
    }
    .map(Event::EditorOpened)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum KeymapAction {
    OpenAction {
        action: KeymapActionSnapshot,
        revision: u64,
    },
    BeginCapture {
        action: KeymapActionSnapshot,
        revision: u64,
        intent: KeymapEditIntent,
        mode: KeymapCaptureMode,
    },
    ClearUser {
        command_id: String,
        revision: u64,
    },
}

pub(crate) type KeymapChoices = ListSelectionSpec<KeymapAction>;

#[derive(Debug)]
pub(crate) struct KeymapEditor {
    pages: Vec<ListSelection<KeymapAction>>,
    capture: Option<KeymapCapturePage>,
}

#[derive(Debug)]
struct KeymapCapturePage {
    view: KeyCapture,
    key_hints: crate::widgets::key_hint::KeyHints,
    state: KeymapCaptureState,
}

#[derive(Debug)]
pub(crate) enum KeymapEditorOutcome {
    Edit(KeymapEdit),
    Consumed,
    Dismiss,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum KeymapEditorPage<'a> {
    Selection(&'a crate::widgets::list_selection::ListSelectionState),
    Capture(&'a KeyCapture),
}

impl KeymapEditor {
    pub(crate) fn new(spec: KeymapChoices) -> Self {
        Self {
            pages: vec![ListSelection::new(spec.model, spec.actions)],
            capture: None,
        }
    }

    pub(crate) fn replace_catalog(&mut self, spec: KeymapChoices) {
        self.pages = vec![ListSelection::new(spec.model, spec.actions)];
        self.capture = None;
    }

    pub(crate) fn handle_key(&mut self, key: KeyEvent) -> KeymapEditorOutcome {
        if let Some(capture) = self.capture.as_mut() {
            return match capture.state.handle_key(key) {
                KeymapCaptureOutcome::Pending => {
                    let (view, key_hints) = capture.state.presentation();
                    capture.view = view;
                    capture.key_hints = key_hints;
                    KeymapEditorOutcome::Consumed
                }
                KeymapCaptureOutcome::Cancelled => {
                    self.capture = None;
                    KeymapEditorOutcome::Consumed
                }
                KeymapCaptureOutcome::Edit(edit) => KeymapEditorOutcome::Edit(edit),
            };
        }
        let outcome = self
            .pages
            .last_mut()
            .expect("a keymap editor always has a selection page")
            .handle_key(key);
        self.apply_selection_outcome(outcome)
    }

    pub(crate) fn page(&self) -> KeymapEditorPage<'_> {
        match &self.capture {
            Some(capture) => KeymapEditorPage::Capture(&capture.view),
            None => KeymapEditorPage::Selection(
                self.pages
                    .last()
                    .expect("a keymap editor always has a selection page")
                    .state(),
            ),
        }
    }

    pub(crate) fn handle_paste(&mut self, pasted: String) {
        if self.capture.is_none()
            && let Some(page) = self.pages.last_mut()
        {
            page.handle_paste(pasted);
        }
    }

    pub(crate) fn key_hints(&self) -> &crate::widgets::key_hint::KeyHints {
        self.capture
            .as_ref()
            .map(|capture| &capture.key_hints)
            .unwrap_or_else(|| {
                self.pages
                    .last()
                    .expect("a keymap editor always has a selection page")
                    .key_hints()
            })
    }

    pub(crate) fn selection(&self) -> Option<&crate::widgets::list_selection::ListSelectionState> {
        self.capture.is_none().then(|| {
            self.pages
                .last()
                .expect("a keymap editor always has a selection page")
                .state()
        })
    }

    pub(crate) fn selection_mut(
        &mut self,
    ) -> Option<&mut crate::widgets::list_selection::ListSelectionState> {
        self.capture.is_none().then(|| {
            self.pages
                .last_mut()
                .expect("a keymap editor always has a selection page")
                .state_mut()
        })
    }

    fn apply_selection_outcome(
        &mut self,
        outcome: ListSelectionOutcome<KeymapAction>,
    ) -> KeymapEditorOutcome {
        match outcome {
            ListSelectionOutcome::Activate(KeymapAction::OpenAction { action, revision }) => {
                let spec = keymap_action_menu(action, revision);
                self.pages
                    .push(ListSelection::new(spec.model, spec.actions));
                KeymapEditorOutcome::Consumed
            }
            ListSelectionOutcome::Activate(KeymapAction::BeginCapture {
                action,
                revision,
                intent,
                mode,
            }) => {
                let state = keymap_capture(action, revision, intent, mode);
                let (view, key_hints) = state.presentation();
                self.capture = Some(KeymapCapturePage {
                    view,
                    key_hints,
                    state,
                });
                KeymapEditorOutcome::Consumed
            }
            ListSelectionOutcome::Activate(KeymapAction::ClearUser {
                command_id,
                revision,
            }) => KeymapEditorOutcome::Edit(KeymapEdit {
                expected_revision: revision,
                command_id,
                kind: KeymapEditKind::ClearUser,
            }),
            ListSelectionOutcome::Adjust(_, _)
            | ListSelectionOutcome::Consumed
            | ListSelectionOutcome::FocusPrevious => KeymapEditorOutcome::Consumed,
            ListSelectionOutcome::Dismiss if self.pages.len() > 1 => {
                self.pages.pop();
                KeymapEditorOutcome::Consumed
            }
            ListSelectionOutcome::Dismiss => KeymapEditorOutcome::Dismiss,
        }
    }
}

pub(crate) fn keymap_choices(
    actions: Vec<KeymapActionSnapshot>,
    diagnostics: &[String],
    revision: u64,
) -> KeymapChoices {
    let mut item_actions = BTreeMap::new();
    let mut all_items = Vec::new();
    let mut user_items = Vec::new();
    for action in actions {
        append_action_items(
            &mut all_items,
            action.clone(),
            revision,
            true,
            true,
            &mut item_actions,
        );
        append_action_items(
            &mut user_items,
            action,
            revision,
            false,
            true,
            &mut item_actions,
        );
    }
    all_items.extend(fixed_binding_items());
    let user_items = non_empty(user_items, "No user shortcuts");
    let diagnostic_items = non_empty(
        diagnostics
            .iter()
            .map(|diagnostic| ListSelectionItem::new(diagnostic))
            .collect(),
        "No keymap diagnostics",
    );
    KeymapChoices {
        model: ListSelectionModel::new(
            "Keymap",
            vec![
                ListSelectionGroup::new("All", all_items),
                ListSelectionGroup::new("User", user_items),
                ListSelectionGroup::new("Diagnostics", diagnostic_items),
            ],
        )
        .with_activation(bindings::KEYMAP_EDIT)
        .with_search(SearchBoxModel::new("Search shortcuts"))
        .with_empty_message("No matching shortcuts"),
        actions: item_actions,
    }
}

pub(crate) fn keymap_action_menu(action: KeymapActionSnapshot, revision: u64) -> KeymapChoices {
    let mut actions = BTreeMap::new();
    let mut items = Vec::new();
    push_action(
        &mut items,
        &mut actions,
        "Replace user shortcut with a key",
        KeymapAction::BeginCapture {
            action: action.clone(),
            revision,
            intent: KeymapEditIntent::ReplaceUser,
            mode: KeymapCaptureMode::SingleKey,
        },
    );
    push_action(
        &mut items,
        &mut actions,
        "Replace user shortcut with a chord",
        KeymapAction::BeginCapture {
            action: action.clone(),
            revision,
            intent: KeymapEditIntent::ReplaceUser,
            mode: KeymapCaptureMode::Chord,
        },
    );
    push_action(
        &mut items,
        &mut actions,
        "Add an alternate key",
        KeymapAction::BeginCapture {
            action: action.clone(),
            revision,
            intent: KeymapEditIntent::AddAlternate,
            mode: KeymapCaptureMode::SingleKey,
        },
    );
    push_action(
        &mut items,
        &mut actions,
        "Add an alternate chord",
        KeymapAction::BeginCapture {
            action: action.clone(),
            revision,
            intent: KeymapEditIntent::AddAlternate,
            mode: KeymapCaptureMode::Chord,
        },
    );
    if !action.user_bindings.is_empty() {
        push_action(
            &mut items,
            &mut actions,
            "Clear user shortcuts",
            KeymapAction::ClearUser {
                command_id: action.command_id.to_owned(),
                revision,
            },
        );
    }
    let summary = binding_summary(&action);
    KeymapChoices {
        model: ListSelectionModel::new(
            action.label,
            vec![ListSelectionGroup::new("Actions", items)],
        )
        .with_activation(bindings::KEYMAP_CHOOSE)
        .with_dismiss(bindings::RETURN_LIST)
        .with_key_hint_note(summary)
        .without_tab_bar(),
        actions,
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct KeymapCaptureState {
    action: KeymapActionSnapshot,
    revision: u64,
    intent: KeymapEditIntent,
    mode: KeymapCaptureMode,
    first_stroke: Option<String>,
    error: Option<String>,
}

#[derive(Debug)]
pub(crate) enum KeymapCaptureOutcome {
    Pending,
    Cancelled,
    Edit(KeymapEdit),
}

pub(crate) fn keymap_capture(
    action: KeymapActionSnapshot,
    revision: u64,
    intent: KeymapEditIntent,
    mode: KeymapCaptureMode,
) -> KeymapCaptureState {
    KeymapCaptureState {
        action,
        revision,
        intent,
        mode,
        first_stroke: None,
        error: None,
    }
}

impl KeymapCaptureState {
    pub(crate) fn handle_key(&mut self, key: KeyEvent) -> KeymapCaptureOutcome {
        if key.kind != KeyEventKind::Press {
            return KeymapCaptureOutcome::Pending;
        }
        if is_cancel(key) {
            return KeymapCaptureOutcome::Cancelled;
        }
        let stroke = match key_event_to_config_key(&key) {
            Ok(stroke) => stroke,
            Err(error) => {
                self.error = Some(error);
                return KeymapCaptureOutcome::Pending;
            }
        };
        self.error = None;
        let key = match self.mode {
            KeymapCaptureMode::SingleKey => stroke,
            KeymapCaptureMode::Chord => match self.first_stroke.take() {
                None => {
                    self.first_stroke = Some(stroke);
                    return KeymapCaptureOutcome::Pending;
                }
                Some(first) => match compose_config_chord(&first, &stroke) {
                    Ok(chord) => chord,
                    Err(error) => {
                        self.error = Some(error);
                        return KeymapCaptureOutcome::Pending;
                    }
                },
            },
        };
        KeymapCaptureOutcome::Edit(KeymapEdit {
            expected_revision: self.revision,
            command_id: self.action.command_id.to_owned(),
            kind: KeymapEditKind::Set {
                key,
                intent: self.intent,
            },
        })
    }

    fn presentation(&self) -> (KeyCapture, crate::widgets::key_hint::KeyHints) {
        let instruction = match (self.mode, self.first_stroke.as_deref()) {
            (KeymapCaptureMode::SingleKey, _) => {
                "Press the new key now. Esc or Ctrl-C cancels.".to_owned()
            }
            (KeymapCaptureMode::Chord, None) => {
                "Press the first key, then the second. Esc or Ctrl-C cancels.".to_owned()
            }
            (KeymapCaptureMode::Chord, Some(first)) => {
                format!("First key: {first}. Press the second key. Esc or Ctrl-C cancels.")
            }
        };
        let mut lines = vec![instruction];
        if let Some(error) = &self.error {
            lines.push(format!("Error: {error}"));
        }
        (
            KeyCapture::new("Record shortcut", lines),
            crate::widgets::key_hint::KeyHints::new()
                .with_binding(bindings::CANCEL)
                .with_note(format!(
                    "{}  ·  {}",
                    self.action.label,
                    binding_summary(&self.action)
                )),
        )
    }
}

fn append_action_items(
    items: &mut Vec<ListSelectionItem>,
    action: KeymapActionSnapshot,
    revision: u64,
    include_default: bool,
    include_user: bool,
    actions: &mut BTreeMap<ListSelectionItemId, KeymapAction>,
) {
    let default_bindings = if action.default_bindings.is_empty() {
        vec!["unbound".to_owned()]
    } else {
        action.default_bindings.clone()
    };
    if include_default {
        for (index, binding) in default_bindings.into_iter().enumerate() {
            push_action_item(
                items,
                actions,
                &action,
                revision,
                binding,
                action.label.to_owned(),
                "default",
                format!("default-{index}"),
            );
        }
    }
    if include_user {
        for (index, binding) in action.user_bindings.iter().enumerate() {
            let responsibility = match &binding.when {
                Some(condition) => format!("{}  when {condition}", action.label),
                None => action.label.to_owned(),
            };
            push_action_item(
                items,
                actions,
                &action,
                revision,
                binding.key.clone(),
                responsibility,
                "user",
                format!("user-{index}"),
            );
        }
    }
}

fn push_action_item(
    items: &mut Vec<ListSelectionItem>,
    actions: &mut BTreeMap<ListSelectionItemId, KeymapAction>,
    action: &KeymapActionSnapshot,
    revision: u64,
    key: String,
    responsibility: String,
    source: &'static str,
    suffix: String,
) {
    let item_id = ListSelectionItemId::new(format!("{}-{suffix}", action.command_id));
    items.push(
        ListSelectionItem::new(&key)
            .with_id(item_id.clone())
            .with_columns(key, responsibility, source),
    );
    actions.insert(
        item_id,
        KeymapAction::OpenAction {
            action: action.clone(),
            revision,
        },
    );
}

fn binding_summary(action: &KeymapActionSnapshot) -> String {
    let defaults = if action.default_bindings.is_empty() {
        "unbound".to_owned()
    } else {
        action.default_bindings.join(", ")
    };
    if action.user_bindings.is_empty() {
        return format!("default: {defaults}");
    }
    let user = action
        .user_bindings
        .iter()
        .map(|binding| match &binding.when {
            Some(condition) => format!("{} when {condition}", binding.key),
            None => binding.key.clone(),
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!("default: {defaults}  ·  user: {user}")
}

fn push_action(
    items: &mut Vec<ListSelectionItem>,
    actions: &mut BTreeMap<ListSelectionItemId, KeymapAction>,
    label: &str,
    action: KeymapAction,
) {
    let item_id = ListSelectionItemId::new(format!("keymap-action-{}", items.len()));
    items.push(ListSelectionItem::new(label).with_id(item_id.clone()));
    actions.insert(item_id, action);
}

fn non_empty(items: Vec<ListSelectionItem>, label: &str) -> Vec<ListSelectionItem> {
    if items.is_empty() {
        vec![ListSelectionItem::new(label)]
    } else {
        items
    }
}

fn fixed_binding_items() -> impl Iterator<Item = ListSelectionItem> {
    fixed_bindings().map(|(key, description)| {
        ListSelectionItem::new(key).with_columns(key, description, "default")
    })
}

fn is_cancel(key: KeyEvent) -> bool {
    bindings::CANCEL.matches(key)
}

#[cfg(test)]
#[path = "keymap_setup/editor_tests.rs"]
mod tests;
