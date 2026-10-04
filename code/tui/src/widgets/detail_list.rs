#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DetailListRow {
    label: String,
    value: String,
}

impl DetailListRow {
    pub(crate) fn new(label: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            label: label.into(),
            value: value.into(),
        }
    }

    pub(crate) fn label(&self) -> &str {
        &self.label
    }

    pub(crate) fn value(&self) -> &str {
        &self.value
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DetailList {
    title: String,
    rows: Vec<DetailListRow>,
}

impl DetailList {
    pub(crate) fn new(title: impl Into<String>, rows: Vec<DetailListRow>) -> Self {
        Self {
            title: title.into(),
            rows,
        }
    }

    pub(crate) fn title(&self) -> &str {
        &self.title
    }

    pub(crate) fn rows(&self) -> &[DetailListRow] {
        &self.rows
    }

    pub(crate) fn content_height(&self, content_width: u16) -> usize {
        crate::render::wrapped_height(
            &detail_lines(self, Style::default(), Style::default()),
            content_width,
        )
    }

    pub(crate) fn localize(&mut self, language: crate::nls::Language) {
        self.title = crate::nls::localize_owned(language, &self.title);
        for row in &mut self.rows {
            row.label = crate::nls::localize_owned(language, &row.label);
            row.value = crate::nls::localize_owned(language, &row.value);
        }
    }
}

use crate::render::RenderContext;
use crate::render::horizontal_margin;
use crate::render::prefix_lines;
use crate::render::styled_text_lines;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use ratatui::widgets::Block;
use ratatui::widgets::Borders;
use ratatui::widgets::Paragraph;
use ratatui::widgets::Wrap;
use unicode_width::UnicodeWidthStr;

pub(crate) fn draw_scrolled(
    frame: &mut Frame<'_>,
    area: Rect,
    detail: &DetailList,
    scroll: u16,
    context: RenderContext<'_>,
) {
    let lines = detail_lines(
        detail,
        Style::default().add_modifier(Modifier::BOLD),
        Style::default().fg(context.muted()),
    );
    frame.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .scroll((scroll, 0))
            .block(
                Block::default()
                    .title(detail.title())
                    .borders(Borders::TOP)
                    .border_style(Style::default().fg(context.focus())),
            ),
        horizontal_margin(area, 2),
    );
}

/// Both rendering and pointer handling reserve the same bottom rows for actions.
pub(crate) fn split_with_actions(area: Rect, action_rows: u16) -> [Rect; 2] {
    let actions = action_rows.min(area.height.saturating_sub(2));
    let detail = Rect::new(
        area.x,
        area.y,
        area.width,
        area.height.saturating_sub(actions + 1),
    );
    let actions = Rect::new(area.x, area.bottom() - actions, area.width, actions);
    [detail, actions]
}

pub(crate) fn draw_body_scrolled(
    frame: &mut Frame<'_>,
    area: Rect,
    detail: &DetailList,
    scroll: u16,
    context: RenderContext<'_>,
) {
    let lines = detail_lines(
        detail,
        Style::default().add_modifier(Modifier::BOLD),
        Style::default().fg(context.muted()),
    );
    frame.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .scroll((scroll, 0)),
        area,
    );
}

pub(crate) fn body_lines<'a>(detail: &'a DetailList, context: RenderContext<'_>) -> Vec<Line<'a>> {
    detail_lines(
        detail,
        Style::default().add_modifier(Modifier::BOLD),
        Style::default().fg(context.muted()),
    )
}

fn detail_lines<'a>(
    detail: &'a DetailList,
    label_style: Style,
    value_style: Style,
) -> Vec<Line<'a>> {
    let label_width = detail
        .rows()
        .iter()
        .map(|row| row.label().width())
        .max()
        .unwrap_or_default();
    detail
        .rows()
        .iter()
        .flat_map(|row| {
            let padding = " ".repeat(label_width.saturating_sub(row.label().width()));
            let label = format!("{}: {padding}", row.label());
            let continuation = " ".repeat(label.width());
            prefix_lines(
                styled_text_lines(row.value(), value_style),
                Span::styled(label, label_style),
                Span::raw(continuation),
            )
        })
        .collect()
}

#[cfg(test)]
#[path = "detail_list_tests.rs"]
mod tests;
