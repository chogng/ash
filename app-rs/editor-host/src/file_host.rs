use std::path::Path;

#[cfg(test)]
use ash_editor::CodeEditorRowSource;
use ash_editor::{
    CodeEditorCommand, CodeEditorDocument, CodeEditorFoldControl, CodeEditorLanguage,
    CodeEditorNavigation, CodeEditorPosition, CodeEditorSearchQuery, CodeEditorSelectionMode,
    CodeEditorTextEdit, CodeEditorViewport,
};
use ash_text_file::{
    TextFileDiskVersion, TextFileLifecycle, TextFileSaveRequest, TextFileSnapshot, TextFileStatus,
};
use zui::ui::TextInputCompositionEvent;

/// Whether a close request can proceed without losing editor-owned text.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FileEditorCloseRequest {
    CanClose,
    NeedsConfirmation,
}

/// One file tab composing an editor document and viewport with file lifecycle state.
pub struct FileEditorTab {
    document: CodeEditorDocument,
    viewport: CodeEditorViewport,
    lifecycle: TextFileLifecycle,
}

impl FileEditorTab {
    pub fn path(&self) -> &Path {
        self.lifecycle.path()
    }

    pub fn label(&self) -> String {
        self.path()
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| self.path().to_string_lossy().into_owned())
    }

    pub const fn document(&self) -> &CodeEditorDocument {
        &self.document
    }

    pub const fn viewport(&self) -> CodeEditorViewport {
        self.viewport
    }

    #[cfg(test)]
    pub const fn viewport_mut(&mut self) -> &mut CodeEditorViewport {
        &mut self.viewport
    }

    pub fn is_dirty(&self) -> bool {
        self.lifecycle.is_dirty(self.document.text())
    }

    pub fn is_readonly(&self) -> bool {
        self.lifecycle.is_read_only()
    }

    pub fn status(&self) -> TextFileStatus {
        self.lifecycle.status(self.document.text())
    }

    fn save_request(&self) -> Option<TextFileSaveRequest> {
        self.lifecycle.save_request(self.document.text())
    }

    fn mark_saved(&mut self, version: TextFileDiskVersion) {
        self.lifecycle.mark_saved(self.document.text(), version);
    }

    fn observe_external(&mut self, snapshot: TextFileSnapshot) {
        let _ = self
            .lifecycle
            .observe_external(self.document.text(), snapshot);
    }

    fn reload_external(&mut self) -> bool {
        let Some(snapshot) = self.lifecycle.take_pending_external() else {
            return false;
        };
        self.document.replace_text(snapshot.content());
        self.lifecycle
            .mark_saved(snapshot.content(), snapshot.version());
        self.viewport = CodeEditorViewport::default();
        true
    }
}

/// Native product host for file tabs, active selection, close policy, and editor composition.
///
/// Editing, syntax analysis, folding, caret, and selection remain delegated to each retained
/// [`CodeEditorDocument`]. Saved baselines and conflicts are delegated to [`TextFileLifecycle`];
/// filesystem transport and renderer details never enter either document model.
#[derive(Default)]
pub struct FileEditorHost {
    tabs: Vec<FileEditorTab>,
    active: Option<usize>,
}

impl FileEditorHost {
    pub fn tabs(&self) -> &[FileEditorTab] {
        &self.tabs
    }

    pub const fn active_index(&self) -> Option<usize> {
        self.active
    }

    pub fn active(&self) -> Option<&FileEditorTab> {
        self.active.and_then(|index| self.tabs.get(index))
    }

    pub fn active_mut(&mut self) -> Option<&mut FileEditorTab> {
        self.active.and_then(|index| self.tabs.get_mut(index))
    }

