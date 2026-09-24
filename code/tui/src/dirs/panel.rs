use super::AddedDir;
use super::DirAddTarget;
use super::DirChoices;
use super::DirSelectionAction;
use crate::keymap::bindings;
use crate::widgets::list_selection::ListSelection;
use crate::widgets::list_selection::ListSelectionOutcome;
use crate::widgets::list_selection::ListSelectionState;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use crossterm::event::KeyModifiers;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

static NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);

/// Owns directory input, submission feedback and focus after completion.
#[derive(Debug)]
pub(crate) struct DirPanel {
    selection: ListSelection<DirSelectionAction>,
    pending: Option<u64>,
    add_target: DirAddTarget,
    language: crate::nls::Language,
}

impl DirPanel {
    pub(crate) fn new(choices: DirChoices) -> Self {
        Self::for_target(choices, DirAddTarget::Session)
    }

    pub(crate) fn for_target(choices: DirChoices, add_target: DirAddTarget) -> Self {
        let mut selection = ListSelection::new(choices.model, choices.actions);
        if add_target == DirAddTarget::Project {
            selection.state_mut().focus_search();
        }
        Self {
            selection,
            pending: None,
            add_target,
            language: crate::nls::Language::English,
        }
    }

    pub(crate) fn state(&self) -> &ListSelectionState {
        self.selection.state()
    }

    pub(crate) fn localize(&mut self, language: crate::nls::Language) {
        self.language = language;
        self.selection.state_mut().localize(language);
    }

    pub(crate) fn selection_mut(&mut self) -> Option<&mut ListSelectionState> {
        self.pending.is_none().then(|| self.selection.state_mut())
    }

    pub(crate) fn replace(&mut self, mut choices: DirChoices) {
        choices.model.localize(self.language);
        self.selection.replace(choices.model, choices.actions);
    }

    pub(crate) fn key_hints(&self) -> &crate::widgets::key_hint::KeyHints {
        if self.pending.is_some() {
            return &bindings::CLOSE_HINTS;
        }
        if self.input_active() {
            &bindings::DIR_INPUT_HINTS
        } else if self.state().tabs_focused() {
            self.selection.key_hints()
        } else {
            &bindings::DIR_HINTS
        }
    }

    fn input_active(&self) -> bool {
        self.state()
            .search()
            .is_some_and(|input| input.input_active())
    }

    pub(crate) fn handle_key(&mut self, key: KeyEvent) -> ListSelectionOutcome<DirSelectionAction> {
        if self.pending.is_some() {
            return if key.kind == KeyEventKind::Press && bindings::DISMISS_LIST.matches(key) {
                ListSelectionOutcome::Dismiss
            } else {
                ListSelectionOutcome::Consumed
            };
        }
        if self.input_active() && key.kind == KeyEventKind::Press && bindings::ACCEPT.matches(key) {
            let path = self.state().query();
            if path.is_empty() {
                self.selection
                    .state_mut()
                    .set_message(Some("Enter a directory path".into()));
                return ListSelectionOutcome::Consumed;
            }
            let path = PathBuf::from(path);
            let request_id = NEXT_REQUEST.fetch_add(1, Ordering::Relaxed);
            self.pending = Some(request_id);
            self.selection
                .state_mut()
                .set_message(Some("Adding directory…".into()));
            return ListSelectionOutcome::Activate(DirSelectionAction::Add {
                request_id,
                path,
                target: self.add_target,
            });
        }
        self.selection.handle_key(key)
    }

    pub(crate) fn handle_paste(&mut self, pasted: String) {
        if self.pending.is_some() || !self.input_active() {
            return;
        }
        if pasted.chars().any(char::is_control) {
            self.selection.state_mut().set_message(Some(
                "Enter one directory path without control characters".into(),
            ));
            return;
        }
        // A path may contain repeated spaces; preserve its exact characters.
        for character in pasted.chars() {
            self.selection
                .handle_key(KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE));
        }
    }

    pub(crate) fn finish_add(&mut self, request_id: u64, result: Result<AddedDir, String>) {
        if self.pending != Some(request_id) {
            return;
        }
        self.pending = None;
        match result {
            Ok(added) => {
                let mut choices = added.choices;
                choices.model.localize(self.language);
                let target = choices.actions.iter().find_map(|(id, action)| {
                    matches!(action, DirSelectionAction::Remove { path } if *path == added.path)
                        .then(|| id.clone())
                });
                self.selection = ListSelection::new(choices.model, choices.actions);
                if let Some(target) = target {
                    self.selection.state_mut().focus_item(&target);
                    // Start at Read files, so another Enter cannot remove the directory.
                    self.selection.state_mut().select_visible_item(1);
                }
                let message = match (self.add_target, added.already_present) {
                    (DirAddTarget::Session, true) => "Directory already added",
                    (DirAddTarget::Session, false) => "Added directory",
                    (DirAddTarget::Project, true) => "Project folder already added",
                    (DirAddTarget::Project, false) => "Added project folder",
                };
                self.selection.state_mut().set_message(Some(format!(
                    "{}: {}",
                    crate::nls::localize(self.language, message),
                    added.path.display()
                )));
            }
            Err(error) => {
                self.selection.state_mut().focus_search();
                self.selection.state_mut().set_message(Some(error));
            }
        }
    }
}
