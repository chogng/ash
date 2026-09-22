use unicode_segmentation::UnicodeSegmentation;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

mod reflow;
mod scrolling;

const DEFAULT_SCROLLBACK_LINES: usize = 10_000;

/// Terminal dimensions expressed in character cells.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GridSize {
    rows: u16,
    cols: u16,
}

impl GridSize {
    pub const fn new(rows: u16, cols: u16) -> Self {
        Self {
            rows: if rows == 0 { 1 } else { rows },
            cols: if cols == 0 { 1 } else { cols },
        }
    }

    pub const fn rows(self) -> u16 {
        self.rows
    }

    pub const fn cols(self) -> u16 {
        self.cols
    }
}

impl Default for GridSize {
    fn default() -> Self {
        Self::new(24, 80)
    }
}

/// Color selected by terminal escape sequences.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum TerminalColor {
    #[default]
    Default,
    Indexed(u8),
    Rgb(u8, u8, u8),
}

/// Visual attributes applied to one terminal cell.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CellStyle {
    pub foreground: TerminalColor,
    pub background: TerminalColor,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub inverse: bool,
}

/// One terminal cell. Wide-character continuation cells have empty text.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Cell {
    text: String,
    style: CellStyle,
    continuation: bool,
}

impl Cell {
    pub fn text(&self) -> &str {
        &self.text
    }

    pub const fn style(&self) -> CellStyle {
        self.style
    }

    pub const fn is_continuation(&self) -> bool {
        self.continuation
    }

    fn blank(style: CellStyle) -> Self {
        Self {
            style,
            ..Self::default()
        }
    }
}

/// One row in the terminal grid.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalLine {
    cells: Vec<Cell>,
    wrapped: bool,
}

impl TerminalLine {
    pub fn cells(&self) -> &[Cell] {
        &self.cells
    }

    pub fn text(&self) -> String {
        let mut text = String::new();
        for cell in &self.cells {
            if !cell.continuation {
                if cell.text.is_empty() {
                    text.push(' ');
                } else {
                    text.push_str(&cell.text);
                }
            }
        }
        text.trim_end().to_string()
    }

    pub const fn is_wrapped(&self) -> bool {
        self.wrapped
    }

    fn blank(cols: usize, style: CellStyle) -> Self {
        Self {
            cells: vec![Cell::blank(style); cols],
            wrapped: false,
        }
    }

    fn resize(&mut self, cols: usize, style: CellStyle) {
        self.cells.resize_with(cols, || Cell::blank(style));
        self.cells.truncate(cols);
    }
}

/// Mutable VT-style screen grid with cursor, scrolling, erase, and SGR state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalGrid {
    size: GridSize,
    lines: Vec<TerminalLine>,
    scrollback: Vec<TerminalLine>,
    scrollback_limit: usize,
    cursor_row: usize,
    cursor_col: usize,
    saved_cursor: (usize, usize),
    style: CellStyle,
    pending_wrap: bool,
    scroll_top: usize,
    scroll_bottom: usize,
    origin_mode: bool,
}

impl TerminalGrid {
    pub fn new(size: GridSize) -> Self {
        Self::with_scrollback_limit(size, DEFAULT_SCROLLBACK_LINES)
    }

    pub(crate) fn transient(size: GridSize) -> Self {
        Self::with_scrollback_limit(size, 0)
    }

    fn with_scrollback_limit(size: GridSize, scrollback_limit: usize) -> Self {
        Self {
            size,
            lines: vec![
                TerminalLine::blank(size.cols as usize, CellStyle::default());
                size.rows as usize
            ],
            scrollback: Vec::new(),
            scrollback_limit,
            cursor_row: 0,
            cursor_col: 0,
            saved_cursor: (0, 0),
            style: CellStyle::default(),
            pending_wrap: false,
            scroll_top: 0,
            scroll_bottom: size.rows as usize,
            origin_mode: false,
        }
    }

    pub const fn size(&self) -> GridSize {
        self.size
    }

    pub fn lines(&self) -> &[TerminalLine] {
        &self.lines
    }

    /// Rows evicted from the top of a full-screen scrolling primary grid.
    pub fn scrollback_lines(&self) -> &[TerminalLine] {
        &self.scrollback
    }

    pub const fn scrollback_len(&self) -> usize {
        self.scrollback.len()
    }

