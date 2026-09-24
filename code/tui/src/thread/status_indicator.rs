mod timer;
mod view;

pub(crate) use timer::StatusTimer;

use super::TurnActivity;
use crate::render::RenderContext;
use ratatui::Frame;
use ratatui::layout::Rect;

/// The current turn's status surface; execution and keyboard routing remain with the caller.
pub(crate) struct StatusIndicator<'a> {
    pub(crate) activity: TurnActivity,
    pub(crate) timer: &'a StatusTimer,
    pub(crate) interrupt_hint: Option<String>,
}

impl StatusIndicator<'_> {
    pub(crate) fn draw(&self, frame: &mut Frame<'_>, area: Rect, context: RenderContext<'_>) {
        view::draw(frame, area, self, context);
    }
}
