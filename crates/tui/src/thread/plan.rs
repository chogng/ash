//! One-row presentation state derived from the active Turn plan.

use crate::render::RenderContext;
use ash_protocol::PlanStepStatus;
use ash_protocol::PlanUpdate;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::widgets::Paragraph;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct PlanState {
    plan: Option<PlanUpdate>,
}

impl PlanState {
    pub(crate) fn replace(&mut self, plan: Option<PlanUpdate>) {
        self.plan = plan.filter(|plan| {
            !plan.steps.is_empty()
                && !plan
                    .steps
                    .iter()
                    .all(|step| step.status == PlanStepStatus::Completed)
        });
    }

    pub(crate) fn view(&self) -> Option<PlanInlineView<'_>> {
        let plan = self.plan.as_ref()?;
        let current = plan
            .steps
            .iter()
            .find(|step| step.status == PlanStepStatus::InProgress)
            .or_else(|| {
                plan.steps
                    .iter()
                    .find(|step| step.status == PlanStepStatus::Pending)
            })
            .or_else(|| plan.steps.last())?;
        Some(PlanInlineView {
            completed: plan
                .steps
                .iter()
                .filter(|step| step.status == PlanStepStatus::Completed)
                .count(),
            total: plan.steps.len(),
            current: &current.step,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct PlanInlineView<'a> {
    pub(crate) completed: usize,
    pub(crate) total: usize,
    pub(crate) current: &'a str,
}

pub(crate) fn desired_height(view: Option<PlanInlineView<'_>>) -> u16 {
    u16::from(view.is_some())
}

pub(crate) fn draw(
    frame: &mut Frame<'_>,
    area: Rect,
    view: Option<PlanInlineView<'_>>,
    context: RenderContext<'_>,
) {
    let Some(view) = view else {
        return;
    };
    frame.render_widget(
        Paragraph::new(format!(
            "Plan {}/{}: {}",
            view.completed, view.total, view.current
        ))
        .style(Style::default().fg(context.muted())),
        area,
    );
}

#[cfg(test)]
#[path = "plan_tests.rs"]
mod tests;
