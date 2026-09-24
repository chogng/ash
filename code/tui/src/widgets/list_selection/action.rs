use super::ListSelectionAdjustment;
use super::ListSelectionInputOutcome;
use super::ListSelectionItemId;
use super::ListSelectionModel;
use super::ListSelectionState;
use crate::keymap::bindings;
use crate::widgets::key_hint::KeyHints;
use crossterm::event::KeyEvent;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ListSelectionOutcome<A> {
    Activate(A),
    Adjust(A, ListSelectionAdjustment),
    Consumed,
    Dismiss,
    FocusPrevious,
}

/// Data supplied by a feature to construct a list-selection surface.
#[derive(Debug)]
pub(crate) struct ListSelectionSpec<A> {
    pub(crate) model: ListSelectionModel,
    pub(crate) actions: BTreeMap<ListSelectionItemId, A>,
}

/// Binds an opaque feature action to each selectable list item.
#[derive(Debug)]
pub(crate) struct ListSelection<A> {
    state: ListSelectionState,
    actions: BTreeMap<ListSelectionItemId, A>,
    key_hints: KeyHints,
    search_hints: KeyHints,
}

impl<A> ListSelection<A> {
    pub(crate) fn new(
        model: ListSelectionModel,
        actions: BTreeMap<ListSelectionItemId, A>,
    ) -> Self {
        let key_hints = model.key_hints();
        let search_hints = search_hints(&model);
        Self {
            state: ListSelectionState::new(model),
            actions,
            key_hints,
            search_hints,
        }
    }

    pub(crate) fn replace(
        &mut self,
        model: ListSelectionModel,
        actions: BTreeMap<ListSelectionItemId, A>,
    ) {
        self.key_hints = model.key_hints();
        self.search_hints = search_hints(&model);
        self.state.replace_model(model);
        self.actions = actions;
    }

    pub(crate) fn key_hints(&self) -> &KeyHints {
        if self.state.search_focused() {
            &self.search_hints
        } else if self.state.tabs_focused() {
            &bindings::TAB_HINTS
        } else {
            &self.key_hints
        }
    }

    pub(crate) fn action(&self, id: &ListSelectionItemId) -> Option<&A> {
        self.actions.get(id)
    }

    pub(crate) fn state(&self) -> &ListSelectionState {
        &self.state
    }

    pub(crate) fn state_mut(&mut self) -> &mut ListSelectionState {
        &mut self.state
    }

    pub(crate) fn handle_paste(&mut self, pasted: String) {
        self.state.handle_paste(pasted);
    }
}

impl<A: Clone> ListSelection<A> {
    pub(crate) fn handle_key(&mut self, key: KeyEvent) -> ListSelectionOutcome<A> {
        match self.state.handle_key(key) {
            ListSelectionInputOutcome::Activate(item_id) => self
                .actions
                .get(&item_id)
                .cloned()
                .map(ListSelectionOutcome::Activate)
                .unwrap_or(ListSelectionOutcome::Consumed),
            ListSelectionInputOutcome::Adjust(item_id, adjustment) => self
                .actions
                .get(&item_id)
                .cloned()
                .map(|action| ListSelectionOutcome::Adjust(action, adjustment))
                .unwrap_or(ListSelectionOutcome::Consumed),
            ListSelectionInputOutcome::Consumed => ListSelectionOutcome::Consumed,
            ListSelectionInputOutcome::Dismiss => ListSelectionOutcome::Dismiss,
            ListSelectionInputOutcome::FocusPrevious => ListSelectionOutcome::FocusPrevious,
        }
    }
}

fn search_hints(model: &ListSelectionModel) -> KeyHints {
    let mut hints = KeyHints::new().with_binding(bindings::SEARCH_RETURN);
    if model.show_tabs() {
        hints = hints.with_binding(bindings::TABS);
    }
    hints
}
