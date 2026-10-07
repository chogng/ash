use super::validate_plan_update;
use ash_protocol::PlanStep;
use ash_protocol::PlanStepStatus;
use ash_protocol::PlanUpdate;

#[test]
fn accepts_one_active_step() {
    assert!(
        validate_plan_update(&PlanUpdate {
            explanation: Some("Working through the implementation.".into()),
            steps: vec![
                PlanStep {
                    step: "Inspect".into(),
                    status: PlanStepStatus::Completed,
                },
                PlanStep {
                    step: "Implement".into(),
                    status: PlanStepStatus::InProgress,
                },
            ],
        })
        .is_ok()
    );
}

#[test]
fn rejects_multiple_active_steps() {
    let error = validate_plan_update(&PlanUpdate {
        explanation: None,
        steps: vec![
            PlanStep {
                step: "One".into(),
                status: PlanStepStatus::InProgress,
            },
            PlanStep {
                step: "Two".into(),
                status: PlanStepStatus::InProgress,
            },
        ],
    })
    .unwrap_err();

    assert_eq!(error, "plan must contain at most one in_progress step");
}
