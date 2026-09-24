use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Color;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use ratatui::widgets::Block;
use ratatui::widgets::Borders;

const TITLE_BAR_ROWS: u16 = 1;
const TITLE_BODY_GAP_ROWS: u16 = 1;
pub(crate) const HEADER_ROWS: u16 = TITLE_BAR_ROWS + TITLE_BODY_GAP_ROWS;
const CONTENT_HORIZONTAL_MARGIN: u16 = 2;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct PanelLayout {
    pub(crate) tabs: Rect,
    pub(crate) body: Rect,
}

impl PanelLayout {
    pub(crate) fn new(area: Rect, tab_rows: u16) -> Self {
        let header_rows = HEADER_ROWS.min(area.height);
        let available_rows = area.height.saturating_sub(header_rows);
        let tab_rows = tab_rows.min(available_rows);
        let tabs = crate::render::horizontal_margin(
            Rect::new(
                area.x,
                area.y.saturating_add(header_rows),
                area.width,
                tab_rows,
            ),
            CONTENT_HORIZONTAL_MARGIN,
        );
        let body = crate::render::horizontal_margin(
            Rect::new(
                area.x,
                area.y.saturating_add(header_rows).saturating_add(tab_rows),
                area.width,
                available_rows.saturating_sub(tab_rows),
            ),
            CONTENT_HORIZONTAL_MARGIN,
        );
        Self { tabs, body }
    }

    pub(crate) fn content_width(width: u16) -> u16 {
        width.saturating_sub(CONTENT_HORIZONTAL_MARGIN.saturating_mul(2))
    }
}

pub(crate) fn draw_header(
    frame: &mut Frame<'_>,
    area: Rect,
    title: &str,
    presentation_focus: Color,
) {
    let title_style = Style::default()
        .fg(presentation_focus)
        .add_modifier(Modifier::BOLD);
    frame.render_widget(
        Block::default()
            .borders(Borders::TOP)
            .border_style(Style::default().fg(presentation_focus))
            .title(Line::from(vec![
                Span::styled("─", Style::default().fg(presentation_focus)),
                Span::styled(format!(" {} ", title), title_style),
            ])),
        area,
    );
}
