//! Logical inputs mounted in one Workbench pane group.

use crate::PaneInput;

/// Stable identity for one logical input opened inside a [`PaneGroup`].
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct PaneInputId(u64);

impl PaneInputId {
    const FIRST: u64 = 1;

    #[cfg(test)]
    pub const fn from_value(value: u64) -> Self {
        Self(value)
    }

    #[cfg(test)]
    pub const fn value(self) -> u64 {
        self.0
    }
}

#[derive(Clone, Debug, PartialEq)]
struct PaneInputEntry {
    id: PaneInputId,
    input: PaneInput,
}

/// One rectangular workbench group.
///
/// A group owns the logical inputs shown in its tab strip and the active input. It does not own
/// layout topology, renderer nodes, or feature runtime handles; those belong to [`PanePart`] and
/// the application host respectively.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PaneGroup {
    inputs: Vec<PaneInputEntry>,
    active: Option<PaneInputId>,
    next_input_id: u64,
}

impl PaneGroup {
    /// Creates an empty group that can receive its first input from the owning layout.
    pub fn new() -> Self {
        Self {
            inputs: Vec::new(),
            active: None,
            next_input_id: PaneInputId::FIRST,
        }
    }

    #[cfg(test)]
    /// Creates a group with one active input.
    pub fn with_input(input: PaneInput) -> Self {
        let mut group = Self::new();
        group.open_input(input);
        group
    }

    /// Returns the IDs of the inputs in tab order.
    pub fn input_ids(&self) -> Vec<PaneInputId> {
        self.inputs.iter().map(|entry| entry.id).collect()
    }

    /// Returns the inputs in tab order.
    pub fn inputs(&self) -> impl Iterator<Item = &PaneInput> {
        self.inputs.iter().map(|entry| &entry.input)
    }

    /// Returns the active input identity.
    pub const fn active_input_id(&self) -> Option<PaneInputId> {
        self.active
    }

    /// Returns the active input description.
    pub fn active_input(&self) -> Option<&PaneInput> {
        self.active.and_then(|id| self.input(id))
    }

    /// Returns one input by stable identity.
    pub fn input(&self, id: PaneInputId) -> Option<&PaneInput> {
        self.inputs
            .iter()
            .find(|entry| entry.id == id)
            .map(|entry| &entry.input)
    }

    /// Activates one input in this group.
    pub fn activate_input(&mut self, id: PaneInputId) -> bool {
        if self.input(id).is_none() {
            return false;
        }
        self.active = Some(id);
        true
    }

    /// Opens an input and makes it active.
    pub fn open_input(&mut self, input: PaneInput) -> PaneInputId {
        let id = self.allocate_input_id();
        self.inputs.push(PaneInputEntry { id, input });
        self.active = Some(id);
        id
    }

    /// Adds an input without changing the active input when the group is already populated.
    pub fn add_input(&mut self, input: PaneInput) -> PaneInputId {
        let id = self.allocate_input_id();
        self.inputs.push(PaneInputEntry { id, input });
        if self.active.is_none() {
            self.active = Some(id);
        }
        id
    }

    /// Replaces an existing input while preserving its identity.
    pub fn replace_input(&mut self, id: PaneInputId, input: PaneInput) -> Option<PaneInput> {
        let entry = self.inputs.iter_mut().find(|entry| entry.id == id)?;
        Some(std::mem::replace(&mut entry.input, input))
    }

    /// Replaces the active input while preserving its identity.
    pub fn replace_active_input(&mut self, input: PaneInput) -> Option<PaneInput> {
        self.active.map(|id| {
            self.replace_input(id, input)
                .expect("active PaneInput must be present in its PaneGroup")
        })
    }

    #[cfg(test)]
    /// Closes an input and selects the nearest remaining input.
    pub fn close_input(&mut self, id: PaneInputId) -> Option<PaneInput> {
        let index = self.inputs.iter().position(|entry| entry.id == id)?;
        let removed = self.inputs.remove(index).input;
        if self.active == Some(id) {
            self.active = self
                .inputs
                .get(index.min(self.inputs.len().saturating_sub(1)))
                .map(|entry| entry.id);
        }
        Some(removed)
    }

    /// Removes all inputs in tab order for group teardown.
    pub(crate) fn take_inputs(self) -> Vec<(PaneInputId, PaneInput)> {
        self.inputs
            .into_iter()
            .map(|entry| (entry.id, entry.input))
            .collect()
    }

    fn allocate_input_id(&mut self) -> PaneInputId {
        let id = PaneInputId(self.next_input_id);
        self.next_input_id = self
            .next_input_id
            .checked_add(1)
            .expect("PaneInput identity space exhausted");
        id
    }
}

#[cfg(test)]
#[path = "pane_group_tests.rs"]
mod tests;
