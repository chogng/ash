use super::StatusIndicator;
use crate::render::RenderContext;
use crate::thread::TurnActivity;
use crate::thread::composer::content_area;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use ratatui::widgets::Paragraph;
use unicode_width::UnicodeWidthStr;

const FRAMES: [char; 10] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

pub(super) fn draw(
    frame: &mut Frame<'_>,
    area: Rect,
    indicator: &StatusIndicator<'_>,
    context: RenderContext<'_>,
) {
    if area.is_empty() {
        return;
    }
    let (label, active) = match indicator.activity {
        TurnActivity::Starting => ("Starting", true),
        TurnActivity::Working => ("Working", true),
        TurnActivity::WaitingForApproval => ("Waiting for approval", false),
        TurnActivity::WaitingForUserInput => ("Waiting for input", false),
        TurnActivity::WaitingForCapability => ("Waiting for capability", false),
        TurnActivity::Cancelling => ("Cancelling", true),
    };
    let label = context.localize(label);
    let elapsed = indicator.timer.elapsed();
    let marker = if active {
        FRAMES[(elapsed.as_millis() / 100 % 10) as usize]
    } else {
        '○'
    };
    let color = if active {
        context.accent()
    } else {
        context.warning()
    };
    frame.render_widget(
        Paragraph::new(marker.to_string()).style(Style::default().fg(color)),
        Rect {
            width: 1,
            height: 1,
            ..area
        },
    );
    let content = content_area(area);
    let seconds = elapsed.as_secs();
    let time = format!(
        " · {}m {:02}s {}",
        seconds / 60,
        seconds % 60,
        context.localize("total")
    );
    let hint = indicator.interrupt_hint.as_deref().unwrap_or("");
    let hint = if hint.is_empty() {
        String::new()
    } else {
        format!(" · {hint} {}", context.localize("to interrupt"))
    };
    let mut spans = vec![Span::styled(label.clone(), Style::default().fg(color))];
    // Keep the action discoverable before spending remaining columns on elapsed time.
    let width = usize::from(content.width);
    if label.width() + time.width() + hint.width() <= width {
        spans.push(Span::raw(time));
        spans.push(Span::raw(hint));
    } else if label.width() + hint.width() <= width && !hint.is_empty() {
        spans.push(Span::raw(hint));
    } else if label.width() + time.width() <= width {
        spans.push(Span::raw(time));
    }
    frame.render_widget(
        Paragraph::new(Line::from(spans)).style(Style::default().fg(context.muted())),
        content,
    );
}

#[cfg(test)]
#[path = "view_tests.rs"]
mod tests;
