//! Sidebar Session search editor and matching policy.

use zui::ui::{TextInput, TextInputCommand, TextInputCompositionEvent};

#[derive(Default)]
pub struct SessionSearchState {
    input: TextInput,
}

impl SessionSearchState {
    pub const fn input(&self) -> &TextInput {
        &self.input
    }

    pub fn apply(&mut self, command: TextInputCommand) {
        self.input.apply(command);
    }

    pub fn apply_composition(&mut self, event: TextInputCompositionEvent) {
        self.input.apply_composition(event);
    }

    pub fn cancel_composition(&mut self) {
        self.input.cancel_composition();
    }

    pub fn clear(&mut self) {
        self.input.take_text();
    }

    pub fn selected_text(&self) -> Option<&str> {
        self.input.selected_text()
    }

    pub fn matches_session_name(&self, name: &str) -> bool {
        let query = self.input.text().trim();
        query.is_empty() || name.to_lowercase().contains(&query.to_lowercase())
    }
}

#[cfg(test)]
#[path = "session_search_tests.rs"]
mod tests;
