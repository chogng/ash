//! A short, focused message that returns control to its owning page when dismissed.

use crate::render::RenderContext;
use crate::widgets::key_hint::KeyHints;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::widgets::{Paragraph, Wrap};

#[derive(Debug)]
pub(crate) struct Dialog {
    title: &'static str,
    message: String,
    key_hints: KeyHints,
}

impl Dialog {
    pub(crate) fn error(title: &'static str, message: String) -> Self {
        Self {
            title,
            message,
            key_hints: KeyHints::new().with_action("Enter/Esc", "close"),
        }
    }

    pub(crate) fn title(&self) -> &'static str {
        self.title
    }

    pub(crate) fn key_hints(&self) -> &KeyHints {
        &self.key_hints
    }

    pub(crate) fn body_rows(&self, width: u16) -> u16 {
        Paragraph::new(self.message.as_str())
            .wrap(Wrap { trim: false })
            .line_count(width.max(1))
            .min(usize::from(u16::MAX)) as u16
    }

    pub(crate) fn draw(&self, frame: &mut Frame<'_>, area: Rect, context: RenderContext<'_>) {
        frame.render_widget(
            Paragraph::new(self.message.as_str())
                .wrap(Wrap { trim: false })
                .style(ratatui::style::Style::default().fg(context.foreground())),
            area,
        );
    }
}
