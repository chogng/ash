//! Browsing state owned separately by each terminal mode.

use super::Command;
use super::SessionsState;
use super::manager::SessionManagerPointerTarget;
use super::manager::SessionManagerState;
use crate::keymap::bindings;
use crate::thread::preview::ConversationPreview;
use crate::widgets::navigation::Navigation;
use ash_app_server_protocol::protocol::session::SessionThreadReadParams;
use ash_app_server_protocol::protocol::session::SessionThreadReadResult;
use ash_app_server_protocol::protocol::session::ThreadSnapshotHistory;
use ash_protocol::SessionId;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use std::time::Instant;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum SessionScreen {
    Manager,
    Session(SessionId),
}

/// The manager handles local interaction and returns work for the application to coordinate.
#[derive(Debug)]
pub(crate) enum SessionManagerInputOutcome {
    Unhandled,
    Consumed,
    Command(Command),
    ExitRequested,
    DetailsRequested,
}

/// Per-terminal-mode state and interaction for browsing sessions.
#[derive(Debug, Default)]
pub(crate) struct SessionNavigation {
    pub(crate) details: Option<super::details::SessionDetails>,
    details_generation: u64,
    pub(crate) preview: Option<ConversationPreview>,
    preview_generation: u64,
    screen: Option<SessionScreen>,
    manager: SessionManagerState,
}

impl SessionNavigation {
    pub(crate) fn activate_manager_pointer(
        &mut self,
        model: &SessionsState,
        target: &SessionManagerPointerTarget,
    ) -> SessionManagerInputOutcome {
        if !matches!(self.screen(), Some(SessionScreen::Manager))
            || !self.manager.focus_pointer(model.catalog(), target)
        {
            return SessionManagerInputOutcome::Unhandled;
        }
        self.handle_manager_key(
            model,
            KeyEvent::new(
                crossterm::event::KeyCode::Enter,
                crossterm::event::KeyModifiers::NONE,
            ),
        )
    }

    pub(crate) fn handle_manager_key(
        &mut self,
        model: &SessionsState,
        key: KeyEvent,
    ) -> SessionManagerInputOutcome {
        use SessionManagerInputOutcome as Outcome;

        if !matches!(self.screen(), Some(SessionScreen::Manager))
            || !self.manager.focused()
            || key.kind == KeyEventKind::Release
            || (key.kind == KeyEventKind::Repeat && Navigation::from_key(key).is_none())
        {
            return Outcome::Unhandled;
        }
        if let Some(navigation) = Navigation::from_key(key) {
            self.manager.navigate(model.catalog(), navigation);
            return Outcome::Consumed;
        }
        if (self.manager.selected_is_archived() && bindings::SESSION_DELETE.matches(key))
            || (!self.manager.selected_is_archived() && bindings::SESSION_ARCHIVE.matches(key))
        {
            let command = if self.manager.selected_is_archived() {
                self.manager
                    .selected_session()
                    .cloned()
                    .map(|session_id| Command::Delete { session_id })
            } else {
                let session_ids = self.manager.selected_archive_ids(model.catalog());
                (!session_ids.is_empty()).then_some(Command::Archive { session_ids })
            };
            return command.map_or(Outcome::Consumed, Outcome::Command);
        }
        if (self.manager.selected_group().is_some()
            && if self.manager.selected_group_expanded() {
                bindings::GROUP_COLLAPSE.matches(key)
            } else {
                bindings::GROUP_EXPAND.matches(key)
            })
            || (self.manager.selected_group().is_none()
                && if self.manager.selected_is_archived() {
                    bindings::SESSION_RESTORE.matches(key)
                } else {
                    bindings::SESSION_OPEN.matches(key)
                })
        {
            if self.manager.selected_group().is_some() {
                self.manager.toggle_selected_group();
                return Outcome::Consumed;
            }
            let command = self.manager.selected_session().map(|session_id| {
                if self.manager.selected_is_archived() {
                    Command::Restore {
                        session_id: session_id.clone(),
                    }
                } else {
                    Command::Resume {
                        session_id: session_id.to_string(),
                        preferred_thread_id: model.remembered_thread(session_id).cloned(),
                    }
                }
            });
            return command.map_or(Outcome::Consumed, Outcome::Command);
        }
        if bindings::SESSION_PREVIEW.matches(key) {
            if self.manager.selected_group().is_some() {
                self.manager.toggle_selected_group();
                return Outcome::Consumed;
            }
            let session_id = self.manager.selected_session().cloned();
            return session_id
                .and_then(|id| self.open_preview(model, &id))
                .map_or(Outcome::Consumed, Outcome::Command);
        }
        if bindings::SESSION_DETAILS.matches(key) {
            return Outcome::DetailsRequested;
        }
        if (bindings::LEFT.matches(key) || bindings::RIGHT.matches(key))
            && self.manager.selected_group().is_some()
        {
            if bindings::RIGHT.matches(key) {
                self.manager.expand_selected_group();
            } else {
                self.manager.collapse_selected_group();
            }
            return Outcome::Consumed;
        }
        if bindings::SESSION_PIN.matches(key) {
            self.manager.toggle_selected_pin();
            return Outcome::Consumed;
        }
        if bindings::RETURN_INPUT.matches(key) {
            return Outcome::ExitRequested;
        }
        Outcome::Unhandled
    }

