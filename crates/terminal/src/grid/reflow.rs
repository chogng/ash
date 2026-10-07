use super::{Cell, CellStyle, GridSize, TerminalGrid, TerminalLine};

struct LogicalLine {
    cells: Vec<Cell>,
    cursor: Option<LogicalCursor>,
}

#[derive(Clone, Copy)]
struct LogicalCursor {
    offset: usize,
    pending_wrap: bool,
}

struct PackedLine {
    line: TerminalLine,
    logical_start: usize,
    logical_end: usize,
}

impl TerminalGrid {
    pub fn resize(&mut self, size: GridSize) {
        if self.size == size {
            return;
        }
        let full_scroll_region =
            self.scroll_top == 0 && self.scroll_bottom == self.size.rows as usize;
        if self.scrollback_limit > 0 && full_scroll_region {
            self.resize_with_reflow(size);
        } else {
            self.resize_fixed(size, full_scroll_region);
        }
    }

    fn resize_with_reflow(&mut self, size: GridSize) {
        let logical_lines = self.logical_lines();
        let mut reflowed = Vec::new();
        let mut cursor = None;
        for logical in logical_lines {
            let packed = pack_logical_line(logical, size.cols as usize, self.style);
            if let Some((row, col, pending_wrap)) = packed.cursor {
                cursor = Some((reflowed.len() + row, col, pending_wrap));
            }
            reflowed.extend(packed.lines.into_iter().map(|line| line.line));
        }
        if reflowed.is_empty() {
            reflowed.push(TerminalLine::blank(size.cols as usize, self.style));
        }

        let (cursor_absolute_row, cursor_col, pending_wrap) =
            cursor.unwrap_or((reflowed.len().saturating_sub(1), 0, false));
        let screen_rows = size.rows as usize;
        let mut screen_start = reflowed.len().saturating_sub(screen_rows);
        if cursor_absolute_row < screen_start {
            screen_start = cursor_absolute_row;
        } else if cursor_absolute_row >= screen_start + screen_rows {
            screen_start = cursor_absolute_row + 1 - screen_rows;
        }
        let screen_end = (screen_start + screen_rows).min(reflowed.len());
        let mut lines = reflowed[screen_start..screen_end].to_vec();
        lines.resize_with(screen_rows, || {
            TerminalLine::blank(size.cols as usize, self.style)
        });
        let mut scrollback = reflowed[..screen_start].to_vec();
        let excess = scrollback.len().saturating_sub(self.scrollback_limit);
        if excess > 0 {
            scrollback.drain(..excess);
        }

        self.size = size;
        self.lines = lines;
        self.scrollback = scrollback;
        self.cursor_row = cursor_absolute_row
            .saturating_sub(screen_start)
            .min(screen_rows - 1);
        self.cursor_col = cursor_col.min(size.cols as usize - 1);
        self.pending_wrap = pending_wrap;
        self.saved_cursor.0 = self.saved_cursor.0.min(screen_rows - 1);
        self.saved_cursor.1 = self.saved_cursor.1.min(size.cols as usize - 1);
        self.scroll_top = 0;
        self.scroll_bottom = screen_rows;
    }

    fn resize_fixed(&mut self, size: GridSize, full_scroll_region: bool) {
        let mut lines =
            vec![TerminalLine::blank(size.cols as usize, self.style); size.rows as usize];
        let copy_rows = lines.len().min(self.lines.len());
        let copy_cols = size.cols as usize;
        for (target, source) in lines.iter_mut().zip(&self.lines).take(copy_rows) {
            for (target_cell, source_cell) in
                target.cells.iter_mut().zip(&source.cells).take(copy_cols)
            {
                *target_cell = source_cell.clone();
            }
            target.wrapped = source.wrapped && size.cols == self.size.cols;
        }
        for line in &mut self.scrollback {
            line.resize(size.cols as usize, self.style);
        }
        self.size = size;
        self.lines = lines;
        self.cursor_row = self.cursor_row.min(size.rows as usize - 1);
        self.cursor_col = self.cursor_col.min(size.cols as usize - 1);
        self.saved_cursor.0 = self.saved_cursor.0.min(size.rows as usize - 1);
        self.saved_cursor.1 = self.saved_cursor.1.min(size.cols as usize - 1);
        self.pending_wrap = false;
        if full_scroll_region {
            self.scroll_top = 0;
            self.scroll_bottom = size.rows as usize;
        } else {
            self.scroll_top = self.scroll_top.min(size.rows as usize - 1);
            self.scroll_bottom = self.scroll_bottom.min(size.rows as usize);
            if self.scroll_top >= self.scroll_bottom {
                self.scroll_top = 0;
                self.scroll_bottom = size.rows as usize;
            }
        }
        if self.origin_mode {
            self.cursor_row = self
                .cursor_row
                .clamp(self.scroll_top, self.scroll_bottom - 1);
        }
    }

