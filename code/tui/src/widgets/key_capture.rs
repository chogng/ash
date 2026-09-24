#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct KeyCapture {
    title: String,
    lines: Vec<String>,
}

impl KeyCapture {
    pub(crate) fn new(title: impl Into<String>, lines: Vec<String>) -> Self {
        Self {
            title: title.into(),
            lines,
        }
    }

    pub(crate) fn title(&self) -> &str {
        &self.title
    }

    pub(crate) fn lines(&self) -> &[String] {
        &self.lines
    }

    pub(crate) fn desired_height(&self) -> u16 {
        u16::try_from(self.lines.len().max(1)).unwrap_or(u16::MAX)
    }
}

use crate::render::RenderContext;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::text::Line;
use ratatui::widgets::Paragraph;

pub(crate) fn draw(
    frame: &mut Frame<'_>,
    area: Rect,
    capture: &KeyCapture,
    _context: RenderContext<'_>,
) {
    frame.render_widget(
        Paragraph::new(
            capture
                .lines()
                .iter()
                .map(|line| Line::from(line.as_str()))
                .collect::<Vec<_>>(),
        ),
        area,
    );
}
