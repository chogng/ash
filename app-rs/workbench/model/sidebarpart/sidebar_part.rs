//! Grouping, ordering, selection, and mode state for the Workbench Sidebar.

use std::collections::HashMap;
use std::collections::HashSet;

use ash_protocol::SessionId;

use crate::TabGroup;
use crate::TabGroupId;
use crate::TabInput;
use crate::TabInputChange;
use crate::TabInputKey;

/// Stable process-local identity for one mounted Workbench tab.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct TabId(u32);

impl TabId {
    /// First allocated tab identity.
    pub const FIRST: Self = Self(1);

    pub const fn value(self) -> u32 {
        self.0
    }
}

/// Active product mode selected in the Sidebar header.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum SidebarMode {
    Cowork,
    #[default]
    Code,
}

/// Workbench-owned Sidebar Part shared by its header and content pages.
///
/// The Part owns browser-style groups and one global active input. It contains no bounds, UI
/// element identity, renderer node, or host runtime state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SidebarPart {
    mode: SidebarMode,
    groups: Vec<TabGroup>,
    active: Option<TabInputKey>,
    last_session: Option<SessionId>,
    next_group_id: u64,
    tab_ids: HashMap<TabInputKey, TabId>,
    pinned_tabs: HashSet<TabInputKey>,
    renamed_tabs: HashMap<TabInputKey, String>,
    next_tab_id: u32,
}

impl Default for SidebarPart {
    fn default() -> Self {
        let mut default_group = TabGroup::new(TabGroupId::DEFAULT, None);
        default_group.push_input(TabInput::from_settings());
        Self {
            mode: SidebarMode::default(),
            groups: vec![default_group],
            active: None,
            last_session: None,
            next_group_id: TabGroupId::DEFAULT.value() + 1,
            tab_ids: HashMap::new(),
            pinned_tabs: HashSet::new(),
            renamed_tabs: HashMap::new(),
            next_tab_id: TabId::FIRST.value(),
        }
    }
}

impl SidebarPart {
    /// Returns the mode selected by the Sidebar header.
    pub const fn mode(&self) -> SidebarMode {
        self.mode
    }

    /// Selects the Sidebar product mode.
    pub fn set_mode(&mut self, mode: SidebarMode) -> bool {
        if self.mode == mode {
            return false;
        }
        self.mode = mode;
        true
    }

    /// Toggles a named group's child visibility.
    pub fn toggle_group(&mut self, id: TabGroupId) -> bool {
        self.group_mut(id).is_some_and(TabGroup::toggle_collapsed)
    }

    /// Returns browser-style groups in display order.
    pub fn groups(&self) -> &[TabGroup] {
        &self.groups
    }

    /// Returns one group by stable identity.
    pub fn group(&self, id: TabGroupId) -> Option<&TabGroup> {
        self.groups.iter().find(|group| group.id() == id)
    }

    /// Returns one mutable group by stable identity.
    pub fn group_mut(&mut self, id: TabGroupId) -> Option<&mut TabGroup> {
        self.groups.iter_mut().find(|group| group.id() == id)
    }

    /// Iterates every logical input in group and tab order.
    pub fn inputs(&self) -> impl DoubleEndedIterator<Item = &TabInput> {
        self.groups.iter().flat_map(TabGroup::inputs)
    }

    #[cfg(test)]
    /// Returns the number of logical inputs across all groups.
    pub fn input_count(&self) -> usize {
        self.groups.iter().map(|group| group.inputs().len()).sum()
    }

    /// Returns one logical input by stable key.
    pub fn input(&self, key: &TabInputKey) -> Option<&TabInput> {
        self.inputs().find(|input| input.key() == key)
    }

    /// Returns the group that owns one logical input.
    pub fn input_group(&self, key: &TabInputKey) -> Option<TabGroupId> {
        self.groups
            .iter()
            .find(|group| group.contains(key))
            .map(TabGroup::id)
    }

    /// Returns the stable mounted identity assigned to one Session tab.
    pub fn tab_id(&self, key: &TabInputKey) -> Option<TabId> {
        self.tab_ids.get(key).copied()
    }

    /// Returns whether one tab is pinned in its current group.
    pub fn is_tab_pinned(&self, key: &TabInputKey) -> bool {
        self.pinned_tabs.contains(key)
    }

    /// Returns the Workbench-owned display name for one tab.
    pub fn tab_name<'a>(&'a self, input: &'a TabInput) -> &'a str {
        self.renamed_tabs
            .get(input.key())
            .map(String::as_str)
            .unwrap_or_else(|| input.title())
    }

    /// Renames one known tab without changing its Session-owned title metadata.
    pub fn rename_tab(&mut self, key: &TabInputKey, title: impl Into<String>) -> bool {
        if self.input(key).is_none() {
            return false;
        }
        let title = title.into();
        let title = title.trim();
        if title.is_empty() {
            return false;
        }
        self.renamed_tabs.insert(key.clone(), title.to_owned());
        true
    }

