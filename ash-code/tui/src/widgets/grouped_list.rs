use crate::render::RenderContext;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use unicode_width::UnicodeWidthChar;
use unicode_width::UnicodeWidthStr;
// Shared viewport policy for grouped managers, including overflow indicator rows.

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct Viewport {
    pub(crate) start: usize,
    pub(crate) end: usize,
}

pub(crate) fn viewport(
    row_count: usize,
    selected_row: Option<usize>,
    visible_rows: usize,
) -> Viewport {
    if row_count <= visible_rows {
        return Viewport {
            start: 0,
            end: row_count,
        };
    }
    if visible_rows <= 1 {
        let start = selected_row
            .unwrap_or_default()
            .min(row_count.saturating_sub(1));
        return Viewport {
            start,
            end: (start + 1).min(row_count),
        };
    }
    let selected = selected_row
        .unwrap_or_default()
        .min(row_count.saturating_sub(1));
    for start in 0..=selected {
        let top_notice = usize::from(start > 0);
        let mut capacity = visible_rows.saturating_sub(top_notice).max(1);
        if row_count.saturating_sub(start) > capacity && capacity > 1 {
            capacity -= 1;
        }
        let end = start.saturating_add(capacity).min(row_count);
        if selected < end {
            return Viewport { start, end };
        }
    }
    Viewport {
        start: selected,
        end: (selected + 1).min(row_count),
    }
}

pub(crate) fn more_line(
    direction: char,
    count: usize,
    width: usize,
    context: RenderContext<'_>,
) -> Line<'static> {
    let position = if direction == '↑' { "above" } else { "below" };
    let text = format!(
        "{direction} {count} {} {}",
        context.localize("more"),
        context.localize(position)
    );
    Line::styled(
        pad_to_width(&truncate_to_width(&text, width), width),
        Style::default()
            .fg(context.muted())
            .add_modifier(Modifier::ITALIC),
    )
}

pub(crate) fn truncate_to_width(text: &str, width: usize) -> String {
    text.chars()
        .scan(0, |used, character| {
            let character_width = character.width().unwrap_or(0);
            (*used + character_width <= width).then(|| {
                *used += character_width;
                character
            })
        })
        .collect()
}

pub(crate) fn pad_to_width(text: &str, width: usize) -> String {
    format!("{text}{}", " ".repeat(width.saturating_sub(text.width())))
}