    fn logical_lines(&self) -> Vec<LogicalLine> {
        let cursor_physical_row = self.scrollback.len() + self.cursor_row;
        let physical_lines = self
            .scrollback
            .iter()
            .chain(&self.lines)
            .collect::<Vec<_>>();
        let last_content_row = physical_lines
            .iter()
            .rposition(|line| line.wrapped || meaningful_cell_count(line) > 0)
            .unwrap_or(0);
        let last_relevant_row = last_content_row.max(cursor_physical_row);
        let mut logical_lines = Vec::new();
        let mut cells = Vec::new();
        let mut cursor = None;
        for (row, line) in physical_lines
            .into_iter()
            .take(last_relevant_row + 1)
            .enumerate()
        {
            let cursor_on_line = row == cursor_physical_row;
            let cursor_offset = if cursor_on_line {
                Some(cells.len() + self.cursor_col + usize::from(self.pending_wrap))
            } else {
                None
            };
            let used = if line.wrapped {
                line.cells.len()
            } else {
                meaningful_cell_count(line)
            }
            .max(
                cursor_offset
                    .map(|offset| offset.saturating_sub(cells.len()))
                    .unwrap_or(0),
            );
            if let Some(offset) = cursor_offset {
                cursor = Some(LogicalCursor {
                    offset,
                    pending_wrap: self.pending_wrap,
                });
            }
            cells.extend_from_slice(&line.cells[..used.min(line.cells.len())]);
            if !line.wrapped {
                logical_lines.push(LogicalLine {
                    cells: std::mem::take(&mut cells),
                    cursor: cursor.take(),
                });
            }
        }
        if !cells.is_empty() || cursor.is_some() {
            logical_lines.push(LogicalLine { cells, cursor });
        }
        logical_lines
    }
}

struct PackedLogicalLine {
    lines: Vec<PackedLine>,
    cursor: Option<(usize, usize, bool)>,
}

fn pack_logical_line(logical: LogicalLine, cols: usize, style: CellStyle) -> PackedLogicalLine {
    let mut lines = Vec::new();
    if logical.cells.is_empty() {
        lines.push(PackedLine {
            line: TerminalLine::blank(cols, style),
            logical_start: 0,
            logical_end: 0,
        });
    } else {
        let mut start = 0;
        while start < logical.cells.len() {
            let mut end = (start + cols).min(logical.cells.len());
            if end < logical.cells.len() && logical.cells[end].continuation {
                end = end.saturating_sub(1);
            }
            let (cells, consumed) = if end == start {
                (
                    vec![logical.cells[start].clone()],
                    (start + 2).min(logical.cells.len()),
                )
            } else {
                (logical.cells[start..end].to_vec(), end)
            };
            let mut line = TerminalLine::blank(cols, style);
            for (target, source) in line.cells.iter_mut().zip(cells) {
                *target = source;
            }
            lines.push(PackedLine {
                line,
                logical_start: start,
                logical_end: consumed,
            });
            start = consumed;
        }
    }
    let last = lines.len().saturating_sub(1);
    for (index, line) in lines.iter_mut().enumerate() {
        line.line.wrapped = index < last;
    }
    let cursor = logical
        .cursor
        .map(|cursor| locate_cursor(&lines, cursor, cols));
    PackedLogicalLine { lines, cursor }
}

fn locate_cursor(lines: &[PackedLine], cursor: LogicalCursor, cols: usize) -> (usize, usize, bool) {
    if cursor.pending_wrap
        && let Some((row, line)) = lines
            .iter()
            .enumerate()
            .find(|(_, line)| line.logical_end == cursor.offset)
    {
        let width = line.logical_end.saturating_sub(line.logical_start);
        return if width >= cols {
            (row, cols - 1, true)
        } else {
            (row, width, false)
        };
    }
    let row = lines
        .iter()
        .position(|line| cursor.offset >= line.logical_start && cursor.offset < line.logical_end)
        .unwrap_or_else(|| lines.len().saturating_sub(1));
    let col = cursor
        .offset
        .saturating_sub(lines[row].logical_start)
        .min(cols - 1);
    (row, col, false)
}

fn meaningful_cell_count(line: &TerminalLine) -> usize {
    line.cells
        .iter()
        .rposition(|cell| {
            !cell.text.is_empty() || cell.continuation || cell.style != CellStyle::default()
        })
        .map_or(0, |index| index + 1)
}
