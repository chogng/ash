mod timer;
mod view;

pub(crate) use timer::StatusTimer;

use super::TurnActivity;
use crate::nls::Message;
use crate::render::RenderContext;
use ratatui::Frame;
use ratatui::layout::Rect;
use std::time::Duration;

// Leave short turns quiet; tip selection stays fixed for the entire run.
const TIP_DELAY: Duration = Duration::from_secs(8);
const RUNS_PER_TIP: u64 = 3;
const TIPS: [Message; 4] = [
    Message::TipPlan,
    Message::TipHelp,
    Message::TipFiles,
    Message::TipShortcuts,
];

/// The current turn's status surface; execution and keyboard routing remain with the caller.
pub(crate) struct StatusIndicator<'a> {
    pub(crate) activity: TurnActivity,
    pub(crate) timer: &'a StatusTimer,
    pub(crate) interrupt_hint: Option<String>,
    pub(crate) show_tips: bool,
}

impl StatusIndicator<'_> {
    pub(crate) fn tip(&self) -> Option<Message> {
        if !self.show_tips
            || !matches!(
                self.activity,
                TurnActivity::Starting | TurnActivity::Working
            )
        {
            return None;
        }
        let runs_started = self.timer.runs_started();
        (runs_started > 0 && self.timer.elapsed() >= TIP_DELAY).then(|| {
            let index = ((runs_started - 1) / RUNS_PER_TIP % TIPS.len() as u64) as usize;
            TIPS[index]
        })
    }

    pub(crate) fn desired_height(&self) -> u16 {
        1 + u16::from(self.tip().is_some())
    }

    pub(crate) fn draw(&self, frame: &mut Frame<'_>, area: Rect, context: RenderContext<'_>) {
        view::draw(frame, area, self, context);
    }
}