    pub(crate) fn open_details(&mut self, model: &SessionsState) {
        let Some(session) = self.manager.selected_session().and_then(|id| {
            model
                .catalog()
                .iter()
                .find(|session| &session.session_id == id)
        }) else {
            return;
        };
        self.details_generation = self.details_generation.wrapping_add(1);
        self.details = Some(super::details::SessionDetails::new(
            session,
            self.details_generation,
        ));
    }

    pub(crate) fn finish_details(
        &mut self,
        generation: u64,
        result: Result<ash_app_server_protocol::protocol::session::SessionResult, String>,
    ) {
        if let Some(details) = self
            .details
            .as_mut()
            .filter(|details| details.generation == generation)
        {
            details.install(result);
        }
    }

    pub(crate) fn open_preview(
        &mut self,
        model: &SessionsState,
        session_id: &SessionId,
    ) -> Option<super::Command> {
        let session = model
            .catalog()
            .iter()
            .find(|session| &session.session_id == session_id)?;
        let thread = model
            .remembered_thread(session_id)
            .and_then(|id| {
                session
                    .threads
                    .iter()
                    .find(|thread| &thread.thread_id == id)
            })
            .or_else(|| {
                session
                    .threads
                    .iter()
                    .find(|thread| thread.thread_id.as_str() == session_id.as_str())
            })?;
        let params = SessionThreadReadParams {
            session_id: session_id.clone(),
            thread_id: thread.thread_id.clone(),
            history: Some(ThreadSnapshotHistory::Latest { turn_limit: 50 }),
        };
        self.preview_generation = self.preview_generation.wrapping_add(1);
        self.preview = Some(ConversationPreview::new(
            self.preview_generation,
            session.title.clone(),
            params.clone(),
        ));
        Some(super::Command::Preview {
            generation: self.preview_generation,
            params,
        })
    }

    pub(crate) fn finish_preview(
        &mut self,
        generation: u64,
        result: Result<SessionThreadReadResult, String>,
    ) {
        if let Some(preview) = self
            .preview
            .as_mut()
            .filter(|preview| preview.generation == generation)
        {
            preview.install(result);
        }
    }

    pub(crate) fn screen(&self) -> Option<&SessionScreen> {
        self.screen.as_ref()
    }

    pub(crate) fn show_manager(&mut self, model: &SessionsState) {
        self.preview = None;
        self.screen = Some(SessionScreen::Manager);
        self.manager.reconcile(model.catalog());
    }

    pub(crate) fn show_session(&mut self, session_id: SessionId) {
        self.preview = None;
        self.manager.blur();
        self.screen = Some(SessionScreen::Session(session_id));
    }

    pub(crate) fn manager(&self) -> &SessionManagerState {
        &self.manager
    }

    pub(crate) fn manager_mut(&mut self) -> &mut SessionManagerState {
        &mut self.manager
    }

    pub(crate) fn refresh_manager_time(&mut self, model: &SessionsState, now: Instant) -> bool {
        self.manager.refresh_time(now, model.catalog())
    }

    pub(crate) fn previous_screen(&self) -> Option<SessionScreen> {
        match self.screen()? {
            SessionScreen::Manager => None,
            SessionScreen::Session(_) => Some(SessionScreen::Manager),
        }
    }

    pub(crate) fn next_screen(&self, model: &SessionsState) -> Option<SessionScreen> {
        match self.screen()? {
            SessionScreen::Manager => model
                .active_session_id()
                .cloned()
                .map(SessionScreen::Session),
            SessionScreen::Session(_) => None,
        }
    }

    pub(crate) fn reconcile(&mut self, model: &SessionsState) {
        if let Some(details) = self.details.as_mut() {
            if model
                .catalog()
                .iter()
                .any(|session| session.session_id == details.session_id)
            {
                details.invalidate();
            } else {
                self.details = None;
            }
        }
        if self.preview.as_ref().is_some_and(|preview| {
            !model
                .catalog()
                .iter()
                .any(|session| &session.session_id == preview.session_id())
        }) {
            self.preview = None;
        }
        self.manager.reconcile(model.catalog());
        if let Some(SessionScreen::Session(session_id)) = self.screen.as_ref()
            && !model
                .catalog()
                .iter()
                .any(|session| &session.session_id == session_id)
        {
            self.screen = Some(SessionScreen::Manager);
        }
    }

    pub(crate) fn context_changed(&mut self, model: &SessionsState) {
        if self.screen.is_none() || matches!(self.screen, Some(SessionScreen::Session(_))) {
            self.screen = model
                .active_session_id()
                .cloned()
                .map(SessionScreen::Session);
        }
    }
}

#[cfg(test)]
#[path = "navigation_tests.rs"]
mod tests;
