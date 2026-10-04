use super::wrap::PROMPT_WIDTH;
use super::wrap::wrap_input;
use crate::render::RenderContext;
use crate::render::display_width;
use ratatui::Frame;
use ratatui::layout::Position;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use ratatui::widgets::Block;
use ratatui::widgets::Borders;
use ratatui::widgets::Paragraph;
use std::ops::Range;
use unicode_segmentation::UnicodeSegmentation;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ChatInputCursor {
    Hidden,
    Visible,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ChatInputChrome {
    Standard,
    Mode(ash_protocol::CollaborationMode),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ChatInputFocus {
    Blurred,
    Focused,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct InputHit {
    /// Nearest caret boundary; the right half of a wide glyph points after it.
    pub(crate) byte: usize,
    /// Glyph under the pointer, independent of the caret boundary.
    pub(crate) glyph_byte: Option<usize>,
    /// Byte bounds of the rendered row, which can be shorter than a logical line.
    pub(crate) row_start: usize,
    pub(crate) row_end: usize,
    pub(crate) scroll_row: usize,
}

pub(crate) fn content_area(area: Rect) -> Rect {
    let offset = (PROMPT_WIDTH as u16).min(area.width);
    Rect {
        x: area.x.saturating_add(offset),
        width: area.width.saturating_sub(offset),
        ..area
    }
}

pub(crate) fn draw(
    frame: &mut Frame<'_>,
    area: Rect,
    input: &str,
    cursor_width: usize,
    cursor_line: usize,
    selection: Option<Range<usize>>,
    scroll_override: Option<usize>,
    prompt: &str,
    cursor: ChatInputCursor,
    focus: ChatInputFocus,
    placeholder: Option<&str>,
    argument_hint: Option<&str>,
    chrome: ChatInputChrome,
    context: RenderContext<'_>,
) {
    let prompt_color = match chrome {
        ChatInputChrome::Standard => context.foreground(),
        ChatInputChrome::Mode(mode) => context.mode_color(mode),
    };
    let border_color = match chrome {
        ChatInputChrome::Mode(mode) => context.mode_color(mode),
        ChatInputChrome::Standard => match focus {
            ChatInputFocus::Blurred => context.border(),
            ChatInputFocus::Focused => context.chat_input_chrome(),
        },
    };
    let wrapped = wrap_input(input, cursor_line, cursor_width, area.width);
    let mut lines = wrapped
        .lines
        .iter()
        .zip(&wrapped.byte_ranges)
        .enumerate()
        .map(|(index, (line, byte_range))| {
            let prompt = if index == 0 { prompt } else { "  " };
            let mut spans = vec![Span::styled(
                prompt,
                Style::default()
                    .fg(prompt_color)
                    .add_modifier(Modifier::BOLD),
            )];
            if let Some(range) = selection
                .as_ref()
                .filter(|range| range.start < byte_range.end && byte_range.start < range.end)
            {
                let start = range.start.max(byte_range.start) - byte_range.start;
                let end = range.end.min(byte_range.end) - byte_range.start;
                spans.push(Span::raw(&line[..start]));
                spans.push(Span::styled(
                    &line[start..end],
                    Style::default()
                        .fg(context.selection_foreground())
                        .bg(context.selection_background()),
                ));
                spans.push(Span::raw(&line[end..]));
            } else {
                spans.push(Span::raw(line.as_str()));
            }
            Line::from(spans)
        })
        .collect::<Vec<_>>();
    if let Some(hint) = argument_hint
        && let Some(line) = lines.get_mut(wrapped.cursor_row)
    {
        line.spans.push(Span::styled(
            context.localize(hint),
            Style::default().fg(context.muted()),
        ));
    }
    if input.is_empty()
        && focus == ChatInputFocus::Blurred
        && let Some(placeholder) = placeholder
    {
        lines = vec![Line::from(vec![
            Span::styled(
                prompt,
                Style::default()
                    .fg(prompt_color)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                context.localize(placeholder),
                Style::default().fg(context.muted()),
            ),
        ])];
    }
    let visible_rows = area.height.saturating_sub(2) as usize;
    let scroll_row = visible_scroll_row(
        wrapped.cursor_row,
        wrapped.lines.len(),
        visible_rows,
        scroll_override,
    );
    let chat_input = Paragraph::new(lines)
        .scroll((scroll_row.min(u16::MAX as usize) as u16, 0))
        .block(
            Block::default()
                .borders(Borders::TOP | Borders::BOTTOM)
                .border_style(Style::default().fg(border_color)),
        );
    frame.render_widget(chat_input, area);

    if cursor == ChatInputCursor::Visible && visible_rows > 0 && area.width > PROMPT_WIDTH as u16 {
        let content = content_area(area);
        let input_width = wrapped
            .cursor_column
            .min(content.width.saturating_sub(1) as usize) as u16;
        let visible_cursor_line = wrapped.cursor_row.saturating_sub(scroll_row);
        let cursor_y = area
            .y
            .saturating_add(1)
            .saturating_add(visible_cursor_line.min(u16::MAX as usize) as u16)
            .min(area.y.saturating_add(area.height.saturating_sub(2)));
        frame.set_cursor_position((content.x.saturating_add(input_width), cursor_y));
    }
}

/// Resolve a screen cell with the same wrapping, prompt width, and scroll used by `draw`.
pub(crate) fn cursor_at(
    area: Rect,
    input: &str,
    cursor_line: usize,
    cursor_width: usize,
    scroll_override: Option<usize>,
    position: Position,
) -> InputHit {
    let wrapped = wrap_input(input, cursor_line, cursor_width, area.width);
    let visible_rows = area.height.saturating_sub(2) as usize;
    let scroll_row = visible_scroll_row(
        wrapped.cursor_row,
        wrapped.lines.len(),
        visible_rows,
        scroll_override,
    );
    let row = scroll_row
        .saturating_add(position.y.saturating_sub(area.y.saturating_add(1)) as usize)
        .min(wrapped.lines.len().saturating_sub(1));
    let text_x = content_area(area).x;
    let column = usize::from(position.x.saturating_sub(text_x));
    let line = &wrapped.lines[row];
    let range = &wrapped.byte_ranges[row];
    let mut width = 0;
    for (offset, glyph) in line.grapheme_indices(true) {
        let character_width = display_width(glyph);
        if column < width + character_width {
            let glyph_byte = range.start + offset;
            return InputHit {
                byte: glyph_byte
                    + usize::from((column - width) * 2 >= character_width) * glyph.len(),
                glyph_byte: (position.x >= text_x).then_some(glyph_byte),
                row_start: range.start,
                row_end: range.end,
                scroll_row,
            };
        }
        width += character_width;
    }
    InputHit {
        byte: range.end,
        glyph_byte: None,
        row_start: range.start,
        row_end: range.end,
        scroll_row,
    }
}

fn visible_scroll_row(
    cursor_row: usize,
    line_count: usize,
    visible_rows: usize,
    scroll_override: Option<usize>,
) -> usize {
    scroll_override
        .unwrap_or_else(|| cursor_row.saturating_sub(visible_rows.saturating_sub(1)))
        .min(line_count.saturating_sub(visible_rows))
}

#[cfg(test)]
#[path = "view_tests.rs"]
mod tests;
