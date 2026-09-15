//! Shared session catalogue, active identity and new-session submission state.

use ash_protocol::Session;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::ThreadStatus;
use std::collections::BTreeMap;

#[derive(Debug)]
pub(crate) struct SessionsState {
    pub(crate) input: crate::thread::composer::ChatInput,
    pub(crate) pending_submission: Option<crate::thread::composer::QueuedChatInput>,
    pub(crate) creation_error: Option<String>,
    active_session_id: Option<SessionId>,
    catalog: Vec<Session>,
    last_viewed_thread: BTreeMap<SessionId, ThreadId>,
}

impl Default for SessionsState {
    fn default() -> Self {
        Self::new(crate::thread::composer::ChatInputCatalog::default())
    }
}

impl SessionsState {
    pub(crate) fn new(catalog: crate::thread::composer::ChatInputCatalog) -> Self {
        Self {
            input: crate::thread::composer::ChatInput::with_catalog(catalog),
            pending_submission: None,
            creation_error: None,
            active_session_id: None,
            catalog: Vec::new(),
            last_viewed_thread: BTreeMap::new(),
        }
    }

    #[cfg(test)]
    pub(crate) fn install_catalog(
        &mut self,
        catalog: Vec<Session>,
        active_session_id: SessionId,
        viewed_thread_id: ThreadId,
    ) {
        self.last_viewed_thread
            .insert(active_session_id.clone(), viewed_thread_id);
        self.active_session_id = Some(active_session_id.clone());
        self.catalog = catalog;
    }

    pub(crate) fn refresh_catalog(&mut self, catalog: Vec<Session>) {
        self.catalog = catalog;
        if self.active_session_id.as_ref().is_some_and(|session_id| {
            !self
                .catalog
                .iter()
                .any(|session| &session.session_id == session_id)
        }) {
            self.active_session_id = None;
        }
    }

    pub(crate) fn activate_context(&mut self, session_id: SessionId, thread_id: ThreadId) {
        self.last_viewed_thread
            .insert(session_id.clone(), thread_id);
        self.active_session_id = Some(session_id);
    }

    #[cfg(test)]
    pub(crate) fn remember_viewed_thread(&mut self, session_id: SessionId, thread_id: ThreadId) {
        self.last_viewed_thread.insert(session_id, thread_id);
    }

    pub(crate) fn remembered_thread(&self, session_id: &SessionId) -> Option<&ThreadId> {
        self.last_viewed_thread.get(session_id)
    }

    pub(crate) fn active_session_id(&self) -> Option<&SessionId> {
        self.active_session_id.as_ref()
    }

    pub(crate) fn restorable_thread(&self, session_id: &SessionId) -> Option<ThreadId> {
        let session = self
            .catalog
            .iter()
            .find(|session| &session.session_id == session_id)?;
        self.remembered_thread(session_id)
            .filter(|remembered| {
                session.threads.iter().any(|thread| {
                    &thread.thread_id == *remembered
                        && thread.status == ThreadStatus::Active
                        && thread.forked_from_id.is_none()
                })
            })
            .cloned()
            .or_else(|| {
                session
                    .threads
                    .iter()
                    .find(|thread| {
                        thread.thread_id.as_str() == session.session_id.as_str()
                            && thread.status == ThreadStatus::Active
                    })
                    .or_else(|| {
                        session.threads.iter().find(|thread| {
                            thread.status == ThreadStatus::Active && thread.forked_from_id.is_none()
                        })
                    })
                    .map(|thread| thread.thread_id.clone())
            })
    }

    pub(crate) fn catalog(&self) -> &[Session] {
        &self.catalog
    }
}

#[cfg(test)]
#[path = "state_tests.rs"]
mod tests;
