//! OSC 8 output consumes the final frame annotations without affecting layout.

use crate::render::links::FrameLinks;
use ratatui::backend::Backend;
use ratatui::backend::CrosstermBackend;
use ratatui::buffer::Buffer;
use std::io;
use std::io::Write;
use unicode_width::UnicodeWidthStr;

impl FrameLinks {
    /// Encode a disposable history buffer immediately before sequential terminal output.
    /// It must never be reused for layout, diffing, selection, or export.
    pub(crate) fn encode_history(&self, buffer: &mut Buffer) {
        for y in buffer.area.y..buffer.area.bottom() {
            let mut next_column = buffer.area.x;
            for x in buffer.area.x..buffer.area.right() {
                let cell = &mut buffer[(x, y)];
                if x < next_column {
                    // insert_before writes every cell, including wide-glyph continuation columns.
                    cell.set_symbol("");
                    continue;
                }
                next_column = x.saturating_add(cell.symbol().width().max(1) as u16);
                if let Some(destination) = self.cells().get(&(x, y)) {
                    let symbol =
                        format!("\x1b]8;;{destination}\x1b\\{}\x1b]8;;\x1b\\", cell.symbol());
                    cell.set_symbol(&symbol);
                }
            }
        }
    }

    /// Ratatui emits ordinary text first. Restore changed OSC 8 annotations using the final cells,
    /// including cells whose text stayed the same while their destination changed or disappeared.
    pub(crate) fn write<W: Write>(
        &self,
        previous: &Self,
        buffer: &Buffer,
        previous_buffer: Option<&Buffer>,
        backend: &mut CrosstermBackend<W>,
    ) -> io::Result<()> {
        let mut positions = self
            .cells()
            .keys()
            .chain(previous.cells().keys())
            .copied()
            .collect::<Vec<_>>();
        positions.sort_unstable_by_key(|&(x, y)| (y, x));
        positions.dedup();
        let redrawn = previous_buffer
            .filter(|old| old.area == buffer.area)
            .map(|old| {
                old.diff(buffer)
                    .into_iter()
                    .map(|(x, y, _)| (x, y))
                    .collect::<std::collections::HashSet<_>>()
            });
        let changed = positions
            .into_iter()
            .filter(|position| {
                self.cells().get(position) != previous.cells().get(position)
                    || redrawn
                        .as_ref()
                        .is_none_or(|cells| cells.contains(position))
            })
            .collect::<Vec<_>>();
        if changed.is_empty() {
            return Ok(());
        }
        backend.write_all(b"\x1b7")?;
        let result = (|| {
            for group in
                changed.chunk_by(|left, right| self.cells().get(left) == self.cells().get(right))
            {
                if let Some(destination) = self.cells().get(&group[0]) {
                    write!(backend, "\x1b]8;;{destination}\x1b\\")?;
                } else {
                    backend.write_all(b"\x1b]8;;\x1b\\")?;
                }
                backend.draw(group.iter().filter_map(|&position| {
                    let cell = buffer.cell(position)?;
                    // Do not overwrite the second column of a wide glyph.
                    if position.0 > buffer.area.x
                        && buffer
                            .cell((position.0 - 1, position.1))
                            .is_some_and(|left| left.symbol().width() > 1)
                    {
                        return None;
                    }
                    Some((position.0, position.1, cell))
                }))?;
                backend.write_all(b"\x1b]8;;\x1b\\")?;
            }
            Ok(())
        })();
        let close = backend.write_all(b"\x1b]8;;\x1b\\\x1b8");
        result.and(close)?;
        Write::flush(backend)
    }
}

#[cfg(test)]
#[path = "hyperlinks_tests.rs"]
mod tests;
