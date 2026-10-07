use super::PlanState;
use ash_protocol::PlanStep;
use ash_protocol::PlanStepStatus;
use ash_protocol::PlanUpdate;

#[test]
fn inline_plan_uses_one_current_step_and_hides_a_completed_plan() {
    let mut state = PlanState::default();
    state.replace(Some(PlanUpdate {
        explanation: None,
        steps: vec![
            PlanStep {
                step: "moved".into(),
                status: PlanStepStatus::Completed,
            },
            PlanStep {
                step: "wire layout".into(),
                status: PlanStepStatus::InProgress,
            },
        ],
    }));
    let view = state.view().unwrap();
    assert_eq!(
        (view.completed, view.total, view.current),
        (1, 2, "wire layout")
    );

    state.replace(Some(PlanUpdate {
        explanation: None,
        steps: vec![PlanStep {
            step: "done".into(),
            status: PlanStepStatus::Completed,
        }],
    }));
    assert_eq!(state.view(), None);
}
