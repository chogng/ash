use super::plan::PlanState;
use crate::thread::composer::ChatInput;
use crate::thread::composer::ChatInputCatalog;
use crate::thread::composer::ChatInputDraft;
use crate::thread::composer::ChatInputMode;
use crate::thread::composer::SlashCommandCatalog;
use crate::thread::queue::Queue;
use ash_protocol::ThreadGoal;
use ash_protocol::ThreadId;
use std::collections::BTreeMap;
use std::collections::VecDeque;

const MAX_THREAD_PRESENTATIONS: usize = 32;

#[derive(Debug)]
pub(crate) struct ThreadPresentationState {
    pub(crate) input: ChatInput,
    pub(crate) status_timer: super::status_indicator::StatusTimer,
    pub(crate) goal: Option<ThreadGoal>,
    pub(crate) plan: PlanState,
    pub(crate) queue: Queue,
}

impl Default for ThreadPresentationState {
    fn default() -> Self {
        Self::with_input_catalog(ChatInputCatalog::default())
    }
}

impl ThreadPresentationState {
    fn with_input_catalog(catalog: ChatInputCatalog) -> Self {
        Self {
            input: ChatInput::with_catalog(catalog),
            status_timer: super::status_indicator::StatusTimer::default(),
            goal: None,
            plan: PlanState::default(),
            queue: Queue::default(),
        }
    }
}

#[derive(Debug)]
pub(crate) struct ThreadPresentationStore {
    active: ThreadId,
    input_mode: ChatInputMode,
    input_catalog: ChatInputCatalog,
    states: BTreeMap<ThreadId, ThreadPresentationState>,
    recent: VecDeque<ThreadId>,
    history: Option<message_history::MessageHistory>,
    history_error: Option<String>,
}

impl ThreadPresentationStore {
    pub(crate) fn recovery_drafts(&self) -> BTreeMap<ThreadId, ChatInputDraft> {
        self.states
            .iter()
            .map(|(thread, state)| (thread.clone(), state.input.recovery_draft()))
            .collect()
    }

    pub(crate) fn restore_recovery_drafts(&mut self, drafts: BTreeMap<ThreadId, ChatInputDraft>) {
        for (thread, draft) in drafts {
            let catalog = self.input_catalog.clone();
            let state = self
                .states
                .entry(thread.clone())
                .or_insert_with(|| ThreadPresentationState::with_input_catalog(catalog));
            state.input.set_input_mode(self.input_mode);
            if let Some(history) = &self.history {
                state
                    .input
                    .connect_history(history.clone(), thread.to_string());
            }
            if let Some(error) = &self.history_error {
                state.input.history_unavailable(error.clone());
            }
            state.input.restore_recovery_draft(draft);
            self.touch(thread);
        }
        self.evict_inactive();
    }

    pub(crate) fn active_id(&self) -> &ThreadId {
        &self.active
    }

    #[cfg(test)]
    pub(crate) fn new(active: ThreadId) -> Self {
        Self::with_input_catalog(active, ChatInputCatalog::default())
    }

    pub(crate) fn with_input_catalog(active: ThreadId, input_catalog: ChatInputCatalog) -> Self {
        let mut states = BTreeMap::new();
        states.insert(
            active.clone(),
            ThreadPresentationState::with_input_catalog(input_catalog.clone()),
        );
        Self {
            active: active.clone(),
            input_mode: ChatInputMode::Standard,
            input_catalog,
            states,
            recent: VecDeque::from([active]),
            history: None,
            history_error: None,
        }
    }

    pub(crate) fn switch(&mut self, thread_id: ThreadId) {
        let input_catalog = self.input_catalog.clone();
        self.states
            .entry(thread_id.clone())
            .or_insert_with(|| ThreadPresentationState::with_input_catalog(input_catalog))
            .input
            .set_input_mode(self.input_mode);
        if let Some(history) = &self.history {
            self.states
                .get_mut(&thread_id)
                .unwrap()
                .input
                .connect_history(history.clone(), thread_id.to_string());
        }
        if let Some(error) = &self.history_error {
            self.states
                .get_mut(&thread_id)
                .unwrap()
                .input
                .history_unavailable(error.clone());
        }
        self.active = thread_id.clone();
        self.touch(thread_id);
        self.evict_inactive();
    }

    pub(crate) fn connect_history(&mut self, client: message_history::MessageHistory) {
        for (thread_id, state) in &mut self.states {
            state
                .input
                .connect_history(client.clone(), thread_id.to_string());
        }
        self.history = Some(client);
    }

    pub(crate) fn history_unavailable(&mut self, error: String) {
        for state in self.states.values_mut() {
            state.input.history_unavailable(error.clone());
        }
        self.history_error = Some(error);
    }

    pub(crate) fn poll_history(&mut self) -> bool {
        let mut changed = false;
        for state in self.states.values_mut() {
            changed |= state.input.poll_history();
        }
        changed
    }

    pub(crate) fn replace_input_catalog(&mut self, input_catalog: ChatInputCatalog) {
        self.input_catalog = input_catalog.clone();
        for state in self.states.values_mut() {
            state.input.replace_catalog(input_catalog.clone());
        }
    }

    pub(crate) fn slash_commands(&self) -> &SlashCommandCatalog {
        self.input_catalog.slash_commands()
    }

    pub(crate) fn set_input_mode(&mut self, input_mode: ChatInputMode) {
        self.input_mode = input_mode;
        for state in self.states.values_mut() {
            state.input.set_input_mode(input_mode);
        }
    }

    pub(crate) fn active(&self) -> &ThreadPresentationState {
        self.states
            .get(&self.active)
            .expect("the active Thread presentation state exists")
    }

    pub(crate) fn active_mut(&mut self) -> &mut ThreadPresentationState {
        self.states
            .get_mut(&self.active)
            .expect("the active Thread presentation state exists")
    }

    pub(crate) fn input_mut(&mut self, thread_id: &ThreadId) -> Option<&mut ChatInput> {
        self.states.get_mut(thread_id).map(|state| &mut state.input)
    }

    fn touch(&mut self, thread_id: ThreadId) {
        self.recent.retain(|recent| recent != &thread_id);
        self.recent.push_back(thread_id);
    }

    fn evict_inactive(&mut self) {
        while self.states.len() > MAX_THREAD_PRESENTATIONS {
            let thread_id = self
                .recent
                .pop_front()
                .expect("every Thread presentation has a recency entry");
            if thread_id == self.active {
                self.recent.push_back(thread_id);
                continue;
            }
            self.states.remove(&thread_id);
        }
    }

    #[cfg(test)]
    pub(crate) fn contains(&self, thread_id: &ThreadId) -> bool {
        self.states.contains_key(thread_id)
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.states.len()
    }
}

#[cfg(test)]
#[path = "presentation_store_tests.rs"]
mod tests;
