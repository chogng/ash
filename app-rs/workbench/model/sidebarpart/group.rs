//! One ordered group of Sidebar items.

use crate::TabInput;
use crate::TabInputKey;

/// Stable identity for one browser-style group of Workbench tabs.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct TabGroupId(u64);

impl TabGroupId {
    /// The anonymous group that receives ungrouped Workbench tabs.
    pub const DEFAULT: Self = Self(1);

    pub const fn from_value(value: u64) -> Self {
        Self(value)
    }

    pub const fn value(self) -> u64 {
        self.0
    }
}

/// One ordered browser-style group of logical [`TabInput`] values.
///
/// A Tab Group owns membership and presentation metadata only. The active tab is owned by the
/// surrounding [`SidebarPart`](crate::SidebarPart), because every projected group selects content in
/// the same Workbench surface.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TabGroup {
    id: TabGroupId,
    label: Option<String>,
    collapsed: bool,
    inputs: Vec<TabInput>,
}

impl TabGroup {
    pub(crate) fn new(id: TabGroupId, label: Option<String>) -> Self {
        Self {
            id,
            label,
            collapsed: false,
            inputs: Vec::new(),
        }
    }

    /// Returns this group's stable logical identity.
    pub const fn id(&self) -> TabGroupId {
        self.id
    }

    /// Returns the optional browser-style group label.
    pub fn label(&self) -> Option<&str> {
        self.label.as_deref()
    }

    /// Returns whether mounted views should collapse this group's tab members.
    pub const fn is_collapsed(&self) -> bool {
        self.collapsed
    }

    pub(crate) fn toggle_collapsed(&mut self) -> bool {
        if self.label.is_none() {
            return false;
        }
        self.collapsed = !self.collapsed;
        true
    }

    /// Returns this group's inputs in logical tab order.
    pub fn inputs(&self) -> &[TabInput] {
        &self.inputs
    }

    /// Returns whether this group owns the supplied logical tab.
    pub fn contains(&self, key: &TabInputKey) -> bool {
        self.inputs.iter().any(|input| input.key() == key)
    }

    pub(crate) fn input_mut(&mut self, key: &TabInputKey) -> Option<&mut TabInput> {
        self.inputs.iter_mut().find(|input| input.key() == key)
    }

    pub(crate) fn insert_input(&mut self, index: usize, input: TabInput) {
        self.inputs.insert(index.min(self.inputs.len()), input);
    }

    pub(crate) fn push_input(&mut self, input: TabInput) {
        self.inputs.push(input);
    }

    pub(crate) fn remove_input(&mut self, key: &TabInputKey) -> Option<TabInput> {
        let index = self.inputs.iter().position(|input| input.key() == key)?;
        Some(self.inputs.remove(index))
    }

    pub(crate) fn move_input(&mut self, key: &TabInputKey, index: usize) -> bool {
        let Some(current) = self.inputs.iter().position(|input| input.key() == key) else {
            return false;
        };
        let input = self.inputs.remove(current);
        self.inputs.insert(index.min(self.inputs.len()), input);
        true
    }
}