    pub fn open(&mut self, snapshot: TextFileSnapshot) -> usize {
        if let Some(index) = self
            .tabs
            .iter()
            .position(|tab| tab.path() == snapshot.path())
        {
            self.tabs[index].observe_external(snapshot);
            self.active = Some(index);
            return index;
        }
        let language = language_for_path(snapshot.path());
        let content = snapshot.content().to_owned();
        self.tabs.push(FileEditorTab {
            document: CodeEditorDocument::from_text_with_language(content, language),
            viewport: CodeEditorViewport::default(),
            lifecycle: TextFileLifecycle::new(snapshot),
        });
        let index = self.tabs.len() - 1;
        self.active = Some(index);
        index
    }

    pub fn select(&mut self, index: usize) -> bool {
        if index >= self.tabs.len() {
            return false;
        }
        self.active = Some(index);
        true
    }

    pub fn apply(&mut self, command: CodeEditorCommand) -> bool {
        let Some(tab) = self.active_mut() else {
            return false;
        };
        if tab.is_readonly() && mutates_text(&command) {
            return false;
        }
        tab.document.apply(command);
        true
    }

    pub fn apply_in_view(
        &mut self,
        command: CodeEditorCommand,
        navigation: CodeEditorNavigation,
    ) -> bool {
        let Some(tab) = self.active_mut() else {
            return false;
        };
        if tab.is_readonly() && mutates_text(&command) {
            return false;
        }
        tab.document.apply_in_view(command, navigation);
        true
    }

    pub fn apply_composition(&mut self, event: TextInputCompositionEvent) -> bool {
        let Some(tab) = self.active_mut() else {
            return false;
        };
        if tab.is_readonly() {
            tab.document.cancel_composition();
            return false;
        }
        tab.document.apply_composition(event);
        true
    }

    pub fn apply_language_completion(&mut self, edit: &ash_lsp_manager::LanguageTextEdit) -> bool {
        let Some(tab) = self.active_mut() else {
            return false;
        };
        if tab.is_readonly() {
            return false;
        }
        tab.document.apply_text_edit(CodeEditorTextEdit {
            range: edit.range.byte_range(),
            new_text: edit.new_text.clone(),
        })
    }

    pub fn cancel_active_composition(&mut self) {
        if let Some(tab) = self.active_mut() {
            tab.document.cancel_composition();
        }
    }

    pub fn move_active_caret(
        &mut self,
        position: CodeEditorPosition,
        mode: CodeEditorSelectionMode,
    ) -> bool {
        let Some(tab) = self.active_mut() else {
            return false;
        };
        tab.document.move_to(position, mode);
        true
    }

    pub fn toggle_active_fold(&mut self, control: CodeEditorFoldControl) -> bool {
        self.active_mut()
            .and_then(|tab| tab.document.toggle_fold_control(control))
            .is_some()
    }

    pub fn active_match_count(&self, query: &CodeEditorSearchQuery) -> usize {
        self.active()
            .map_or(0, |tab| tab.document.search_matches(query).len())
    }

    pub fn find_next(&mut self, query: &CodeEditorSearchQuery) -> bool {
        self.active_mut()
            .and_then(|tab| tab.document.find_next(query))
            .is_some()
    }

    pub fn find_nearest(&mut self, query: &CodeEditorSearchQuery) -> bool {
        self.active_mut()
            .and_then(|tab| tab.document.find_nearest(query))
            .is_some()
    }

    pub fn find_previous(&mut self, query: &CodeEditorSearchQuery) -> bool {
        self.active_mut()
            .and_then(|tab| tab.document.find_previous(query))
            .is_some()
    }

    pub fn replace_current(&mut self, query: &CodeEditorSearchQuery, replacement: &str) -> bool {
        let Some(tab) = self.active_mut() else {
            return false;
        };
        !tab.is_readonly() && tab.document.replace_current(query, replacement)
    }

    pub fn replace_all(&mut self, query: &CodeEditorSearchQuery, replacement: &str) -> usize {
        let Some(tab) = self.active_mut() else {
            return 0;
        };
        if tab.is_readonly() {
            return 0;
        }
        tab.document.replace_all(query, replacement)
    }

