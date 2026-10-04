mod timer;
mod view;

pub(crate) use timer::StatusTimer;

use super::TurnActivity;
use crate::nls::{self, Message};
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

/// Live turn feedback in the fixed chat controls; never written to terminal history.
pub(crate) struct TurnProgress<'a> {
    pub(crate) activity: TurnActivity,
    pub(crate) timer: &'a StatusTimer,
    pub(crate) interrupt_hint: Option<String>,
    pub(crate) show_tips: bool,
}

impl TurnProgress<'_> {
    fn label(&self) -> (&'static str, bool) {
        match self.activity {
            TurnActivity::Starting => ("Starting...", true),
            TurnActivity::Working => {
                let index = (self.timer.runs_started().saturating_sub(1) as usize)
                    % nls::spinner_verb_count();
                (nls::spinner_verb(index), true)
            }
            TurnActivity::WaitingForApproval => ("Waiting for approval", false),
            TurnActivity::WaitingForUserInput => ("Waiting for input", false),
            TurnActivity::WaitingForCapability => ("Waiting for capability", false),
            TurnActivity::Cancelling => ("Cancelling...", true),
        }
    }

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
