use ash_commands::AppCommandId;
use zui::ui::ElementId;
use zui::ui::TextInput;
use zui::ui::TextInputCommand;
use zui::ui::TextInputCompositionEvent;

use crate::presentation::WorkbenchKeybindings;

/// Supplies searchable candidates for one Workbench quick-access entry.
///
/// Implementations read their owning feature state and return owned candidates. QuickAccess owns
/// the query lifecycle and calls the active provider whenever the query changes.
pub(crate) trait QuickAccessProvider {
    type Item;

    fn items(&self, query: &str) -> Vec<Self::Item>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum QuickAccessEntry {
    Shortcuts,
}

/// Workbench-owned lifecycle and query state for quick-access surfaces.
#[derive(Default)]
pub(crate) struct QuickAccess {
    active: Option<QuickAccessEntry>,
    query: TextInput,
}

impl QuickAccess {
    pub(crate) fn open_shortcuts(&mut self) {
        if !self.shortcuts_open() {
            self.query = TextInput::default();
        }
        self.active = Some(QuickAccessEntry::Shortcuts);
    }

    pub(crate) fn close(&mut self) {
        self.active = None;
        self.query = TextInput::default();
    }

    pub(crate) fn shortcuts_open(&self) -> bool {
        self.active == Some(QuickAccessEntry::Shortcuts)
    }

    pub(crate) const fn query_input(&self) -> &TextInput {
        &self.query
    }

    pub(crate) fn selected_query_text(&self) -> Option<&str> {
        self.query.selected_text()
    }

    pub(crate) fn apply_query(&mut self, command: TextInputCommand) {
        self.query.apply(command);
    }

    pub(crate) fn apply_query_composition(&mut self, event: TextInputCompositionEvent) {
        self.query.apply_composition(event);
    }

    pub(crate) fn cancel_query_composition(&mut self) {
        self.query.cancel_composition();
    }

    pub(crate) fn shortcut_items(
        &self,
        keybindings: &dyn WorkbenchKeybindings,
    ) -> Vec<shortcut_provider::ShortcutItem> {
        if !self.shortcuts_open() {
            return Vec::new();
        }
        ShortcutProvider::new(keybindings).items(self.query.text())
    }

    pub(crate) fn shortcut_command(&self, element: ElementId) -> Option<AppCommandId> {
        if !self.shortcuts_open() {
            return None;
        }
        ShortcutProvider::command_for_element(element)
    }
}

#[path = "quick_access/shortcut_provider.rs"]
mod shortcut_provider;

use shortcut_provider::ShortcutProvider;

#[cfg(test)]
#[path = "quick_access/quick_access_tests.rs"]
mod tests;
