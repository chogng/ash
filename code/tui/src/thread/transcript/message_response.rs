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
use unicode_segmentation::UnicodeSegmentation;

/// Tool results, command receipts and expanded message details share this container.
/// It has no execution, expansion or scrolling state, and accepts already styled content
/// so callers retain ownership of failure labels and other semantic colors.
pub(super) struct MessageResponse {
    body: Vec<Line<'static>>,
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

impl MessageResponse {
    pub(super) fn plain(text: &str, context: RenderContext<'_>) -> Self {
        let mut body = Vec::new();
        crate::render::push_owned_lines(
            &styled_text_lines(text, Style::default().fg(context.muted())),
            &mut body,
        );
        Self::styled(body)
    }

    pub(super) fn ansi(text: &str, context: RenderContext<'_>) -> Self {
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
        Self::styled(body)
    }

    pub(super) fn styled(body: Vec<Line<'static>>) -> Self {
        Self { body }
    }

    pub(super) fn append_to(
        self,
        lines: &mut Vec<Line<'static>>,
        width: u16,
        context: RenderContext<'_>,
    ) {
        lines.extend(PrefixedBlock::new(" └─ ", "    ").wrap(
            self.body,
            width,
            Style::default().fg(context.muted()),
        ));
    }

    /// The caller decides whether this action exists. Its label, indentation and
    /// physical row widths are kept together rather than inferred by the view.
    pub(super) fn append_full_details_action(
        lines: &mut Vec<Line<'static>>,
        width: u16,
        context: RenderContext<'_>,
    ) -> ResponseAction {
        let action_lines = PrefixedBlock::new("    ", "    ").wrap(
            vec![Line::from(Span::styled("view full", action_style(context)))],
            width,
            Style::default(),
        );
        let rows = action_lines
            .iter()
            .enumerate()
            .map(|(index, line)| ResponseActionRow {
                row: lines.len() + index,
                width: line.width() as u16,
            })
            .collect();
        lines.extend(action_lines);
        ResponseAction { rows }
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
        let mut rows = Vec::new();
        for line in body {
            let mut row = Line::default();
            let mut used = 0;
            for span in line.spans {
                let style = line.style.patch(span.style);
                for word in span.content.split_word_bounds() {
                    let word_width = display_width(word);
                    if used > 0 && word_width <= body_width && used + word_width > body_width {
                        rows.push(std::mem::take(&mut row));
                        used = 0;
                        if word.chars().all(char::is_whitespace) {
                            continue;
                        }
                    }
                    for glyph in word.graphemes(true) {
                        let glyph_width = display_width(glyph);
                        if used > 0 && used + glyph_width > body_width {
                            rows.push(std::mem::take(&mut row));
                            used = 0;
                            if glyph.chars().all(char::is_whitespace) {
                                continue;
                            }
                        }
                        if glyph_width <= body_width {
                            if let Some(last) = row.spans.last_mut().filter(|s| s.style == style) {
                                last.content.to_mut().push_str(glyph);
                            } else {
                                row.push_span(Span::styled(glyph.to_owned(), style));
                            }
                            used += glyph_width;
                        }
                    }
                }
            }
            rows.push(row);
        }
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