    /// Returns one screenful ending `scroll_offset` rows above the live viewport.
    pub fn viewport_lines(&self, scroll_offset: usize) -> impl Iterator<Item = &TerminalLine> {
        let scroll_offset = scroll_offset.min(self.scrollback.len());
        let start = self.scrollback.len().saturating_sub(scroll_offset);
        self.scrollback
            .iter()
            .chain(&self.lines)
            .skip(start)
            .take(self.lines.len())
    }

    pub const fn cursor(&self) -> (usize, usize) {
        (self.cursor_row, self.cursor_col)
    }

    pub(crate) fn print(&mut self, character: char) {
        if self.extend_previous_grapheme(character) {
            return;
        }
        let width = UnicodeWidthChar::width(character).unwrap_or(0);
        if width == 0 {
            return;
        }
        let width = width.min(2);
        if self.pending_wrap || self.cursor_col + width > self.size.cols as usize {
            self.lines[self.cursor_row].wrapped = true;
            self.cursor_col = 0;
            self.index();
        }
        self.clear_wide_cell_at_cursor();
        self.lines[self.cursor_row].cells[self.cursor_col] = Cell {
            text: character.to_string(),
            style: self.style,
            continuation: false,
        };
        if width == 2 && self.cursor_col + 1 < self.size.cols as usize {
            self.lines[self.cursor_row].cells[self.cursor_col + 1] = Cell {
                text: String::new(),
                style: self.style,
                continuation: true,
            };
        }
        self.cursor_col += width;
        self.pending_wrap = self.cursor_col >= self.size.cols as usize;
        if self.pending_wrap {
            self.cursor_col = self.size.cols as usize - 1;
        }
    }

    fn extend_previous_grapheme(&mut self, character: char) -> bool {
        let Some(mut col) = (if self.pending_wrap {
            Some(self.cursor_col)
        } else {
            self.cursor_col.checked_sub(1)
        }) else {
            return false;
        };
        while self.lines[self.cursor_row].cells[col].continuation {
            let Some(previous_col) = col.checked_sub(1) else {
                return false;
            };
            col = previous_col;
        }
        let cell = &self.lines[self.cursor_row].cells[col];
        if cell.text.is_empty() {
            return false;
        }
        let mut candidate = cell.text.clone();
        candidate.push(character);
        if candidate.graphemes(true).count() != 1 {
            return false;
        }
        let old_width = if col + 1 < self.size.cols as usize
            && self.lines[self.cursor_row].cells[col + 1].continuation
        {
            2
        } else {
            1
        };
        let new_width = UnicodeWidthStr::width(candidate.as_str()).clamp(1, 2);
        if new_width > old_width && col + new_width > self.size.cols as usize {
            return false;
        }
        let style = cell.style;
        self.lines[self.cursor_row].cells[col].text = candidate;
        if new_width != old_width {
            if new_width == 2 {
                self.lines[self.cursor_row].cells[col + 1] = Cell {
                    text: String::new(),
                    style,
                    continuation: true,
                };
            } else {
                self.lines[self.cursor_row].cells[col + 1] = Cell::blank(style);
            }
            let next_col = col + new_width;
            self.pending_wrap = next_col >= self.size.cols as usize;
            self.cursor_col = if self.pending_wrap {
                self.size.cols as usize - 1
            } else {
                next_col
            };
        }
        true
    }

    fn clear_wide_cell_at_cursor(&mut self) {
        let line = &mut self.lines[self.cursor_row].cells;
        if line[self.cursor_col].continuation && self.cursor_col > 0 {
            line[self.cursor_col - 1] = Cell::blank(self.style);
        }
        if self.cursor_col + 1 < line.len() && line[self.cursor_col + 1].continuation {
            line[self.cursor_col + 1] = Cell::blank(self.style);
        }
    }

    pub(crate) fn carriage_return(&mut self) {
        self.cursor_col = 0;
        self.pending_wrap = false;
    }

    pub(crate) fn move_cursor(&mut self, row: usize, col: usize) {
        self.cursor_row = row.min(self.size.rows as usize - 1);
        self.cursor_col = col.min(self.size.cols as usize - 1);
        self.pending_wrap = false;
    }

    pub(crate) fn erase_line(&mut self, mode: u16) {
        let cols = self.size.cols as usize;
        let range = match mode {
            1 => 0..self.cursor_col.saturating_add(1),
            2 => 0..cols,
            _ => self.cursor_col..cols,
        };
        for cell in &mut self.lines[self.cursor_row].cells[range] {
            *cell = Cell::blank(self.style);
        }
    }

