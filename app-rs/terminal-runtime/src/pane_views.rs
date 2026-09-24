use std::collections::HashMap;
use std::hash::Hash;

/// Terminal view state retained per Workbench pane input.
pub struct TerminalPaneViews<K, V> {
    active: Option<K>,
    active_view: V,
    inactive: HashMap<K, V>,
}

impl<K, V> Default for TerminalPaneViews<K, V>
where
    V: Default,
{
    fn default() -> Self {
        Self {
            active: None,
            active_view: V::default(),
            inactive: HashMap::new(),
        }
    }
}

impl<K, V> TerminalPaneViews<K, V>
where
    K: Clone + Eq + Hash,
    V: Default,
{
    /// Switches active content, saving the current view and restoring the target view.
    pub fn activate(&mut self, key: K) {
        if self.active.as_ref() == Some(&key) {
            return;
        }
        if let Some(previous) = self.active.replace(key.clone()) {
            self.inactive
                .insert(previous, std::mem::take(&mut self.active_view));
        }
        self.active_view = self.inactive.remove(&key).unwrap_or_default();
    }

    /// Returns the active pane-input identity.
    pub const fn active(&self) -> Option<&K> {
        self.active.as_ref()
    }

    /// Returns the view state currently receiving input and presentation updates.
    pub const fn active_view(&self) -> &V {
        &self.active_view
    }

    /// Returns mutable state for the view currently receiving input.
    pub const fn active_view_mut(&mut self) -> &mut V {
        &mut self.active_view
    }

    /// Returns an inactive pane-input view for presentation.
    pub fn inactive(&self, key: &K) -> Option<&V> {
        self.inactive.get(key)
    }

    /// Removes one pane-input view and clears it when active.
    pub fn remove(&mut self, key: &K) -> Option<V> {
        if self.active.as_ref() == Some(key) {
            self.active = None;
            return Some(std::mem::take(&mut self.active_view));
        }
        self.inactive.remove(key)
    }

    /// Removes all pane-input views selected by the caller-owned identity boundary.
    pub fn retain(&mut self, mut keep: impl FnMut(&K) -> bool) {
        if self.active.as_ref().is_some_and(|key| !keep(key)) {
            self.active = None;
            self.active_view = V::default();
        }
        self.inactive.retain(|key, _| keep(key));
    }
}

#[cfg(test)]
#[path = "pane_views_tests.rs"]
mod tests;
