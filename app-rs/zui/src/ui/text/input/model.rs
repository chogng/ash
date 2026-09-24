use std::ops::Range;

use unicode_segmentation::UnicodeSegmentation;

/// Determines whether a navigation command collapses or extends the current selection.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TextInputSelectionMode {
    /// Move the caret and collapse any active selection.
    Move,
    /// Move the caret while preserving the selection anchor.
    Extend,
}

/// Platform-independent editing commands accepted by a single-line text input.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TextInputCommand {
    Insert(String),
    MoveLeft(TextInputSelectionMode),
    MoveRight(TextInputSelectionMode),
    MoveToStart(TextInputSelectionMode),
    MoveToEnd(TextInputSelectionMode),
    SelectAll,
    Backspace,
    DeleteForward,
}

/// Cursor projection reported for an active platform composition.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TextInputCompositionCursor {
    Visible(Range<usize>),
    Hidden,
}

/// Platform-independent composition updates accepted by a single-line text input.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TextInputCompositionEvent {
    Preedit {
        text: String,
        cursor: TextInputCompositionCursor,
    },
    Commit(String),
    Cancel,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Composition {
    text: String,
    cursor: TextInputCompositionCursor,
}

/// Reusable single-line editing state independent of component, window, and rendering backends.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct TextInput {
    text: String,
    anchor: usize,
    cursor: usize,
    composition: Option<Composition>,
}

impl TextInput {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    /// Removes and returns committed text while resetting selection and composition state.
    pub fn take_text(&mut self) -> String {
        self.anchor = 0;
        self.cursor = 0;
        self.composition = None;
        std::mem::take(&mut self.text)
    }

    pub const fn anchor(&self) -> usize {
        self.anchor
    }

    pub const fn cursor(&self) -> usize {
        self.cursor
    }

    /// Returns the currently selected committed text, or `None` for a collapsed selection.
    pub fn selected_text(&self) -> Option<&str> {
        self.has_selection().then(|| &self.text[self.selection()])
    }

    pub fn composition(&self) -> Option<(&str, &TextInputCompositionCursor)> {
        self.composition
            .as_ref()
            .map(|composition| (composition.text.as_str(), &composition.cursor))
    }

    pub fn apply(&mut self, command: TextInputCommand) {
        match command {
            TextInputCommand::Insert(text) => self.insert_text(&text),
            TextInputCommand::MoveLeft(mode) => self.move_left(mode),
            TextInputCommand::MoveRight(mode) => self.move_right(mode),
            TextInputCommand::MoveToStart(mode) => self.move_to_start(mode),
            TextInputCommand::MoveToEnd(mode) => self.move_to_end(mode),
            TextInputCommand::SelectAll => self.select_all(),
            TextInputCommand::Backspace => self.backspace(),
            TextInputCommand::DeleteForward => self.delete_forward(),
        }
    }

    pub fn apply_composition(&mut self, event: TextInputCompositionEvent) {
        match event {
            TextInputCompositionEvent::Preedit {
                text,
                cursor: TextInputCompositionCursor::Visible(cursor),
            } => self.set_preedit_cursor(&text, cursor),
            TextInputCompositionEvent::Preedit {
                text,
                cursor: TextInputCompositionCursor::Hidden,
            } => self.set_preedit_without_cursor(&text),
            TextInputCompositionEvent::Commit(text) => self.commit_preedit(&text),
            TextInputCompositionEvent::Cancel => self.cancel_composition(),
        }
    }

    fn insert_text(&mut self, text: &str) {
        self.cancel_composition();
        let text = single_line_text(text);
        if text.is_empty() {
            return;
        }
        self.replace_selection(&text);
    }

    fn set_preedit_cursor(&mut self, text: &str, cursor: Range<usize>) {
        let text = single_line_text(text);
        if text.is_empty() {
            self.composition = None;
            return;
        }
        self.composition = Some(Composition {
            cursor: TextInputCompositionCursor::Visible(clamp_range(&text, cursor)),
            text,
        });
    }

    fn set_preedit_without_cursor(&mut self, text: &str) {
        let text = single_line_text(text);
        if text.is_empty() {
            self.composition = None;
            return;
        }
        self.composition = Some(Composition {
            text,
            cursor: TextInputCompositionCursor::Hidden,
        });
    }

