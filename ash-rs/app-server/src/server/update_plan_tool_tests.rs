use super::*;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;
use ash_action_policy::ExecutionDecision;
use ash_action_policy::GrantId;
use core_api::ActionPolicyService;
use ash_core::CreateThreadRequest;
use ash_core::InMemoryThreadStore;
use core_api::ModelSelection;
use core_api::ModelService;
use core_api::SequenceExpectation;
use ash_core::StartTurnRequest;
use ash_core::ThreadController;
use ash_core::TurnExecutor;
use ash_protocol::ApprovalMode;
use ash_protocol::CommandId;
use ash_protocol::ModelRequest;
use ash_protocol::ModelResponse;
use ash_protocol::ResponseItem;
use ash_protocol::SessionId;
use ash_protocol::StopReason;
use ash_protocol::ThreadId;
use ash_protocol::ToolCallId;
use ash_protocol::TurnStatus;
use ash_protocol::UserInput;

#[test]
fn definition_exposes_strict_snake_case_plan_contract() {
    let definition = definition();

    assert_eq!(definition.name.as_str(), UPDATE_PLAN_TOOL_NAME);
    assert!(definition.strict);
    assert_eq!(
        definition.parameters["properties"]["plan"]["items"]["properties"]["status"]["enum"],
        json!(["pending", "in_progress", "completed"])
    );
    assert_eq!(
        definition.parameters["required"],
        json!(["explanation", "plan"])
    );
    assert_eq!(definition.parameters["additionalProperties"], false);
}

#[test]
fn arguments_accept_snake_case_status_and_reject_unknown_fields() {
    let arguments: UpdatePlanArguments = serde_json::from_value(json!({
        "explanation": "Implement and verify",
        "plan": [
            { "step": "Implement", "status": "in_progress" },
            { "step": "Verify", "status": "pending" }
        ]
    }))
    .unwrap();

    assert_eq!(
        arguments.explanation.as_deref(),
        Some("Implement and verify")
    );
    assert_eq!(arguments.plan.len(), 2);
    assert!(matches!(
        arguments.plan[0].status,
        UpdatePlanStatusArguments::InProgress
    ));
    assert!(
        serde_json::from_value::<UpdatePlanArguments>(json!({
            "explanation": null,
            "plan": [{ "step": "Implement", "status": "inProgress" }]
        }))
        .is_err()
    );
    assert!(
        serde_json::from_value::<UpdatePlanArguments>(json!({
            "explanation": null,
            "plan": [{ "step": "Implement", "status": "pending", "extra": true }]
        }))
        .is_err()
    );
}

#[test]
fn tool_call_durably_updates_the_running_turn_plan() {
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    let thread_id = ThreadId::new("plan-thread").unwrap();
    threads
        .create_thread(CreateThreadRequest {
            agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
            origin: Default::default(),
            agent: None,
            session_id: SessionId::new("plan-session").unwrap(),
            thread_id: thread_id.clone(),
            title: "plan".into(),
        })
        .unwrap();
    let turn_id = threads
        .start_turn(
            &thread_id,
            StartTurnRequest {
                kind: ash_protocol::TurnKind::Coding,
                instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
                command_id: CommandId::new("plan-start").unwrap(),
                expected_sequence: SequenceExpectation::Exact(1),
                model: None,
                policy_revision: "plan-policy-v1".into(),
                approval_mode: ApprovalMode::AskPermissions,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![UserInput::Text {
                    text: "implement".into(),
                }],
            },
        )
        .unwrap()
        .turn_id;
    let model = Arc::new(PlanModel::default());
    let executor = TurnExecutor::new(
        threads.clone(),
        model,
        Arc::new(UpdatePlanToolService::new(Arc::clone(&threads))),
        Arc::new(PlanPolicy),
    );

    executor.start(&thread_id, &turn_id).unwrap();
    let deadline = Instant::now() + Duration::from_secs(1);
    let snapshot = loop {
        let snapshot = threads.read_thread(&thread_id).unwrap();
        if snapshot.turns[0].status == TurnStatus::Completed {
            break snapshot;
        }
        assert!(Instant::now() < deadline, "plan Turn did not complete");
        std::thread::yield_now();
    };

    assert_eq!(snapshot.turns[0].status, TurnStatus::Completed);
    assert_eq!(
        snapshot.turns[0].plan.as_ref().unwrap().steps,
        vec![
            PlanStep {
                step: "Implement".into(),
                status: PlanStepStatus::Completed,
            },
            PlanStep {
                step: "Verify".into(),
                status: PlanStepStatus::InProgress,
            },
        ]
    );
}

#[derive(Default)]
struct PlanModel {
    calls: AtomicUsize,
}

impl ModelService for PlanModel {
    fn invoke(
        &self,
        _: ModelSelection<'_>,
        _: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        let output = if self.calls.fetch_add(1, Ordering::Relaxed) == 0 {
            vec![ResponseItem::ToolCall(ToolCall {
                id: ToolCallId::new("update-plan-call").unwrap(),
                name: ToolName::new(UPDATE_PLAN_TOOL_NAME).unwrap(),
                arguments: json!({
                    "explanation": "Implementation complete",
                    "plan": [
                        { "step": "Implement", "status": "completed" },
                        { "step": "Verify", "status": "in_progress" }
                    ]
                }),
            })]
        } else {
            vec![ResponseItem::Text("done".into())]
        };
        Ok(ModelResponse {
            output,
            usage: None,
            billing: None,
            stop_reason: StopReason::Completed,
        })
    }
}

struct PlanPolicy;

impl ActionPolicyService for PlanPolicy {
    fn revision(&self) -> String {
        "plan-policy-v1".into()
    }

    fn decide(
        &self,
        _: &ActionReviewRequest,
        _: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        Ok(ExecutionDecision::RunUnsandboxed {
            grant_id: GrantId::new("plan-test"),
        })
    }
}
