use crate::app::App;
use crate::nls::Text;
use crate::render::horizontal_margin;
use crate::render::wrap_lines;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::widgets::Paragraph;

fn lines(app: &App, width: u16) -> Vec<Line<'static>> {
    let Some(text) = app
        .announcement
        .as_ref()
        .and_then(|value| value.text(app.language().locale()))
    else {
        return Vec::new();
    };
    let mut message = Text::template("Announcement: {0}", vec![Text::literal(text)]);
    message.localize(app.language());
    wrap_lines(
        message
            .lines()
            .map(|line| Line::from(line.to_owned()))
            .collect(),
        usize::from(width),
    )
}

/// Both page layouts reserve the same wrapped rows used by drawing and pointer hit testing.
pub(super) fn split(app: &App, area: Rect) -> (Rect, Rect) {
    let rows =
        (lines(app, area.width.saturating_sub(4)).len() as u16).min(area.height.saturating_sub(4));
    let announcement = Rect {
        height: rows,
        ..area
    };
    let page = Rect {
        y: area.y + rows,
        height: area.height - rows,
        ..area
    };
    (announcement, page)
}

pub(super) fn draw(frame: &mut Frame<'_>, app: &App, area: Rect) {
    let area = horizontal_margin(area, 2);
    frame.render_widget(
        Paragraph::new(lines(app, area.width))
            .style(Style::default().fg(app.render_context().muted())),
        area,
    );
}

#[cfg(test)]
#[path = "announcement_tests.rs"]
mod tests;
