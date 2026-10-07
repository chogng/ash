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
    pub(crate) title: Rect,
    pub(crate) tabs: Rect,
    pub(crate) body: Rect,
}

impl PanelLayout {
    pub(crate) fn new(area: Rect, tab_rows: u16) -> Self {
        let title = crate::render::horizontal_margin(
            Rect::new(area.x, area.y, area.width, TITLE_BAR_ROWS.min(area.height)),
            CONTENT_HORIZONTAL_MARGIN,
        );
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
        Self { title, tabs, body }
    }

    pub(crate) fn content_width(width: u16) -> u16 {
        width.saturating_sub(CONTENT_HORIZONTAL_MARGIN.saturating_mul(2))
    }
}

pub(crate) fn draw_header(
    frame: &mut Frame<'_>,
    area: Rect,
    mut title: Line<'_>,
    mut trailing: Line<'_>,
    presentation_focus: Color,
) {
    let border_style = Style::default().fg(presentation_focus);
    let title_style = Style::default()
        .fg(presentation_focus)
        .add_modifier(Modifier::BOLD);
    // The title keeps priority when a narrow panel cannot also fit its trailing information.
    let show_trailing =
        trailing.width() > 0 && title.width() + trailing.width() + 7 <= usize::from(area.width);
    title.style = title_style.patch(title.style);
    title.spans.insert(
        0,
        Span::styled("─ ", border_style.remove_modifier(Modifier::BOLD)),
    );
    title.spans.push(Span::styled(" ", border_style));
    let mut header = Block::default()
        .borders(Borders::TOP)
        .border_style(border_style)
        .title(title);
    if show_trailing {
        trailing.spans.insert(0, Span::styled(" ", border_style));
        trailing.spans.push(Span::styled(" ─", border_style));
        header = header.title(trailing.right_aligned());
    }
    frame.render_widget(header, area);
}
