//! Link destinations stay separate from text, layout and clipboard buffers.

use ratatui::backend::Backend;
use ratatui::backend::CrosstermBackend;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::text::Line;
use ratatui::text::Span;
use std::collections::BTreeMap;
use std::io;
use std::io::Write;
use std::ops::Range;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;
use url::Url;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Hyperlink {
    pub(crate) columns: Range<usize>,
    pub(crate) destination: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct HyperlinkLine {
    pub(crate) line: Line<'static>,
    pub(crate) links: Vec<Hyperlink>,
}

impl HyperlinkLine {
    pub(crate) fn push(
        &mut self,
        text: &str,
        style: ratatui::style::Style,
        destination: Option<&str>,
    ) {
        let destination = destination.and_then(web_destination);
        let start = if destination.is_some() {
            self.line.width()
        } else {
            0
        };
        // Model text cannot introduce terminal commands. Newlines are handled by the renderer.
        let text: String = text.chars().filter(|c| !c.is_control()).collect();
        let end = start + text.width();
        if let Some(last) = self
            .line
            .spans
            .last_mut()
            .filter(|span| span.style == style)
        {
            last.content.to_mut().push_str(&text);
        } else {
            self.line.push_span(Span::styled(text, style));
        }
        if end > start
            && let Some(destination) = destination
        {
            if let Some(last) = self
                .links
                .last_mut()
                .filter(|link| link.columns.end == start && link.destination == destination)
            {
                last.columns.end = end;
            } else {
                self.links.push(Hyperlink {
                    columns: start..end,
                    destination,
                });
            }
        }
    }

    pub(crate) fn prefix(&mut self, prefix: Span<'static>) {
        let width = prefix.width();
        self.line.spans.insert(0, prefix);
        for link in &mut self.links {
            link.columns = link.columns.start + width..link.columns.end + width;
        }
    }
}

pub(crate) fn web_destination(value: &str) -> Option<String> {
    if value.len() > 8192 || value.chars().any(char::is_control) {
        return None;
    }
    let url = Url::parse(value).ok()?;
    (matches!(url.scheme(), "http" | "https") && url.host_str().is_some()).then(|| url.to_string())
}

/// Wrap text and its links in one pass; destinations never participate in width measurement.
pub(crate) fn wrap(line: &HyperlinkLine, width: usize) -> Vec<HyperlinkLine> {
    if width == 0 {
        return Vec::new();
    }
    let mut result = Vec::new();
    let mut row = HyperlinkLine::default();
    let mut column = 0;
    for span in &line.line.spans {
        for word in span.content.split_word_bounds() {
            let word_width = word.width();
            if row.line.width() > 0 && word_width <= width && row.line.width() + word_width > width
            {
                result.push(std::mem::take(&mut row));
            }
            for glyph in word.graphemes(true) {
                let glyph_width = glyph.width();
                let destination = line
                    .links
                    .iter()
                    .find(|link| link.columns.contains(&column))
                    .map(|link| link.destination.as_str());
                if row.line.width() > 0 && row.line.width() + glyph_width > width {
                    result.push(std::mem::take(&mut row));
                }
                if glyph_width <= width {
                    row.push(glyph, line.line.style.patch(span.style), destination);
                }
                column += glyph_width;
            }
        }
    }
    if !row.line.spans.is_empty() || result.is_empty() {
        result.push(row);
    }
    result
}

/// Links for physical cells of a single frame. Rebuilt for every frame, including overlays.
#[derive(Debug, Default)]
pub(crate) struct FrameLinks {
    cells: BTreeMap<(u16, u16), std::sync::Arc<str>>,
}

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
                if let Some(destination) = self.cells.get(&(x, y)) {
                    let symbol =
                        format!("\x1b]8;;{destination}\x1b\\{}\x1b]8;;\x1b\\", cell.symbol());
                    cell.set_symbol(&symbol);
                }
            }
        }
    }

    pub(crate) fn place(&mut self, rows: &[Vec<Hyperlink>], area: Rect, source_row: usize) {
        for (row, links) in rows
            .iter()
            .skip(source_row)
            .take(usize::from(area.height))
            .enumerate()
        {
            for link in links {
                let destination: std::sync::Arc<str> = link.destination.as_str().into();
                for column in link
                    .columns
                    .clone()
                    .take_while(|column| *column < usize::from(area.width))
                {
                    self.cells.insert(
                        (area.x + column as u16, area.y + row as u16),
                        std::sync::Arc::clone(&destination),
                    );
                }
            }
        }
    }

    pub(crate) fn clear(&mut self, area: Rect) {
        self.cells
            .retain(|&(x, y), _| !area.contains((x, y).into()));
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
            .cells
            .keys()
            .chain(previous.cells.keys())
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
                self.cells.get(position) != previous.cells.get(position)
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
                changed.chunk_by(|left, right| self.cells.get(left) == self.cells.get(right))
            {
                if let Some(destination) = self.cells.get(&group[0]) {
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
