use super::TurnProgress;
use crate::render::{RenderContext, truncate_with_ellipsis};
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
    indicator: &TurnProgress<'_>,
    context: RenderContext<'_>,
) {
    if area.is_empty() {
        return;
    }
    let (label, active) = indicator.label();
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
    let time = if seconds < 60 {
        format!(" · {seconds}s")
    } else if seconds < 3600 {
        format!(" · {}m {:02}s", seconds / 60, seconds % 60)
    } else {
        format!(
            " · {}h {:02}m {:02}s",
            seconds / 3600,
            seconds / 60 % 60,
            seconds % 60
        )
    };
    let hint = indicator.interrupt_hint.as_deref().unwrap_or("");
    let hint = if hint.is_empty() {
        String::new()
    } else {
        format!(" · {hint} {}", context.localize("to interrupt"))
    };
    // Keep the action discoverable before spending remaining columns on elapsed time.
    let width = usize::from(content.width);
    let label = if !hint.is_empty() && hint.width() <= width && label.width() + hint.width() > width
    {
        truncate_with_ellipsis(&label, width - hint.width())
    } else {
        label.into_owned()
    };
    let mut spans = vec![Span::styled(
        label.clone(),
        Style::default().fg(context.muted()),
    )];
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
        Rect {
            height: 1,
            ..content
        },
    );
    if area.height > 1
        && let Some(tip) = indicator.tip()
    {
        frame.render_widget(
            Paragraph::new(format!("└ {}", crate::nls::text(context.language(), tip)))
                .style(Style::default().fg(context.muted())),
            Rect {
                y: area.y + 1,
                height: 1,
                ..area
            },
        );
    }
}

#[cfg(test)]
#[path = "view_tests.rs"]
mod tests;
