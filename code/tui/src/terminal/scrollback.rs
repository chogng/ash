use ratatui::Terminal;
use ratatui::backend::Backend;
use ratatui::buffer::Buffer;
use std::io;

/// Keep transient allocations bounded even for a transcript taller than u16::MAX.
pub(super) fn append<B: Backend>(
    terminal: &mut Terminal<B>,
    height: usize,
    mut render: impl FnMut(&mut Buffer, usize),
) -> io::Result<()> {
    terminal.autoresize()?;
    for offset in (0..height).step_by(256) {
        let rows = (height - offset).min(256) as u16;
        terminal.insert_before(rows, |buffer| render(buffer, offset))?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "scrollback_tests.rs"]
mod tests;
