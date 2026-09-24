//! Unicode display-cell wrapping shared by chat_input layout and rendering.

use unicode_width::UnicodeWidthChar;

pub(super) const PROMPT_WIDTH: usize = 2;

#[derive(Debug, Eq, PartialEq)]
pub(super) struct WrappedInput {
    pub(super) lines: Vec<String>,
    pub(super) cursor_row: usize,
    pub(super) cursor_column: usize,
}

pub(super) fn wrap_input(
    input: &str,
    cursor_line: usize,
    cursor_width: usize,
    available_width: u16,
) -> WrappedInput {
    let capacity = usize::from(available_width)
        .saturating_sub(PROMPT_WIDTH)
        .max(1);
    let mut lines = Vec::new();
    let mut cursor_position = None;

    for (line_index, logical_line) in input.split('\n').enumerate() {
        let line_offset = lines.len();
        let (mut wrapped, local_cursor) = wrap_line(
            logical_line,
            capacity,
            (line_index == cursor_line).then_some(cursor_width),
        );
        if let Some((row, column)) = local_cursor {
            cursor_position = Some((line_offset + row, column));
        }
        lines.append(&mut wrapped);
    }

    let (cursor_row, cursor_column) = cursor_position.unwrap_or_else(|| {
        let row = lines.len().saturating_sub(1);
        let column = lines.last().map(|line| display_width(line)).unwrap_or(0);
        (row, column)
    });
    WrappedInput {
        lines,
        cursor_row,
        cursor_column,
    }
}

fn wrap_line(
    line: &str,
    capacity: usize,
    cursor_width: Option<usize>,
) -> (Vec<String>, Option<(usize, usize)>) {
    let mut lines = vec![String::new()];
    let mut widths = vec![0_usize];
    let mut consumed_width = 0_usize;
    let mut cursor_position = cursor_width.filter(|width| *width == 0).map(|_| (0, 0));

    for character in line.chars() {
        let character_width = character.width().unwrap_or(0);
        let current_width = *widths.last().unwrap();
        if character_width > 0
            && current_width > 0
            && current_width.saturating_add(character_width) > capacity
        {
            lines.push(String::new());
            widths.push(0);
        }
        lines.last_mut().unwrap().push(character);
        let wrapped_width = widths.last().unwrap().saturating_add(character_width);
        *widths.last_mut().unwrap() = wrapped_width;
        consumed_width = consumed_width.saturating_add(character_width);
        if cursor_width == Some(consumed_width) {
            cursor_position = Some((lines.len() - 1, *widths.last().unwrap()));
        }
    }

    if let Some((row, column)) = cursor_position
        && column >= capacity
    {
        if row + 1 == lines.len() {
            lines.push(String::new());
        }
        cursor_position = Some((row + 1, 0));
    }
    (lines, cursor_position)
}

fn display_width(text: &str) -> usize {
    text.chars()
        .map(|character| character.width().unwrap_or(0))
        .sum()
}

#[cfg(test)]
#[path = "wrap_tests.rs"]
mod tests;
