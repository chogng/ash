use crate::app::command_panel::CommandPanel;
use crate::app::command_panel::CommandPanelOutcome;
use crate::widgets::panel::PanelLayout;
use crossterm::event::KeyEvent;
use ratatui::Frame;
use ratatui::layout::Rect;

pub(super) fn desired_height(panel: &CommandPanel, width: u16) -> u16 {
    let body = panel.body();
    let content_width = PanelLayout::content_width(width);
    crate::widgets::panel::HEADER_ROWS
        .saturating_add(body.tab_rows(content_width))
        .saturating_add(body.body_rows(content_width))
}

pub(super) fn draw(
    panel: &CommandPanel,
    frame: &mut Frame<'_>,
    area: Rect,
    context: crate::render::RenderContext<'_>,
) {
    let body = panel.body();
    let content_width = PanelLayout::content_width(area.width);
    let layout = PanelLayout::new(area, body.tab_rows(content_width));
    let presentation_focus = body.presentation_focus().unwrap_or_else(|| context.focus());
    crate::widgets::panel::draw_header(
        frame,
        area,
        &panel.navigation_title(context.language()),
        presentation_focus,
    );
    body.draw_tabs(frame, layout.tabs, None, None, context);
    body.draw_body(frame, layout.body, None, None, context);
}

pub(super) fn handle_key(
    panel: &mut CommandPanel,
    key: KeyEvent,
    area: Rect,
) -> CommandPanelOutcome {
    let body = panel.body();
    let layout = PanelLayout::new(area, body.tab_rows(PanelLayout::content_width(area.width)));
    panel.handle_key(key, layout.body)
}

pub(super) fn process_resources_visible(panel: &CommandPanel, area: Rect) -> bool {
    let body = panel.body();
    let layout = PanelLayout::new(area, body.tab_rows(PanelLayout::content_width(area.width)));
    panel.process_resources_visible(layout.body)
}
