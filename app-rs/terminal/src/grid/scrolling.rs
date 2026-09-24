use super::{TerminalGrid, TerminalLine};

impl TerminalGrid {
    pub(crate) fn index(&mut self) {
        self.pending_wrap = false;
        if self.cursor_row == self.scroll_bottom - 1 {
            self.scroll_up(1);
        } else if self.cursor_row + 1 < self.size.rows as usize {
            self.cursor_row += 1;
        }
    }

    pub(crate) fn reverse_index(&mut self) {
        self.pending_wrap = false;
        if self.cursor_row == self.scroll_top {
            self.scroll_down(1);
        } else if self.cursor_row > 0 {
            self.cursor_row -= 1;
        }
    }

    pub(crate) fn scroll_up(&mut self, count: usize) {
        let count = count.min(self.scroll_bottom - self.scroll_top);
        let retains_scrollback = self.scroll_top == 0
            && self.scroll_bottom == self.lines.len()
            && self.scrollback_limit > 0;
        for _ in 0..count {
            let removed = self.lines.remove(self.scroll_top);
            if retains_scrollback {
                self.scrollback.push(removed);
                let excess = self.scrollback.len().saturating_sub(self.scrollback_limit);
                if excess > 0 {
                    self.scrollback.drain(..excess);
                }
            }
            self.lines.insert(
                self.scroll_bottom - 1,
                TerminalLine::blank(self.size.cols as usize, self.style),
            );
        }
    }

    pub(crate) fn scroll_down(&mut self, count: usize) {
        let count = count.min(self.scroll_bottom - self.scroll_top);
        for _ in 0..count {
            self.lines.remove(self.scroll_bottom - 1);
            self.lines.insert(
                self.scroll_top,
                TerminalLine::blank(self.size.cols as usize, self.style),
            );
        }
    }

    pub(crate) fn insert_lines(&mut self, count: usize) {
        if !self.cursor_inside_scroll_region() {
            return;
        }
        let count = count.min(self.scroll_bottom - self.cursor_row);
        for _ in 0..count {
            self.lines.remove(self.scroll_bottom - 1);
            self.lines.insert(
                self.cursor_row,
                TerminalLine::blank(self.size.cols as usize, self.style),
            );
        }
        self.pending_wrap = false;
    }

    pub(crate) fn delete_lines(&mut self, count: usize) {
        if !self.cursor_inside_scroll_region() {
            return;
        }
        let count = count.min(self.scroll_bottom - self.cursor_row);
        for _ in 0..count {
            self.lines.remove(self.cursor_row);
            self.lines.insert(
                self.scroll_bottom - 1,
                TerminalLine::blank(self.size.cols as usize, self.style),
            );
        }
        self.pending_wrap = false;
    }

    pub(crate) fn set_scroll_region(&mut self, top: usize, bottom: usize) {
        if top >= bottom || bottom > self.size.rows as usize {
            return;
        }
        self.scroll_top = top;
        self.scroll_bottom = bottom;
        self.cursor_position(0, 0);
    }

    pub(crate) fn enable_origin_mode(&mut self) {
        self.origin_mode = true;
        self.cursor_position(0, 0);
    }

    pub(crate) fn disable_origin_mode(&mut self) {
        self.origin_mode = false;
        self.cursor_position(0, 0);
    }

    pub(crate) fn cursor_up(&mut self, count: usize) {
        let lower_bound = if self.origin_mode { self.scroll_top } else { 0 };
        self.move_cursor(
            self.cursor_row.saturating_sub(count).max(lower_bound),
            self.cursor_col,
        );
    }

    pub(crate) fn cursor_down(&mut self, count: usize) {
        let upper_bound = if self.origin_mode {
            self.scroll_bottom - 1
        } else {
            self.size.rows as usize - 1
        };
        self.move_cursor(
            self.cursor_row.saturating_add(count).min(upper_bound),
            self.cursor_col,
        );
    }

    pub(crate) fn cursor_next_line(&mut self, count: usize) {
        self.cursor_down(count);
        self.carriage_return();
    }

    pub(crate) fn cursor_previous_line(&mut self, count: usize) {
        self.cursor_up(count);
        self.carriage_return();
    }

    pub(crate) fn cursor_horizontal_absolute(&mut self, col: usize) {
        self.move_cursor(self.cursor_row, col);
    }

    pub(crate) fn cursor_position(&mut self, row: usize, col: usize) {
        let (row, upper_bound) = if self.origin_mode {
            (self.scroll_top.saturating_add(row), self.scroll_bottom - 1)
        } else {
            (row, self.size.rows as usize - 1)
        };
        self.move_cursor(row.min(upper_bound), col);
    }

    pub(crate) fn reported_cursor(&self) -> (usize, usize) {
        let row = if self.origin_mode {
            self.cursor_row.saturating_sub(self.scroll_top)
        } else {
            self.cursor_row
        };
        (row, self.cursor_col)
    }

    fn cursor_inside_scroll_region(&self) -> bool {
        (self.scroll_top..self.scroll_bottom).contains(&self.cursor_row)
    }
}