    pub(crate) fn erase_display(&mut self, mode: u16) {
        match mode {
            1 => {
                for row in 0..self.cursor_row {
                    self.lines[row] = TerminalLine::blank(self.size.cols as usize, self.style);
                }
                self.erase_line(1);
            }
            2 => {
                self.lines[self.cursor_row].wrapped = false;
                for line in &mut self.lines {
                    *line = TerminalLine::blank(self.size.cols as usize, self.style);
                }
            }
            3 => self.scrollback.clear(),
            _ => {
                self.erase_line(0);
                for row in self.cursor_row + 1..self.lines.len() {
                    self.lines[row] = TerminalLine::blank(self.size.cols as usize, self.style);
                }
            }
        }
    }

    pub(crate) fn insert_blank_cells(&mut self, count: usize) {
        let line = &mut self.lines[self.cursor_row].cells;
        let count = count.min(line.len().saturating_sub(self.cursor_col));
        for _ in 0..count {
            line.insert(self.cursor_col, Cell::blank(self.style));
            line.pop();
        }
    }

    pub(crate) fn delete_cells(&mut self, count: usize) {
        let line = &mut self.lines[self.cursor_row].cells;
        let count = count.min(line.len().saturating_sub(self.cursor_col));
        for _ in 0..count {
            line.remove(self.cursor_col);
            line.push(Cell::blank(self.style));
        }
    }

    pub(crate) fn erase_cells(&mut self, count: usize) {
        let end = (self.cursor_col + count).min(self.size.cols as usize);
        for cell in &mut self.lines[self.cursor_row].cells[self.cursor_col..end] {
            *cell = Cell::blank(self.style);
        }
    }

    pub(crate) fn reset(&mut self) {
        *self = Self::with_scrollback_limit(self.size, self.scrollback_limit);
    }

    pub(crate) fn set_graphics_rendition(&mut self, values: &[u16]) {
        let values = if values.is_empty() { &[0][..] } else { values };
        let mut index = 0;
        while index < values.len() {
            match values[index] {
                0 => self.style = CellStyle::default(),
                1 => self.style.bold = true,
                3 => self.style.italic = true,
                4 => self.style.underline = true,
                7 => self.style.inverse = true,
                22 => self.style.bold = false,
                23 => self.style.italic = false,
                24 => self.style.underline = false,
                27 => self.style.inverse = false,
                30..=37 => {
                    self.style.foreground = TerminalColor::Indexed((values[index] - 30) as u8)
                }
                39 => self.style.foreground = TerminalColor::Default,
                40..=47 => {
                    self.style.background = TerminalColor::Indexed((values[index] - 40) as u8)
                }
                49 => self.style.background = TerminalColor::Default,
                90..=97 => {
                    self.style.foreground = TerminalColor::Indexed((values[index] - 82) as u8)
                }
                100..=107 => {
                    self.style.background = TerminalColor::Indexed((values[index] - 92) as u8)
                }
                38 | 48 => {
                    let foreground = values[index] == 38;
                    if values.get(index + 1) == Some(&5)
                        && let Some(color) = values.get(index + 2)
                    {
                        set_extended_color(
                            &mut self.style,
                            foreground,
                            TerminalColor::Indexed(*color as u8),
                        );
                        index += 2;
                    } else if values.get(index + 1) == Some(&2)
                        && let (Some(red), Some(green), Some(blue)) = (
                            values.get(index + 2),
                            values.get(index + 3),
                            values.get(index + 4),
                        )
                    {
                        set_extended_color(
                            &mut self.style,
                            foreground,
                            TerminalColor::Rgb(*red as u8, *green as u8, *blue as u8),
                        );
                        index += 4;
                    }
                }
                _ => {}
            }
            index += 1;
        }
    }

    pub(crate) fn backspace(&mut self) {
        self.cursor_col = self.cursor_col.saturating_sub(1);
        self.pending_wrap = false;
    }

    pub(crate) fn tab(&mut self) {
        let next = ((self.cursor_col / 8) + 1) * 8;
        self.cursor_col = next.min(self.size.cols as usize - 1);
        self.pending_wrap = false;
    }

    pub(crate) fn save_cursor(&mut self) {
        self.saved_cursor = self.cursor();
    }

    pub(crate) fn restore_cursor(&mut self) {
        self.move_cursor(self.saved_cursor.0, self.saved_cursor.1);
    }
}

fn set_extended_color(style: &mut CellStyle, foreground: bool, color: TerminalColor) {
    if foreground {
        style.foreground = color;
    } else {
        style.background = color;
    }
}
