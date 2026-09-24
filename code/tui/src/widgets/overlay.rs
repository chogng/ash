//! Read-only detail layer rendered without changing the current screen layout.

use crate::keymap::bindings;
use crate::render::RenderContext;
use crate::render::bottom_anchored_area;
use crate::render::horizontal_margin;
use crate::widgets::detail_list;
use crate::widgets::detail_list::DetailList;
use crate::widgets::navigation::Navigation;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::widgets::Block;
use ratatui::widgets::Clear;

const TITLE_ROWS: u16 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OverlayInputOutcome {
    Consumed,
    Dismiss,
}

#[derive(Debug)]
pub(crate) struct DetailOverlay {
    detail: DetailList,
    scroll: u16,
}

impl DetailOverlay {
    pub(crate) fn new(detail: DetailList) -> Self {
        Self { detail, scroll: 0 }
    }

    pub(crate) fn update(&mut self, detail: DetailList) {
        self.detail = detail;
    }

    pub(crate) fn title(&self) -> &str {
        self.detail.title()
    }

    pub(crate) fn handle_key(&mut self, key: KeyEvent, available: Rect) -> OverlayInputOutcome {
        if let Some(navigation) = Navigation::from_key(key) {
            self.scroll(navigation, available);
        }
        if key.kind == KeyEventKind::Press && bindings::CLOSE.matches(key) {
            OverlayInputOutcome::Dismiss
        } else {
            OverlayInputOutcome::Consumed
        }
    }

    pub(crate) fn surface(&self, available: Rect) -> Rect {
        overlay_layout(available, &self.detail).surface
    }

    pub(crate) fn scroll_body(&mut self, navigation: Navigation, area: Rect) {
        let max_scroll = self
            .detail
            .content_height(area.width)
            .saturating_sub(usize::from(area.height));
        self.scroll = navigation
            .offset(
                usize::from(self.scroll),
                max_scroll,
                usize::from(area.height),
            )
            .min(usize::from(u16::MAX)) as u16;
    }

    pub(crate) fn draw_body(&self, frame: &mut Frame<'_>, area: Rect, context: RenderContext<'_>) {
        let max_scroll = self
            .detail
            .content_height(area.width)
            .saturating_sub(usize::from(area.height));
        detail_list::draw_body_scrolled(
            frame,
            area,
            &self.detail,
            usize::from(self.scroll)
                .min(max_scroll)
                .min(usize::from(u16::MAX)) as u16,
            context,
        );
    }

    pub(crate) fn scroll(&mut self, navigation: Navigation, available: Rect) {
        let layout = overlay_layout(available, &self.detail);
        self.scroll = navigation.offset(
            usize::from(self.scroll),
            usize::from(layout.max_scroll),
            usize::from(layout.surface.height.saturating_sub(TITLE_ROWS)),
        ) as u16;
    }
}

#[derive(Clone, Copy)]
struct DetailOverlayLayout {
    surface: Rect,
    max_scroll: u16,
}

fn overlay_layout(available: Rect, detail: &DetailList) -> DetailOverlayLayout {
    let content_width = horizontal_margin(available, 2).width;
    let content_rows = u16::try_from(detail.content_height(content_width)).unwrap_or(u16::MAX);
    let surface_rows = TITLE_ROWS
        .saturating_add(content_rows)
        .min(available.height);
    let surface = bottom_anchored_area(available, surface_rows);
    let visible_content_rows = surface.height.saturating_sub(TITLE_ROWS);
    DetailOverlayLayout {
        surface,
        max_scroll: content_rows.saturating_sub(visible_content_rows),
    }
}

pub(crate) fn draw(
    frame: &mut Frame<'_>,
    available: Rect,
    state: &DetailOverlay,
    context: RenderContext<'_>,
) {
    let layout = overlay_layout(available, &state.detail);
    frame.render_widget(Clear, layout.surface);
    frame.render_widget(
        Block::default().style(Style::default().bg(context.overlay_background())),
        layout.surface,
    );
    detail_list::draw_scrolled(
        frame,
        layout.surface,
        &state.detail,
        state.scroll.min(layout.max_scroll),
        context,
    );
}

#[cfg(test)]
#[path = "overlay_tests.rs"]
mod tests;
