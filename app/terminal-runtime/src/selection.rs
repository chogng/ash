use ash_terminal::{ScreenBuffer, TerminalMousePosition};
use unicode_width::UnicodeWidthChar;
use zui::input::ElementState;
use zui::ui::{Color, PaintRect, Rect, UiScene};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TerminalSelectionRange {
    pub start: TerminalMousePosition,
    pub end: TerminalMousePosition,
}

impl TerminalSelectionRange {
    fn normalized(self) -> Self {
        if position_key(self.start) <= position_key(self.end) {
            self
        } else {
            Self {
                start: self.end,
                end: self.start,
            }
        }
    }
}

#[derive(Default)]
pub struct TerminalSelection {
    anchor: Option<TerminalMousePosition>,
    cursor: Option<TerminalMousePosition>,
    dragging: bool,
}

impl TerminalSelection {
    pub fn range(&self) -> Option<TerminalSelectionRange> {
        let start = self.anchor?;
        let end = self.cursor?;
        (start != end).then(|| TerminalSelectionRange { start, end }.normalized())
    }

    pub fn button_changed(
        &mut self,
        active_screen: ScreenBuffer,
        position: Option<TerminalMousePosition>,
        state: ElementState,
    ) -> bool {
        if active_screen != ScreenBuffer::Primary {
            self.clear();
            return false;
        }
        match state {
            ElementState::Pressed => {
                let Some(position) = position else {
                    self.clear();
                    return false;
                };
                self.anchor = Some(position);
                self.cursor = Some(position);
                self.dragging = true;
                true
            }
            ElementState::Released if self.dragging => {
                if let Some(position) = position {
                    self.cursor = Some(position);
                }
                self.dragging = false;
                if self.anchor == self.cursor {
                    self.anchor = None;
                    self.cursor = None;
                }
                true
            }
            ElementState::Released => false,
        }
    }

    pub fn moved(&mut self, position: Option<TerminalMousePosition>) -> bool {
        if !self.dragging {
            return false;
        }
        if let Some(position) = position {
            self.cursor = Some(position);
        }
        true
    }

    pub fn selected_text(&self, lines: &[String]) -> Option<String> {
        selected_text(lines, self.range()?)
    }

    pub fn clear(&mut self) {
        self.anchor = None;
        self.cursor = None;
        self.dragging = false;
    }
}

pub fn paint_terminal_selection(
    scene: &mut UiScene,
    bounds: Rect,
    cols: usize,
    selection: TerminalSelectionRange,
    cell_width: f32,
    line_height: f32,
    color: Color,
) {
    let start_row = selection.start.row() as usize;
    let end_row = selection.end.row() as usize;
    let capacity = ((bounds.size.height / line_height).floor() as usize).max(1);
    for row in start_row..=end_row.min(capacity.saturating_sub(1)) {
        let start_col = if row == start_row {
            selection.start.col() as usize
        } else {
            0
        }
        .min(cols);
        let end_col = if row == end_row {
            selection.end.col() as usize + 1
        } else {
            cols
        }
        .min(cols);
        if start_col >= end_col {
            continue;
        }
        scene.draw_rect(PaintRect::new(
            Rect::from_xywh(
                bounds.origin.x + start_col as f32 * cell_width,
                bounds.origin.y + row as f32 * line_height,
                (end_col - start_col) as f32 * cell_width,
                line_height,
            ),
            color,
        ));
    }
}

pub fn selected_text(lines: &[String], range: TerminalSelectionRange) -> Option<String> {
    let range = range.normalized();
    let start_row = range.start.row() as usize;
    let end_row = range.end.row() as usize;
    if start_row >= lines.len() {
        return None;
    }
    let end_row = end_row.min(lines.len().saturating_sub(1));
    let mut selected = Vec::with_capacity(end_row - start_row + 1);
    for (row, line) in lines[start_row..=end_row].iter().enumerate() {
        let absolute_row = start_row + row;
        let start_col = if absolute_row == start_row {
            range.start.col() as usize
        } else {
            0
        };
        let end_col = if absolute_row == end_row {
            range.end.col() as usize + 1
        } else {
            usize::MAX
        };
        selected.push(text_in_cell_range(line, start_col, end_col));
    }
    Some(selected.join("\n"))
}

fn text_in_cell_range(text: &str, start_col: usize, end_col: usize) -> String {
    let mut selected = String::new();
    let mut col: usize = 0;
    let mut previous_was_selected = false;
    for character in text.chars() {
        let width = UnicodeWidthChar::width(character).unwrap_or(0);
        if width == 0 {
            if previous_was_selected {
                selected.push(character);
            }
            continue;
        }
        let next_col = col.saturating_add(width);
        previous_was_selected = col < end_col && next_col > start_col;
        if previous_was_selected {
            selected.push(character);
        }
        col = next_col;
        if col >= end_col {
            break;
        }
    }
    selected
}

fn position_key(position: TerminalMousePosition) -> (u16, u16) {
    (position.row(), position.col())
}

#[cfg(test)]
#[path = "selection_tests.rs"]
mod tests;
