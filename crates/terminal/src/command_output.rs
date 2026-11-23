//! Replays row-local terminal controls in command output before transcript layout.

use crate::CellStyle;
use crate::GridSize;
use crate::TerminalColor;
use crate::TerminalGrid;
use std::borrow::Cow;
use std::fmt::Write as _;
use unicode_width::UnicodeWidthChar;
use vte::Params;
use vte::Parser;
use vte::Perform;

/// Resolves carriage returns and erase-line sequences without interpreting screen-wide movement.
/// Ordinary output stays borrowed. The column limit bounds the storage needed for a redrawn row.
pub fn resolve_command_output(input: &str, column_limit: u16) -> Cow<'_, str> {
    if !input.split('\n').any(needs_redraw) {
        return Cow::Borrowed(input);
    }

    let mut output = String::with_capacity(input.len());
    let mut rendition = TerminalGrid::transient(GridSize::new(1, 1));
    for (index, line) in input.split('\n').enumerate() {
        if index != 0 {
            output.push('\n');
        }
        if needs_redraw(line) {
            let columns = line
                .split('\r')
                .map(|write| write.len().saturating_add(7 * write.matches('\t').count()))
                .max()
                .unwrap_or_default()
                .clamp(2, usize::from(column_limit.max(2)));
            // The extra cell absorbs the cursor at the edge without wrapping a wide character.
            let mut grid =
                TerminalGrid::transient(GridSize::new(1, (columns as u16).saturating_add(1)));
            let initial_style = rendition.style();
            grid.set_style(initial_style);
            Parser::new().advance(&mut OutputRow(&mut grid), line.as_bytes());
            write_row(&grid, initial_style, &mut output);
            rendition.set_style(grid.style());
        } else {
            if line.contains('\x1b') {
                Parser::new().advance(&mut Rendition(&mut rendition), line.as_bytes());
            }
            output.push_str(line);
        }
    }
    if rendition.style() != CellStyle::default() {
        output.push_str("\x1b[0m");
    }
    Cow::Owned(output)
}

fn needs_redraw(line: &str) -> bool {
    let line = line.strip_suffix('\r').unwrap_or(line);
    line.contains('\r')
        || line.match_indices("\x1b[").any(|(start, _)| {
            line.as_bytes()[start + 2..]
                .iter()
                .find(|&&byte| !(0x20..=0x3f).contains(&byte))
                == Some(&b'K')
        })
}

struct OutputRow<'a>(&'a mut TerminalGrid);

impl Perform for OutputRow<'_> {
    fn print(&mut self, character: char) {
        let col = self.0.cursor().1;
        if col + character.width().unwrap_or_default() < usize::from(self.0.size().cols()) {
            self.0.print(character);
        }
    }

    fn execute(&mut self, byte: u8) {
        match byte {
            b'\r' => self.0.carriage_return(),
            b'\x08' => self.0.backspace(),
            b'\t' => self.0.tab(),
            _ => {}
        }
    }

    fn csi_dispatch(&mut self, params: &Params, intermediates: &[u8], ignore: bool, action: char) {
        if ignore || !intermediates.is_empty() {
            return;
        }
        match action {
            'K' => self.0.erase_line(crate::emulator::raw_param(params, 0)),
            'm' => self
                .0
                .set_graphics_rendition(&crate::emulator::flat_params(params)),
            _ => {}
        }
    }
}

struct Rendition<'a>(&'a mut TerminalGrid);

impl Perform for Rendition<'_> {
    fn csi_dispatch(&mut self, params: &Params, intermediates: &[u8], ignore: bool, action: char) {
        if !ignore && intermediates.is_empty() && action == 'm' {
            self.0
                .set_graphics_rendition(&crate::emulator::flat_params(params));
        }
    }
}

fn write_row(grid: &TerminalGrid, initial: CellStyle, output: &mut String) {
    let cells = grid.lines()[0].cells();
    let end = cells
        .iter()
        .rposition(|cell| !cell.text().is_empty())
        .map_or(0, |last| last + 1);
    let mut active = initial;
    for cell in &cells[..end] {
        if cell.is_continuation() {
            continue;
        }
        let next = cell.style();
        if next != active {
            write_style(output, next);
            active = next;
        }
        if cell.text().is_empty() {
            output.push(' ');
        } else {
            output.push_str(cell.text());
        }
    }
    if active != grid.style() {
        write_style(output, grid.style());
    }
}

fn write_style(output: &mut String, style: CellStyle) {
    output.push_str("\x1b[0");
    for (enabled, code) in [
        (style.bold, ";1"),
        (style.dim, ";2"),
        (style.italic, ";3"),
        (style.underline, ";4"),
        (style.inverse, ";7"),
        (style.hidden, ";8"),
        (style.crossed_out, ";9"),
    ] {
        if enabled {
            output.push_str(code);
        }
    }
    for (color, code) in [(style.foreground, 38), (style.background, 48)] {
        match color {
            TerminalColor::Default => {}
            TerminalColor::Indexed(index) => {
                let _ = write!(output, ";{code};5;{index}");
            }
            TerminalColor::Rgb(red, green, blue) => {
                let _ = write!(output, ";{code};2;{red};{green};{blue}");
            }
        }
    }
    output.push('m');
}

#[cfg(test)]
#[path = "command_output_tests.rs"]
mod tests;
