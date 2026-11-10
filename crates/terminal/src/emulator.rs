use vte::{Params, Parser, Perform};

use crate::GridSize;
use crate::ScreenBuffer;
use crate::TerminalGrid;
use crate::TerminalModes;
use crate::screen::ModeChange;
use crate::screen::TerminalScreen;

struct GridPerformer<'a> {
    screen: &'a mut TerminalScreen,
    replies: &'a mut Vec<u8>,
    title: &'a mut Option<String>,
}

impl Perform for GridPerformer<'_> {
    fn print(&mut self, character: char) {
        self.screen.grid_mut().print(character);
    }

    fn execute(&mut self, byte: u8) {
        let grid = self.screen.grid_mut();
        match byte {
            b'\x08' => grid.backspace(),
            b'\t' => grid.tab(),
            b'\n' | b'\x0b' | b'\x0c' => grid.index(),
            b'\r' => grid.carriage_return(),
            _ => {}
        }
    }

    fn csi_dispatch(&mut self, params: &Params, intermediates: &[u8], ignore: bool, action: char) {
        if ignore {
            return;
        }
        if self.dispatch_query(params, intermediates, action) {
            return;
        }
        if intermediates == b"?" && matches!(action, 'h' | 'l') {
            let change = if action == 'h' {
                ModeChange::Set
            } else {
                ModeChange::Reset
            };
            for mode in flat_params(params) {
                self.screen.apply_private_mode(mode, change);
            }
            return;
        }
        if !intermediates.is_empty() {
            return;
        }
        let grid = self.screen.grid_mut();
        let (row, col) = grid.cursor();
        match action {
            'A' => grid.cursor_up(param(params, 0, 1)),
            'B' => grid.cursor_down(param(params, 0, 1)),
            'C' => grid.move_cursor(row, col.saturating_add(param(params, 0, 1))),
            'D' => grid.move_cursor(row, col.saturating_sub(param(params, 0, 1))),
            'E' => grid.cursor_next_line(param(params, 0, 1)),
            'F' => grid.cursor_previous_line(param(params, 0, 1)),
            'G' => grid.cursor_horizontal_absolute(param(params, 0, 1) - 1),
            'H' | 'f' => {
                grid.cursor_position(param(params, 0, 1) - 1, param(params, 1, 1) - 1);
            }
            'J' => grid.erase_display(param(params, 0, 0) as u16),
            'K' => grid.erase_line(param(params, 0, 0) as u16),
            '@' => grid.insert_blank_cells(param(params, 0, 1)),
            'L' => grid.insert_lines(param(params, 0, 1)),
            'M' => grid.delete_lines(param(params, 0, 1)),
            'P' => grid.delete_cells(param(params, 0, 1)),
            'X' => grid.erase_cells(param(params, 0, 1)),
            'S' => grid.scroll_up(param(params, 0, 1)),
            'T' => grid.scroll_down(param(params, 0, 1)),
            'm' => grid.set_graphics_rendition(&flat_params(params)),
            'r' => {
                let top = param(params, 0, 1) - 1;
                let bottom = param(params, 1, grid.size().rows());
                grid.set_scroll_region(top, bottom);
            }
            's' => grid.save_cursor(),
            'u' => grid.restore_cursor(),
            _ => {}
        }
    }

    fn esc_dispatch(&mut self, _intermediates: &[u8], ignore: bool, byte: u8) {
        if ignore {
            return;
        }
        match byte {
            b'7' => self.screen.grid_mut().save_cursor(),
            b'8' => self.screen.grid_mut().restore_cursor(),
            b'D' => self.screen.grid_mut().index(),
            b'E' => {
                self.screen.grid_mut().carriage_return();
                self.screen.grid_mut().index();
            }
            b'M' => self.screen.grid_mut().reverse_index(),
            b'c' => self.screen.reset(),
            _ => {}
        }
    }

    fn osc_dispatch(&mut self, params: &[&[u8]], _bell_terminated: bool) {
        let Some(command) = params.first() else {
            return;
        };
        if !matches!(*command, b"0" | b"2") {
            return;
        }
        let raw_title = params
            .iter()
            .skip(1)
            .flat_map(|part| part.iter().copied().chain(std::iter::once(b';')))
            .collect::<Vec<_>>();
        let raw_title = raw_title.strip_suffix(b";").unwrap_or(&raw_title);
        let title = String::from_utf8_lossy(raw_title)
            .chars()
            .filter(|character| !character.is_control())
            .take(256)
            .collect::<String>();
        *self.title = (!title.is_empty()).then_some(title);
    }
}

impl GridPerformer<'_> {
    fn dispatch_query(&mut self, params: &Params, intermediates: &[u8], action: char) -> bool {
        let query = raw_param(params, 0);
        match (intermediates, action, query) {
            (b"", 'c', 0) => self.replies.extend_from_slice(b"\x1b[?1;2c"),
            (b">", 'c', 0) => self.replies.extend_from_slice(b"\x1b[>0;1;0c"),
            (b"", 'n', 5) => self.replies.extend_from_slice(b"\x1b[0n"),
            (b"", 'n', 6) => self.reply_cursor_position(false),
            (b"?", 'n', 6) => self.reply_cursor_position(true),
            _ => return false,
        }
        true
    }

    fn reply_cursor_position(&mut self, private: bool) {
        let (row, col) = self.screen.grid().reported_cursor();
        let private_marker = if private { "?" } else { "" };
        self.replies
            .extend_from_slice(format!("\x1b[{private_marker}{};{}R", row + 1, col + 1).as_bytes());
    }
}

fn flat_params(params: &Params) -> Vec<u16> {
    params
        .iter()
        .map(|param| param.first().copied().unwrap_or(0))
        .collect()
}

fn param(params: &Params, index: usize, default: u16) -> usize {
    params
        .iter()
        .nth(index)
        .and_then(|param| param.first())
        .copied()
        .filter(|value| *value != 0)
        .unwrap_or(default) as usize
}

fn raw_param(params: &Params, index: usize) -> u16 {
    params
        .iter()
        .nth(index)
        .and_then(|param| param.first())
        .copied()
        .unwrap_or(0)
}

/// Parses PTY output into screen state and terminal query replies.
pub struct TerminalCore {
    parser: Parser,
    screen: TerminalScreen,
    reply_bytes: Vec<u8>,
    title: Option<String>,
}

impl TerminalCore {
    pub fn new(size: GridSize) -> Self {
        Self {
            parser: Parser::new(),
            screen: TerminalScreen::new(size),
            reply_bytes: Vec::new(),
            title: None,
        }
    }

    pub const fn grid(&self) -> &TerminalGrid {
        self.screen.grid()
    }

    pub const fn active_screen(&self) -> ScreenBuffer {
        self.screen.active()
    }

    pub const fn modes(&self) -> TerminalModes {
        self.screen.modes()
    }

    pub fn title(&self) -> Option<&str> {
        self.title.as_deref()
    }

    pub fn resize(&mut self, size: GridSize) {
        self.screen.resize(size);
    }

    pub fn process_output(&mut self, bytes: &[u8]) {
        let mut performer = GridPerformer {
            screen: &mut self.screen,
            replies: &mut self.reply_bytes,
            title: &mut self.title,
        };
        self.parser.advance(&mut performer, bytes);
    }

    pub fn take_reply_bytes(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.reply_bytes)
    }
}

#[cfg(test)]
#[path = "grid_tests.rs"]
mod tests;
