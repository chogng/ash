use super::wrap::PROMPT_WIDTH;
use super::wrap::wrap_input;
use crate::render::RenderContext;
use ratatui::Frame;
use ratatui::layout::Position;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use ratatui::widgets::Block;
use ratatui::widgets::BorderType;
use ratatui::widgets::Borders;
use ratatui::widgets::Padding;
use ratatui::widgets::Paragraph;
use std::ops::Range;
use unicode_width::UnicodeWidthChar;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ChatInputCursor {
    Hidden,
    Visible,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ChatInputFocus {
    Blurred,
    Focused,
}

#[derive(Clone, Copy)]
pub(crate) enum ChatInputChrome {
    Rules,
    Box,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct InputHit {
    pub(crate) byte: usize,
    pub(crate) scroll_row: usize,
}

impl ChatInputChrome {
    pub(crate) fn inset(self, width: u16) -> u16 {
        match self {
            Self::Rules => 0,
            Self::Box => 6 + 2 * self.padding(width),
        }
    }

    fn padding(self, width: u16) -> u16 {
        u16::from(matches!(self, Self::Box) && width >= 10)
    }

    pub(crate) fn border_area(self, area: Rect) -> Rect {
        match self {
            Self::Rules => area,
            Self::Box => Rect {
                width: content_area(area).width.saturating_sub(2),
                ..content_area(area)
            },
        }
    }
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
    chrome: ChatInputChrome,
    argument_hint: Option<&str>,
    context: RenderContext<'_>,
) {
    let wrapped = wrap_input(
        input,
        cursor_line,
        cursor_width,
        area.width.saturating_sub(chrome.inset(area.width)),
    );
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
                    .fg(context.foreground())
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
        && matches!(chrome, ChatInputChrome::Box)
        && focus == ChatInputFocus::Blurred
    {
        lines = vec![Line::from(vec![
            Span::styled(
                prompt,
                Style::default()
                    .fg(context.foreground())
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                context.localize("Build anything"),
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
                .borders(match chrome {
                    ChatInputChrome::Rules => Borders::TOP | Borders::BOTTOM,
                    ChatInputChrome::Box => Borders::ALL,
                })
                .border_type(BorderType::Rounded)
                .padding(match chrome {
                    ChatInputChrome::Rules => Padding::ZERO,
                    ChatInputChrome::Box => Padding::horizontal(chrome.padding(area.width)),
                })
                .border_style(Style::default().fg(match focus {
                    ChatInputFocus::Blurred => context.border(),
                    ChatInputFocus::Focused => context.chat_input_chrome(),
                })),
        );
    let border_area = chrome.border_area(area);
    frame.render_widget(chat_input, border_area);

    if cursor == ChatInputCursor::Visible
        && (matches!(chrome, ChatInputChrome::Rules)
            || (visible_rows > 0 && area.width > chrome.inset(area.width) + PROMPT_WIDTH as u16))
    {
        let prompt_area = match chrome {
            ChatInputChrome::Rules => area,
            ChatInputChrome::Box => {
                let horizontal_inset = 1 + chrome.padding(area.width);
                Rect {
                    x: border_area
                        .x
                        .saturating_add(horizontal_inset.min(border_area.width)),
                    width: border_area.width.saturating_sub(2 * horizontal_inset),
                    ..border_area
                }
            }
        };
        let content = content_area(prompt_area);
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

/// Resolve a screen cell with the same wrapping, inset, and scroll used by `draw`.
pub(crate) fn cursor_at(
    area: Rect,
    chrome: ChatInputChrome,
    input: &str,
    cursor_line: usize,
    cursor_width: usize,
    scroll_override: Option<usize>,
    position: Position,
) -> InputHit {
    let wrapped = wrap_input(
        input,
        cursor_line,
        cursor_width,
        area.width.saturating_sub(chrome.inset(area.width)),
    );
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
    let border_area = chrome.border_area(area);
    let text_x = match chrome {
        ChatInputChrome::Rules => content_area(area).x,
        ChatInputChrome::Box => {
            border_area.x + 1 + chrome.padding(area.width) + PROMPT_WIDTH as u16
        }
    };
    let column = usize::from(position.x.saturating_sub(text_x));
    let line = &wrapped.lines[row];
    let range = &wrapped.byte_ranges[row];
    let mut width = 0;
    for (offset, character) in line.char_indices() {
        let character_width = character.width().unwrap_or(0);
        if column < width + character_width {
            return InputHit {
                byte: range.start
                    + offset
                    + usize::from((column - width) * 2 >= character_width) * character.len_utf8(),
                scroll_row,
            };
        }
        width += character_width;
    }
    InputHit {
        byte: range.end,
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
