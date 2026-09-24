//! Ephemeral input state owned by the file editor capability.

use std::ops::Range;
use std::time::Instant;

use crate::FileEditorAutoScrollState;
use crate::FileEditorPrompt;
use ash_editor::CodeEditorPosition;

const ROWS_PER_WHEEL_STEP: f64 = 3.0;

/// Host-neutral wheel motion routed to the file editor.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FileEditorWheelDelta {
    Lines(f32),
    Pixels(f64),
}

/// Pointer, prompt, and completion state that does not belong to an editor document.
#[derive(Default)]
pub struct FileEditorInputState {
    dragging_selection: bool,
    fractional_rows: f64,
    prompt: FileEditorPrompt,
    auto_scroll: FileEditorAutoScrollState,
    hovered_diagnostic: Option<Range<usize>>,
    hovered_language_position: Option<CodeEditorPosition>,
    completion_selection: usize,
}

impl FileEditorInputState {
    pub fn cancel_pointer(&mut self) {
        self.dragging_selection = false;
        self.auto_scroll.stop();
        self.hovered_diagnostic = None;
        self.hovered_language_position = None;
        self.completion_selection = 0;
    }

    pub fn reset_for_document_change(&mut self) {
        self.dragging_selection = false;
        self.fractional_rows = 0.0;
        self.prompt = FileEditorPrompt::None;
        self.auto_scroll.stop();
        self.hovered_diagnostic = None;
        self.hovered_language_position = None;
        self.completion_selection = 0;
    }

    pub const fn prompt(&self) -> FileEditorPrompt {
        self.prompt
    }

    pub fn confirm_close(&mut self) {
        self.prompt = FileEditorPrompt::ConfirmClose;
    }

    pub fn dismiss_prompt(&mut self) {
        self.prompt = FileEditorPrompt::None;
    }

    pub fn begin_selection(&mut self) {
        self.dragging_selection = true;
        self.auto_scroll.stop();
    }

    pub fn end_selection(&mut self) {
        self.dragging_selection = false;
        self.auto_scroll.stop();
    }

    pub const fn is_selecting(&self) -> bool {
        self.dragging_selection
    }

    pub fn update_hovered_diagnostic(&mut self, range: Option<Range<usize>>) -> bool {
        if self.hovered_diagnostic == range {
            return false;
        }
        self.hovered_diagnostic = range;
        true
    }

    pub fn update_hovered_language_position(
        &mut self,
        position: Option<CodeEditorPosition>,
    ) -> bool {
        if self.hovered_language_position == position {
            return false;
        }
        self.hovered_language_position = position;
        true
    }

    pub fn move_completion_selection(&mut self, delta: isize, item_count: usize) {
        if item_count == 0 {
            self.completion_selection = 0;
            return;
        }
        self.completion_selection = self
            .completion_selection
            .saturating_add_signed(delta)
            .min(item_count - 1);
    }

    pub const fn auto_scroll_deadline(&self) -> Option<Instant> {
        self.auto_scroll.deadline()
    }

    pub const fn completion_selection(&self) -> usize {
        self.completion_selection
    }

    pub fn wheel_rows(&mut self, delta: FileEditorWheelDelta, row_height: f32) -> isize {
        let rows = match delta {
            FileEditorWheelDelta::Lines(vertical) => -f64::from(vertical) * ROWS_PER_WHEEL_STEP,
            FileEditorWheelDelta::Pixels(vertical) => -vertical / f64::from(row_height),
        };
        if rows.signum() != self.fractional_rows.signum() {
            self.fractional_rows = 0.0;
        }
        self.fractional_rows += rows;
        let whole_rows = self.fractional_rows.trunc() as isize;
        self.fractional_rows -= whole_rows as f64;
        whole_rows
    }

    pub fn reset_wheel_accumulator(&mut self) {
        self.fractional_rows = 0.0;
    }

    pub fn auto_scroll_mut(&mut self) -> &mut FileEditorAutoScrollState {
        &mut self.auto_scroll
    }
}

#[cfg(test)]
#[path = "input_state_tests.rs"]
mod tests;
