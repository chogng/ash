//! One-row presentation of the canonical Thread Goal.

use crate::render::RenderContext;
use ash_protocol::ThreadGoal;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::widgets::Paragraph;

pub(crate) fn desired_height(goal: Option<&ThreadGoal>) -> u16 {
    u16::from(goal.is_some())
}

pub(crate) fn draw(
    frame: &mut Frame<'_>,
    area: Rect,
    goal: Option<&ThreadGoal>,
    context: RenderContext<'_>,
) {
    let Some(goal) = goal else {
        return;
    };
    frame.render_widget(
        Paragraph::new(format!("Goal: {}", goal.objective))
            .style(Style::default().fg(context.muted())),
        area,
    );
}