    /// Pins one tab and moves it to the start of its current group.
    pub fn pin_tab(&mut self, key: &TabInputKey) -> bool {
        if self.input(key).is_none() || !self.pinned_tabs.insert(key.clone()) {
            return false;
        }
        let group = self
            .input_group(key)
            .expect("known TabInput must belong to one TabGroup");
        self.group_mut(group)
            .expect("resolved TabGroup must remain present")
            .move_input(key, 0)
    }

    /// Unpins one tab and places it after the group's pinned prefix.
    pub fn unpin_tab(&mut self, key: &TabInputKey) -> bool {
        if !self.pinned_tabs.remove(key) {
            return false;
        }
        let group = self
            .input_group(key)
            .expect("pinned TabInput must belong to one TabGroup");
        let index = self.pinned_count_excluding(group, key);
        self.group_mut(group)
            .expect("resolved TabGroup must remain present")
            .move_input(key, index)
    }

    /// Toggles one tab's pinned state and returns the new state.
    pub fn toggle_tab_pin(&mut self, key: &TabInputKey) -> Option<bool> {
        if self.is_tab_pinned(key) {
            self.unpin_tab(key).then_some(false)
        } else {
            self.pin_tab(key).then_some(true)
        }
    }

    /// Returns the active logical input key.
    pub fn active_tab_key(&self) -> Option<&TabInputKey> {
        self.active.as_ref()
    }

    #[cfg(test)]
    /// Returns the number of Session inputs, excluding Settings.
    pub fn session_count(&self) -> usize {
        self.inputs().filter(|input| input.is_session()).count()
    }

    /// Returns the last selected Session identity.
    pub fn selected_session(&self) -> Option<&SessionId> {
        self.last_session.as_ref()
    }

    /// Returns whether Settings is the globally active input.
    pub const fn is_settings(&self) -> bool {
        matches!(self.active, Some(TabInputKey::Settings))
    }

    /// Activates a known logical input without depending on a mounted element identity.
    pub fn activate_tab(&mut self, key: TabInputKey) -> bool {
        if self.input(&key).is_none() {
            return false;
        }
        if let Some(session_id) = key.session_id() {
            self.last_session = Some(session_id.clone());
        }
        self.active = Some(key);
        true
    }

    /// Activates a known Session input.
    pub fn activate_session(&mut self, session_id: &SessionId) -> bool {
        self.activate_tab(TabInputKey::session(session_id.clone()))
    }

    /// Opens or activates the Settings singleton.
    pub fn activate_settings(&mut self) -> bool {
        if self.input(&TabInputKey::Settings).is_none() {
            self.group_mut(TabGroupId::DEFAULT)
                .expect("default TabGroup must remain present")
                .push_input(TabInput::from_settings());
        }
        self.activate_tab(TabInputKey::Settings)
    }

    /// Returns to the last selected Session input.
    pub fn activate_last_session(&mut self) -> bool {
        let Some(session_id) = self.last_session.clone() else {
            self.active = None;
            return false;
        };
        self.activate_session(&session_id)
    }

    /// Creates an empty browser-style group after the existing groups.
    pub fn create_group(&mut self, label: impl Into<String>) -> TabGroupId {
        let id = TabGroupId::from_value(self.next_group_id);
        self.next_group_id = self
            .next_group_id
            .checked_add(1)
            .expect("TabGroup identity space exhausted");
        self.groups.push(TabGroup::new(id, Some(label.into())));
        id
    }

    /// Moves one logical input into a group at the requested group-local index.
    pub fn move_tab_to_group(
        &mut self,
        key: &TabInputKey,
        target_group: TabGroupId,
        index: usize,
    ) -> bool {
        if self.group(target_group).is_none() {
            return false;
        }
        let Some(source_group) = self.input_group(key) else {
            return false;
        };
        let pinned = self.is_tab_pinned(key);
        let pinned_count = self.pinned_count_excluding(target_group, key);
        let index = if pinned {
            index.min(pinned_count)
        } else {
            index.max(pinned_count)
        };
        if source_group == target_group {
            return self
                .group_mut(target_group)
                .is_some_and(|group| group.move_input(key, index));
        }

        let input = self
            .group_mut(source_group)
            .and_then(|group| group.remove_input(key))
            .expect("resolved TabGroup must own the moved TabInput");
        self.group_mut(target_group)
            .expect("validated target TabGroup must remain present")
            .insert_input(index, input);
        self.remove_empty_non_default_group(source_group);
        true
    }

    /// Combines existing tabs into one new browser-style group.
    pub fn group_tabs(
        &mut self,
        keys: impl IntoIterator<Item = TabInputKey>,
        label: impl Into<String>,
    ) -> Option<TabGroupId> {
        let group = self.create_group(label);
        let mut moved = 0;
        for key in keys {
            if self.move_tab_to_group(&key, group, moved) {
                moved += 1;
            }
        }
        if moved == 0 {
            self.remove_empty_non_default_group(group);
            None
        } else {
            Some(group)
        }
    }

