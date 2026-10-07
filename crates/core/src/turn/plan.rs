use ash_protocol::PlanStepStatus;
use ash_protocol::PlanUpdate;

const MAX_PLAN_STEPS: usize = 100;
const MAX_PLAN_STEP_CHARS: usize = 1_000;
const MAX_PLAN_EXPLANATION_CHARS: usize = 4_000;

pub(crate) fn validate_plan_update(plan: &PlanUpdate) -> Result<(), String> {
    if plan.steps.is_empty() || plan.steps.len() > MAX_PLAN_STEPS {
        return Err(format!(
            "plan must contain between 1 and {MAX_PLAN_STEPS} steps"
        ));
    }
    if plan
        .explanation
        .as_ref()
        .is_some_and(|value| value.chars().count() > MAX_PLAN_EXPLANATION_CHARS)
    {
        return Err(format!(
            "plan explanation exceeds {MAX_PLAN_EXPLANATION_CHARS} characters"
        ));
    }
    if let Some(step) = plan
        .steps
        .iter()
        .find(|step| step.step.trim().is_empty() || step.step.chars().count() > MAX_PLAN_STEP_CHARS)
    {
        return Err(format!(
            "plan step must contain between 1 and {MAX_PLAN_STEP_CHARS} characters: {:?}",
            step.step
        ));
    }
    let in_progress = plan
        .steps
        .iter()
        .filter(|step| step.status == PlanStepStatus::InProgress)
        .count();
    if in_progress > 1 {
        return Err("plan must contain at most one in_progress step".into());
    }
    Ok(())
}

#[cfg(test)]
#[path = "plan_tests.rs"]
mod tests;
