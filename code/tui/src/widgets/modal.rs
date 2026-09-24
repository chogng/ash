//! Bounded modal chrome. The host owns focus and the feature owns its content.

use crate::render::InteractionState;
use crate::render::RenderContext;
use crate::render::interaction_style;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::widgets::Block;
use ratatui::widgets::Borders;
use ratatui::widgets::Clear;
use ratatui::widgets::Paragraph;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ModalLayout {
    pub(crate) surface: Rect,
    pub(crate) title: Rect,
    pub(crate) close: Rect,
    pub(crate) content: Rect,
    pub(crate) footer: Rect,
}

impl ModalLayout {
    pub(crate) fn new(available: Rect, width: u16, height: u16) -> Self {
        let horizontal_margin = if available.width >= 40 { 4 } else { 0 };
        let vertical_margin = u16::from(available.height >= 12) * 2;
        let width = width.min(available.width.saturating_sub(horizontal_margin));
        let height = height.min(available.height.saturating_sub(vertical_margin));
        let surface = Rect::new(
            available.x + available.width.saturating_sub(width) / 2,
            available.y + available.height.saturating_sub(height) / 2,
            width,
            height,
        );
        let inset = 3.min(width);
        let content_x = surface.x + inset;
        let content_width = width.saturating_sub(inset.saturating_add(2));
        let footer_rows = u16::from(height >= 4);
        let footer = Rect::new(
            content_x,
            surface
                .bottom()
                .saturating_sub(1 + footer_rows)
                .max(surface.y),
            content_width,
            footer_rows,
        );
        let content_y = surface.y + 2.min(height);
        let content = Rect::new(
            content_x,
            content_y,
            content_width,
            footer.y.saturating_sub(content_y),
        );
        let close = if width >= 8 && height > 0 {
            Rect::new(surface.right() - 5, surface.y, 3, 1)
        } else {
            Rect::default()
        };
        let title = Rect::new(
            content_x,
            surface.y,
            close.x.saturating_sub(content_x + 1),
            u16::from(height > 0),
        );
        Self {
            surface,
            title,
            close,
            content,
            footer,
        }
    }
}

pub(crate) fn draw(
    frame: &mut Frame<'_>,
    layout: ModalLayout,
    title: &str,
    hints: &crate::widgets::key_hint::KeyHints,
    close: InteractionState,
    blocked_alert: bool,
    hint_style: crate::config::KeyHintStyle,
    context: RenderContext<'_>,
) {
    frame.render_widget(Clear, layout.surface);
    let border_color = if blocked_alert {
        context.warning()
    } else {
        context.modal_border()
    };
    frame.render_widget(
        Block::default()
            .borders(Borders::ALL)
            .style(
                Style::default()
                    .fg(context.foreground())
                    .bg(context.background()),
            )
            .border_style(Style::default().fg(border_color)),
        layout.surface,
    );
    frame.render_widget(
        Paragraph::new(format!(" {title} ")).style(
            Style::default()
                .fg(context.foreground())
                .add_modifier(Modifier::BOLD),
        ),
        layout.title,
    );
    let close_style = Style::default()
        .fg(context.muted())
        .patch(interaction_style(context, close));
    frame.render_widget(Paragraph::new("[✗]").style(close_style), layout.close);
    crate::widgets::key_hint::draw_content(frame, layout.footer, hints, hint_style, context);
}

#[cfg(test)]
#[path = "modal_tests.rs"]
mod tests;