    #[cfg(test)]
    pub fn reveal_active_caret(&mut self, visible_row_capacity: usize) {
        let Some(tab) = self.active_mut() else {
            return;
        };
        let row_count = tab.document.row_count();
        let Some(caret_row) = tab
            .document
            .caret()
            .and_then(|caret| tab.document.visual_row(caret.row_index))
        else {
            return;
        };
        tab.viewport
            .reveal_row(caret_row, row_count, visible_row_capacity);
    }

    pub fn reveal_active_visual_row(
        &mut self,
        visual_row: usize,
        visual_row_count: usize,
        visible_row_capacity: usize,
    ) {
        let Some(tab) = self.active_mut() else {
            return;
        };
        tab.viewport
            .reveal_row(visual_row, visual_row_count, visible_row_capacity);
    }

    pub fn scroll_active_rows(
        &mut self,
        delta: isize,
        visual_row_count: usize,
        visible_row_capacity: usize,
    ) -> bool {
        let Some(tab) = self.active_mut() else {
            return false;
        };
        let previous = tab.viewport;
        tab.viewport
            .scroll_rows(delta, visual_row_count, visible_row_capacity);
        tab.viewport != previous
    }

    pub fn save_request(&self) -> Option<TextFileSaveRequest> {
        self.active()?.save_request()
    }

    pub fn overwrite_request(&self) -> Option<TextFileSaveRequest> {
        let tab = self.active()?;
        tab.lifecycle.overwrite_request(tab.document.text())
    }

    pub fn mark_active_saved(&mut self, version: TextFileDiskVersion) -> bool {
        let Some(tab) = self.active_mut() else {
            return false;
        };
        tab.mark_saved(version);
        true
    }

    pub fn observe_external(&mut self, snapshot: TextFileSnapshot) -> bool {
        let Some(tab) = self
            .tabs
            .iter_mut()
            .find(|tab| tab.path() == snapshot.path())
        else {
            return false;
        };
        tab.observe_external(snapshot);
        true
    }

    pub fn reload_active_external(&mut self) -> bool {
        self.active_mut()
            .is_some_and(FileEditorTab::reload_external)
    }

    pub fn request_close_active(&self) -> FileEditorCloseRequest {
        if self.active().is_some_and(FileEditorTab::is_dirty) {
            FileEditorCloseRequest::NeedsConfirmation
        } else {
            FileEditorCloseRequest::CanClose
        }
    }

    pub fn close_active_discarding_changes(&mut self) -> bool {
        let Some(index) = self.active else {
            return false;
        };
        self.tabs.remove(index);
        self.active = if self.tabs.is_empty() {
            None
        } else {
            Some(index.min(self.tabs.len() - 1))
        };
        true
    }

    pub fn request_dir_change(&self) -> FileEditorCloseRequest {
        if self.tabs.iter().any(FileEditorTab::is_dirty) {
            return FileEditorCloseRequest::NeedsConfirmation;
        }
        FileEditorCloseRequest::CanClose
    }

    pub fn reset_for_dir_change(&mut self) {
        self.tabs.clear();
        self.active = None;
    }
}

fn mutates_text(command: &CodeEditorCommand) -> bool {
    matches!(
        command,
        CodeEditorCommand::Insert(_)
            | CodeEditorCommand::Newline
            | CodeEditorCommand::Indent
            | CodeEditorCommand::Outdent
            | CodeEditorCommand::Backspace
            | CodeEditorCommand::DeleteForward
            | CodeEditorCommand::Undo
            | CodeEditorCommand::Redo
    )
}

fn language_for_path(path: &Path) -> CodeEditorLanguage {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("rs") => CodeEditorLanguage::Rust,
        Some("json") => CodeEditorLanguage::Json,
        Some("jsonc") => CodeEditorLanguage::Jsonc,
        Some("sh" | "bash" | "zsh") => CodeEditorLanguage::Shell,
        _ => CodeEditorLanguage::PlainText,
    }
}

#[cfg(test)]
#[path = "file_host_tests.rs"]
mod tests;