    #[cfg(test)]
    /// Merges every input from one group into another while preserving source order.
    pub fn merge_groups(&mut self, source: TabGroupId, target: TabGroupId) -> bool {
        if source == target || self.group(target).is_none() {
            return false;
        }
        let Some(keys) = self.group(source).map(|group| {
            group
                .inputs()
                .iter()
                .map(|input| input.key().clone())
                .collect::<Vec<_>>()
        }) else {
            return false;
        };
        let mut target_index = self
            .group(target)
            .expect("validated target TabGroup")
            .inputs()
            .len();
        for key in keys {
            if self.move_tab_to_group(&key, target, target_index) {
                target_index += 1;
            }
        }
        self.remove_empty_non_default_group(source);
        true
    }

    /// Removes an input and selects the nearest remaining tab in flattened group order.
    pub fn close_tab(&mut self, key: &TabInputKey) -> Option<TabInput> {
        let ordered_keys = self
            .inputs()
            .map(|input| input.key().clone())
            .collect::<Vec<_>>();
        let index = ordered_keys.iter().position(|candidate| candidate == key)?;
        let source_group = self.input_group(key)?;
        let was_active = self.active.as_ref() == Some(key);
        let removed = self.group_mut(source_group)?.remove_input(key)?;
        self.tab_ids.remove(key);
        self.pinned_tabs.remove(key);
        self.renamed_tabs.remove(key);
        self.remove_empty_non_default_group(source_group);

        if was_active {
            let remaining = self
                .inputs()
                .map(|input| input.key().clone())
                .collect::<Vec<_>>();
            let replacement_index = index.min(remaining.len().saturating_sub(1));
            self.active = remaining.get(replacement_index).cloned();
        }

        if self.last_session.as_ref() == removed.session_id() {
            let last_session = self
                .inputs()
                .rev()
                .find_map(|input| input.session_id().cloned());
            self.last_session = last_session;
        }
        if let Some(session_id) = self.active.as_ref().and_then(TabInputKey::session_id) {
            self.last_session = Some(session_id.clone());
        }
        Some(removed)
    }

    /// Inserts or refreshes a Session input using normal selection semantics.
    pub fn upsert_session_input(&mut self, input: TabInput) -> TabInputChange {
        assert!(input.is_session(), "only Session inputs can be upserted");
        let key = input.key().clone();
        let was_settings = self.is_settings();
        if let Some(existing) = self.input_mut(&key) {
            existing.update_from(input);
            self.last_session = key.session_id().cloned();
            if !was_settings {
                self.active = Some(key.clone());
            }
            return TabInputChange::Updated(key);
        }

        self.register_tab(&key);
        self.insert_session_into_default_group(input);
        self.last_session = key.session_id().cloned();
        if !was_settings {
            self.active = Some(key.clone());
        }
        TabInputChange::Added(key)
    }

    /// Inserts or refreshes a catalog Session without changing the active input.
    pub fn upsert_catalog_session_input(&mut self, input: TabInput) -> TabInputChange {
        assert!(input.is_session(), "only Session inputs can be upserted");
        let key = input.key().clone();
        if let Some(existing) = self.input_mut(&key) {
            existing.update_from(input);
            return TabInputChange::Updated(key);
        }

        self.register_tab(&key);
        self.insert_session_into_default_group(input);
        TabInputChange::Added(key)
    }

    fn input_mut(&mut self, key: &TabInputKey) -> Option<&mut TabInput> {
        self.groups
            .iter_mut()
            .find_map(|group| group.input_mut(key))
    }

    fn insert_session_into_default_group(&mut self, input: TabInput) {
        let group = self
            .group_mut(TabGroupId::DEFAULT)
            .expect("default TabGroup must remain present");
        let index = group
            .inputs()
            .iter()
            .position(TabInput::is_settings)
            .unwrap_or(group.inputs().len());
        group.insert_input(index, input);
    }

    fn remove_empty_non_default_group(&mut self, id: TabGroupId) {
        if id == TabGroupId::DEFAULT {
            return;
        }
        if self
            .group(id)
            .is_some_and(|group| group.inputs().is_empty())
        {
            self.groups.retain(|group| group.id() != id);
        }
    }

    fn register_tab(&mut self, key: &TabInputKey) {
        let id = TabId(self.next_tab_id);
        self.next_tab_id = self
            .next_tab_id
            .checked_add(1)
            .expect("Tab identity space exhausted");
        let previous = self.tab_ids.insert(key.clone(), id);
        debug_assert!(previous.is_none());
    }

    fn pinned_count_excluding(&self, group: TabGroupId, excluded: &TabInputKey) -> usize {
        self.group(group)
            .expect("resolved TabGroup must remain present")
            .inputs()
            .iter()
            .filter(|input| input.key() != excluded && self.is_tab_pinned(input.key()))
            .count()
    }
}

#[cfg(test)]
#[path = "sidebar_part_tests.rs"]
mod tests;
