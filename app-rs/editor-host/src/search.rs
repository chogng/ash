use ash_editor::CodeEditorSearchQuery;
use zui::ui::{TextInput, TextInputCommand, TextInputCompositionEvent};

/// Which find widget fields are visible above the shared CodeEditor.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum FileEditorSearchMode {
    #[default]
    Hidden,
    Find,
    Replace,
}

/// Ephemeral input state for the file editor find/replace presentation.
#[derive(Default)]
pub struct FileEditorSearchState {
    mode: FileEditorSearchMode,
    query: TextInput,
    replacement: TextInput,
}

impl FileEditorSearchState {
    pub const fn mode(&self) -> FileEditorSearchMode {
        self.mode
    }

    pub const fn query_input(&self) -> &TextInput {
        &self.query
    }

    pub const fn replacement_input(&self) -> &TextInput {
        &self.replacement
    }

    pub fn query(&self) -> CodeEditorSearchQuery {
        CodeEditorSearchQuery::new(self.query.text())
    }

    pub fn replacement(&self) -> &str {
        self.replacement.text()
    }

    pub fn selected_query_text(&self) -> Option<&str> {
        self.query.selected_text()
    }

    pub fn selected_replacement_text(&self) -> Option<&str> {
        self.replacement.selected_text()
    }

    pub fn show_find(&mut self) {
        self.mode = FileEditorSearchMode::Find;
        self.query.apply(TextInputCommand::SelectAll);
    }

    pub fn show_replace(&mut self) {
        self.mode = FileEditorSearchMode::Replace;
        self.query.apply(TextInputCommand::SelectAll);
    }

    pub fn hide(&mut self) {
        self.mode = FileEditorSearchMode::Hidden;
        self.cancel_composition();
    }

    pub fn apply_query(&mut self, command: TextInputCommand) {
        self.query.apply(command);
    }

    pub fn apply_replacement(&mut self, command: TextInputCommand) {
        self.replacement.apply(command);
    }

    pub fn apply_query_composition(&mut self, event: TextInputCompositionEvent) {
        self.query.apply_composition(event);
    }

    pub fn apply_replacement_composition(&mut self, event: TextInputCompositionEvent) {
        self.replacement.apply_composition(event);
    }

    pub fn cancel_composition(&mut self) {
        self.query.cancel_composition();
        self.replacement.cancel_composition();
    }
}

#[cfg(test)]
#[path = "search_tests.rs"]
mod tests;