    fn commit_preedit(&mut self, text: &str) {
        self.composition = None;
        let text = single_line_text(text);
        if !text.is_empty() {
            self.replace_selection(&text);
        }
    }

    pub fn cancel_composition(&mut self) {
        self.composition = None;
    }

    fn move_left(&mut self, mode: TextInputSelectionMode) {
        self.cancel_composition();
        if mode == TextInputSelectionMode::Move && self.has_selection() {
            self.collapse_selection(self.selection().start);
            return;
        }
        let next = previous_grapheme_boundary(&self.text, self.cursor);
        self.move_cursor(next, mode);
    }

    fn move_right(&mut self, mode: TextInputSelectionMode) {
        self.cancel_composition();
        if mode == TextInputSelectionMode::Move && self.has_selection() {
            self.collapse_selection(self.selection().end);
            return;
        }
        let next = next_grapheme_boundary(&self.text, self.cursor);
        self.move_cursor(next, mode);
    }

    fn move_to_start(&mut self, mode: TextInputSelectionMode) {
        self.cancel_composition();
        self.move_cursor(0, mode);
    }

    fn move_to_end(&mut self, mode: TextInputSelectionMode) {
        self.cancel_composition();
        self.move_cursor(self.text.len(), mode);
    }

    fn select_all(&mut self) {
        self.cancel_composition();
        self.anchor = 0;
        self.cursor = self.text.len();
    }

    fn backspace(&mut self) {
        self.cancel_composition();
        if self.delete_selection() {
            return;
        }
        let start = previous_grapheme_boundary(&self.text, self.cursor);
        if start != self.cursor {
            self.text.replace_range(start..self.cursor, "");
            self.collapse_selection(start);
        }
    }

    fn delete_forward(&mut self) {
        self.cancel_composition();
        if self.delete_selection() {
            return;
        }
        let end = next_grapheme_boundary(&self.text, self.cursor);
        if end != self.cursor {
            self.text.replace_range(self.cursor..end, "");
        }
    }

    fn replace_selection(&mut self, replacement: &str) {
        let selection = self.selection();
        self.text.replace_range(selection.clone(), replacement);
        self.collapse_selection(selection.start + replacement.len());
    }

    fn delete_selection(&mut self) -> bool {
        if !self.has_selection() {
            return false;
        }
        let selection = self.selection();
        self.text.replace_range(selection.clone(), "");
        self.collapse_selection(selection.start);
        true
    }

    fn selection(&self) -> Range<usize> {
        self.anchor.min(self.cursor)..self.anchor.max(self.cursor)
    }

    fn has_selection(&self) -> bool {
        self.anchor != self.cursor
    }

    fn collapse_selection(&mut self, cursor: usize) {
        self.anchor = cursor;
        self.cursor = cursor;
    }

    fn move_cursor(&mut self, cursor: usize, mode: TextInputSelectionMode) {
        self.cursor = cursor;
        if mode == TextInputSelectionMode::Move {
            self.anchor = cursor;
        }
    }
}

fn previous_grapheme_boundary(text: &str, cursor: usize) -> usize {
    text[..clamp_boundary(text, cursor)]
        .grapheme_indices(true)
        .next_back()
        .map(|(index, _)| index)
        .unwrap_or(0)
}

fn next_grapheme_boundary(text: &str, cursor: usize) -> usize {
    let cursor = clamp_boundary(text, cursor);
    text[cursor..]
        .grapheme_indices(true)
        .nth(1)
        .map(|(index, _)| cursor + index)
        .unwrap_or(text.len())
}

fn clamp_range(text: &str, range: Range<usize>) -> Range<usize> {
    let start = clamp_boundary(text, range.start);
    let end = clamp_boundary(text, range.end);
    start.min(end)..start.max(end)
}

fn clamp_boundary(text: &str, requested: usize) -> usize {
    let mut index = requested.min(text.len());
    while !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn single_line_text(text: &str) -> String {
    text.chars()
        .filter(|character| !matches!(character, '\r' | '\n') && !character.is_control())
        .collect()
}

#[cfg(test)]
#[path = "model_tests.rs"]
mod tests;
