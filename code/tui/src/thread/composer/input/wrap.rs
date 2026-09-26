//! Unicode display-cell wrapping shared by chat_input layout and rendering.

use std::ops::Range;
use unicode_width::UnicodeWidthChar;

pub(super) const PROMPT_WIDTH: usize = 2;

#[derive(Debug, Eq, PartialEq)]
pub(super) struct WrappedInput {
    pub(super) lines: Vec<String>,
    pub(super) byte_ranges: Vec<Range<usize>>,
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
    let mut byte_ranges = Vec::new();
    let mut cursor_position = None;
    let mut logical_start = 0;

    for (line_index, logical_line) in input.split('\n').enumerate() {
        let line_offset = lines.len();
        let (mut wrapped, mut ranges, local_cursor) = wrap_line(
            logical_line,
            capacity,
            (line_index == cursor_line).then_some(cursor_width),
        );
        if let Some((row, column)) = local_cursor {
            cursor_position = Some((line_offset + row, column));
        }
        lines.append(&mut wrapped);
        for range in &mut ranges {
            range.start += logical_start;
            range.end += logical_start;
        }
        byte_ranges.append(&mut ranges);
        logical_start += logical_line.len() + 1;
    }

    let (cursor_row, cursor_column) = cursor_position.unwrap_or_else(|| {
        let row = lines.len().saturating_sub(1);
        let column = lines.last().map(|line| display_width(line)).unwrap_or(0);
        (row, column)
    });
    WrappedInput {
        lines,
        byte_ranges,
        cursor_row,
        cursor_column,
    }
}

fn wrap_line(
    line: &str,
    capacity: usize,
    cursor_width: Option<usize>,
) -> (Vec<String>, Vec<Range<usize>>, Option<(usize, usize)>) {
    let mut lines = vec![String::new()];
    let mut ranges = vec![0..0];
    let mut widths = vec![0_usize];
    let mut consumed_width = 0_usize;
    let mut cursor_position = cursor_width.filter(|width| *width == 0).map(|_| (0, 0));

    for (byte_index, character) in line.char_indices() {
        let character_width = character.width().unwrap_or(0);
        let current_width = *widths.last().unwrap();
        if character_width > 0
            && current_width > 0
            && current_width.saturating_add(character_width) > capacity
        {
            lines.push(String::new());
            ranges.push(byte_index..byte_index);
            widths.push(0);
        }
        lines.last_mut().unwrap().push(character);
        ranges.last_mut().unwrap().end = byte_index + character.len_utf8();
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
            ranges.push(line.len()..line.len());
        }
        cursor_position = Some((row + 1, 0));
    }
    (lines, ranges, cursor_position)
}

fn display_width(text: &str) -> usize {
    text.chars()
        .map(|character| character.width().unwrap_or(0))
        .sum()
}

#[cfg(test)]
#[path = "wrap_tests.rs"]
mod tests;
