//! Presentation of content that belongs beneath a transcript record.
//! Record owners choose content and actions; this component owns their shared geometry.

use crate::render::RenderContext;
use crate::render::action_style;
use crate::render::display_width;
use crate::render::styled_text_lines;
use crate::render::truncate_to_width;
use ash_ansi_escape::ansi_text;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;

/// Tool results, command receipts and expanded message details share this container.
/// It has no execution, expansion or scrolling state, and accepts already styled content
/// so callers retain ownership of failure labels and other semantic colors.
pub(super) struct MessageResponse<'a> {
    content: ResponseContent<'a>,
    full_details: bool,
}

enum ResponseContent<'a> {
    Plain(&'a str),
    Ansi(&'a str),
    Styled(Vec<Line<'static>>),
}

/// Final screen rows and component-relative action bounds, independent of the
/// caller's existing rows. The transcript applies the row offset once on composition.
pub(super) struct ResponseLayout {
    pub(super) lines: Vec<Line<'static>>,
    pub(super) details_action: Option<ResponseAction>,
}

/// Cell-relative action rows. Drawing and pointer handling consume these same bounds,
/// including the leading gutter, so resizing never leaves a stale clickable column.
#[derive(Clone, Debug)]
pub(super) struct ResponseAction {
    pub(super) rows: Vec<ResponseActionRow>,
}

#[derive(Clone, Copy, Debug)]
pub(super) struct ResponseActionRow {
    pub(super) row: usize,
    pub(super) width: u16,
}

impl ResponseAction {
    pub(super) fn contains(&self, row: usize, column: u16) -> bool {
        self.rows
            .iter()
            .any(|bounds| bounds.row == row && column < bounds.width)
    }
}

impl<'a> MessageResponse<'a> {
    pub(super) fn plain(text: &'a str) -> Self {
        Self {
            content: ResponseContent::Plain(text),
            full_details: false,
        }
    }

    pub(super) fn ansi(text: &'a str) -> Self {
        Self {
            content: ResponseContent::Ansi(text),
            full_details: false,
        }
    }

    pub(super) fn styled(body: Vec<Line<'static>>) -> Self {
        Self {
            content: ResponseContent::Styled(body),
            full_details: false,
        }
    }

    pub(super) fn with_full_details_action(mut self) -> Self {
        self.full_details = true;
        self
    }

    pub(super) fn layout(self, width: u16, context: RenderContext<'_>) -> ResponseLayout {
        let body = match self.content {
            ResponseContent::Plain(text) => {
                let mut body = Vec::new();
                crate::render::push_owned_lines(
                    &styled_text_lines(text, Style::default().fg(context.muted())),
                    &mut body,
                );
                body
            }
            ResponseContent::Ansi(text) => {
                let mut body = ansi_text(text).lines;
                if body.is_empty() {
                    body.push(Line::default());
                }
                for line in &mut body {
                    for span in &mut line.spans {
                        if span.style.fg.is_none() {
                            span.style.fg = Some(context.muted());
                        }
                    }
                }
                body
            }
            ResponseContent::Styled(body) => body,
        };
        let mut lines = PrefixedBlock::new(" └─ ", "    ").wrap(
            body,
            width,
            Style::default().fg(context.muted()),
        );
        let details_action = self.full_details.then(|| {
            let action = PrefixedBlock::new("    ", "    ").wrap(
                vec![Line::from(Span::styled("view full", action_style(context)))],
                width,
                Style::default(),
            );
            let rows = action
                .iter()
                .enumerate()
                .map(|(row, line)| ResponseActionRow {
                    row: lines.len() + row,
                    width: line.width() as u16,
                })
                .collect();
            lines.extend(action);
            ResponseAction { rows }
        });
        ResponseLayout {
            lines,
            details_action,
        }
    }
}

/// Prefix only after wrapping the body: both explicit newlines and soft wraps must
/// retain the text column without repeating the branch marker. This stays private
/// because its gutter is an implementation detail of MessageResponse.
struct PrefixedBlock {
    initial: &'static str,
    continuation: &'static str,
}

impl PrefixedBlock {
    fn new(initial: &'static str, continuation: &'static str) -> Self {
        Self {
            initial,
            continuation,
        }
    }

    fn wrap(self, body: Vec<Line<'static>>, width: u16, prefix_style: Style) -> Vec<Line<'static>> {
        if width == 0 {
            return Vec::new();
        }
        // When the terminal is narrower than the gutter, retain one content column.
        let gutter = display_width(self.initial)
            .max(display_width(self.continuation))
            .min(usize::from(width - 1));
        let body_width = usize::from(width) - gutter;
        let mut rows = crate::render::wrap_lines(body, body_width);
        for (index, row) in rows.iter_mut().enumerate() {
            let prefix = if index == 0 {
                self.initial
            } else {
                self.continuation
            };
            row.spans.insert(
                0,
                Span::styled(truncate_to_width(prefix, gutter), prefix_style),
            );
        }
        rows
    }
}
