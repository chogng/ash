use std::ops::Range;

use ash_terminal::{ScreenBuffer, TerminalCore};

use crate::project_block_lines;

pub fn scroll_limit(terminal: &TerminalCore, capacity: usize) -> usize {
    if terminal.active_screen() == ScreenBuffer::Alternate {
        return 0;
    }
    if terminal.block_list().blocks().is_empty() {
        terminal.grid().scrollback_len()
    } else {
        project_block_lines(terminal).len().saturating_sub(capacity)
    }
}

pub fn visible_text_lines(
    terminal: &TerminalCore,
    capacity: usize,
    scroll_offset: usize,
) -> Vec<String> {
    if terminal.active_screen() == ScreenBuffer::Alternate
        || terminal.block_list().blocks().is_empty()
    {
        return terminal
            .grid()
            .viewport_lines(scroll_offset)
            .map(|line| line.text())
            .collect();
    }
    let lines = project_block_lines(terminal);
    lines[block_view_range(lines.len(), capacity, scroll_offset)]
        .iter()
        .map(|line| line.text.clone())
        .collect()
}

pub fn block_view_range(line_count: usize, capacity: usize, scroll_offset: usize) -> Range<usize> {
    let scroll_offset = scroll_offset.min(line_count.saturating_sub(capacity));
    let first = line_count.saturating_sub(capacity.saturating_add(scroll_offset));
    first..(first + capacity).min(line_count)
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;
