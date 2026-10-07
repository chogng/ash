//! Link text and frame annotations contain no terminal escape sequences.

use ratatui::layout::Rect;
use ratatui::text::Line;
use ratatui::text::Span;
use std::collections::BTreeMap;
use std::ops::Range;
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
        self.push_validated(text, style, destination.as_deref());
    }

    /// Only Ash-created preview files may bypass the web-only Markdown link rule.
    pub(crate) fn push_trusted_file(
        &mut self,
        text: &str,
        style: ratatui::style::Style,
        destination: &str,
    ) {
        if Url::parse(destination).is_ok_and(|url| url.scheme() == "file") {
            self.push_validated(text, style, Some(destination));
        }
    }

    fn push_validated(
        &mut self,
        text: &str,
        style: ratatui::style::Style,
        destination: Option<&str>,
    ) {
        let start = if destination.is_some() {
            self.line.to_string().width()
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
                    destination: destination.to_owned(),
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
    crate::render::wrap_line(&line.line, width)
        .into_iter()
        .map(|wrapped| {
            let mut links: Vec<Hyperlink> = Vec::new();
            for (column, source) in wrapped.source_columns.into_iter().enumerate() {
                if let Some(link) = line
                    .links
                    .iter()
                    .find(|link| link.columns.contains(&source))
                {
                    if let Some(last) = links.last_mut().filter(|last| {
                        last.columns.end == column && last.destination == link.destination
                    }) {
                        last.columns.end += 1;
                    } else {
                        links.push(Hyperlink {
                            columns: column..column + 1,
                            destination: link.destination.clone(),
                        });
                    }
                }
            }
            HyperlinkLine {
                line: wrapped.line,
                links,
            }
        })
        .collect()
}

/// Links for physical cells of a single frame. Rebuilt for every frame, including overlays.
#[derive(Debug, Default)]
pub(crate) struct FrameLinks {
    cells: BTreeMap<(u16, u16), std::sync::Arc<str>>,
}

impl FrameLinks {
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

    pub(crate) fn cells(&self) -> &BTreeMap<(u16, u16), std::sync::Arc<str>> {
        &self.cells
    }
}

#[cfg(test)]
#[path = "links_tests.rs"]
mod tests;

/// Prepared preview addresses are render inputs. Resolving them performs no filesystem I/O.
#[derive(Debug, Default)]
pub(crate) struct PreviewLinks {
    urls: std::collections::HashMap<String, String>,
    revision: u64,
}

impl PreviewLinks {
    pub(crate) fn insert(&mut self, source: &str, url: String) {
        if self.urls.get(source) != Some(&url) {
            self.urls.insert(source.to_owned(), url);
            self.revision = self.revision.wrapping_add(1).max(1);
        }
    }

    pub(crate) fn clear(&mut self) {
        self.urls.clear();
        self.revision = self.revision.wrapping_add(1).max(1);
    }

    pub(crate) fn url(&self, source: &str) -> Option<&str> {
        self.urls.get(source).map(String::as_str)
    }

    pub(crate) fn revision(&self) -> u64 {
        self.revision
    }
}
