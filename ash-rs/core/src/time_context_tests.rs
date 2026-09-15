use crate::*;
use ash_action_policy::ActionDigest;
use ash_action_policy::ActionKind;
use ash_action_policy::ActionPolicyRevision;
use ash_action_policy::ActionProvenance;
use ash_action_policy::ActionReviewRequest;
use ash_action_policy::ActionSource;
use ash_action_policy::CapabilitySet;
use ash_action_policy::ExecutionDecision;
use ash_action_policy::GrantId;
use ash_action_policy::ResolvedAction;
use ash_action_policy::SandboxCompatibility;
use ash_async_utils::CancellationToken;
use ash_protocol::*;
use serde_json::json;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

const BEFORE: u64 = 1_789_282_790_000;
const AFTER: u64 = 1_789_282_805_000;

#[derive(Default)]
struct Clock(Mutex<Option<TimeContext>>);
impl TimeContextProvider for Clock {
    fn snapshot(&self) -> Result<Option<TimeContext>, CoreError> {
        Ok(self.0.lock().unwrap().clone())
    }
}

fn time(at: u64, mode: TimeContextMode) -> TimeContext {
    ash_agent_environment::TimeSnapshot::capture(
        UnixMillis::new(at).unwrap(),
        "America/Los_Angeles".into(),
        TimeZoneOrigin::Configured,
        mode,
    )
    .unwrap()
    .facts()
    .clone()
}

fn start(threads: &ThreadController, thread: &ThreadId, command: &str, input: &str) -> TurnId {
    threads
        .start_turn(
            thread,
            StartTurnRequest {
                command_id: CommandId::new(command).unwrap(),
                expected_sequence: SequenceExpectation::Any,
                model: None,
                kind: TurnKind::Coding,
                instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
                policy_revision: "time-tests".into(),
                approval_mode: ApprovalMode::AskPermissions,
                tool_mode: ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![UserInput::Text { text: input.into() }],
            },
        )
        .unwrap()
        .turn_id
}

fn run(
    threads: &Arc<ThreadController>,
    thread: &ThreadId,
    turn: &TurnId,
    model: Arc<Model>,
    clock: Arc<Clock>,
) {
    let executor = TurnExecutor::new(
        threads.clone(),
        model,
        Arc::new(Advance(clock)),
        Arc::new(Policy),
    );
    executor.start(thread, turn).unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let snapshot = threads.read_thread(thread).unwrap();
        let turn = snapshot
            .turns
            .iter()
            .find(|entry| &entry.turn_id == turn)
            .unwrap();
        if turn.status == TurnStatus::Completed {
            break;
        }
        assert_ne!(turn.status, TurnStatus::Failed, "{:?}", turn.failure);
        assert!(
            Instant::now() < deadline,
            "time-context turn did not complete"
        );
        std::thread::yield_now();
    }
}

#[derive(Default)]
struct Model {
    requests: Mutex<Vec<ModelRequest>>,
    advance: bool,
}
impl ModelService for Model {
    fn invoke(
        &self,
        _: ModelSelection<'_>,
        request: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        let mut requests = self.requests.lock().unwrap();
        requests.push(request.clone());
        let output = if self.advance && requests.len() == 1 {
            vec![ResponseItem::ToolCall(ToolCall {
                id: ToolCallId::new("advance-time").unwrap(),
                name: ToolName::new("advance").unwrap(),
                arguments: json!({}),
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

struct Advance(Arc<Clock>);
impl ToolService for Advance {
    fn definitions(&self) -> Vec<ToolDefinition> {
        vec![ToolDefinition {
            name: ToolName::new("advance").unwrap(),
            description: "Advance the test clock across midnight".into(),
            parameters: json!({"type":"object"}),
            strict: true,
        }]
    }
    fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        Ok(ActionReviewRequest::new(
            ResolvedAction::new(
                ActionDigest::from_canonical_bytes(serde_json::to_vec(call).unwrap()),
                ActionKind::SystemOperation,
                "advance test time",
                CapabilitySet::default(),
            ),
            ActionProvenance::new(ActionSource::BuiltInTool, "advance"),
            SandboxCompatibility::NotApplicable {
                reason: "test clock".into(),
            },
            ActionPolicyRevision::new("time-tests"),
        ))
    }
    fn execute(
        &self,
        _: &ToolCall,
        _: &ToolAuthorization,
        _: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        *self.0.0.lock().unwrap() = Some(time(AFTER, TimeContextMode::Date));
        Ok(ToolExecutionOutput::Success("completed".into()))
    }
}
struct Policy;
impl ActionPolicyService for Policy {
    fn revision(&self) -> String {
        "time-tests".into()
    }
    fn decide(
        &self,
        _: &ActionReviewRequest,
        _: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        Ok(ExecutionDecision::RunUnsandboxed {
            grant_id: GrantId::new("test"),
        })
    }
}

#[test]
fn time_context_refreshes_after_tools_and_keeps_input_reference_through_recovery_and_fork() {
    let store = Arc::new(InMemoryThreadStore::default());
    let threads = Arc::new(ThreadController::with_store(store.clone()));
    let clock = Arc::new(Clock(Mutex::new(Some(time(BEFORE, TimeContextMode::Date)))));
    threads
        .install_time_context_provider(clock.clone())
        .unwrap();
    let thread = threads
        .start_thread(
            &NoThreadWorktreeBinder,
            StartThreadRequest {
                agent_id: None,
                agent: None,
                command_id: CommandId::new("root").unwrap(),
                title: "time".into(),
            },
        )
        .unwrap();
    let turn = start(
        &threads,
        &thread.thread_id,
        "start",
        "Inspect yesterday's logs.",
    );
    let model = Arc::new(Model {
        advance: true,
        ..Model::default()
    });
    run(
        &threads,
        &thread.thread_id,
        &turn,
        model.clone(),
        clock.clone(),
    );
    let requests = model.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    let first = serde_json::to_string(&requests[0]).unwrap();
    let second = serde_json::to_string(&requests[1]).unwrap();
    assert!(first.contains("date: 2026-09-12"));
    assert!(second.contains("date: 2026-09-13"));
    assert!(first.contains("date=\\\"2026-09-12\\\""));
    assert!(second.contains("date=\\\"2026-09-12\\\""));
    assert_eq!(requests[0].input[0], requests[1].input[0]);
    let snapshot = threads.read_thread(&thread.thread_id).unwrap();
    let user = snapshot
        .items
        .iter()
        .find(|item| matches!(item, ThreadItem::UserMessage { .. }))
        .unwrap();
    assert_eq!(
        snapshot.user_time_contexts.get(user.item_id()),
        Some(&time(BEFORE, TimeContextMode::Date))
    );
    assert!(
        matches!(user, ThreadItem::UserMessage { text, .. } if text == "Inspect yesterday's logs.")
    );
    let audits = store
        .events()
        .into_iter()
        .filter_map(|event| match event.event {
            ThreadEvent::ModelInvocationRecorded { record, .. } => record.time_context,
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        audits,
        vec![
            time(BEFORE, TimeContextMode::Date),
            time(AFTER, TimeContextMode::Date)
        ]
    );
    let compact = threads
        .start_context_compaction(
            &thread.thread_id,
            StartContextCompactionRequest {
                command_id: CommandId::new("compact-time").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                model: None,
                policy_revision: "time-tests".into(),
                retention_prompt: None,
            },
        )
        .unwrap();
    let crate::context::ManualContextCompactionPreparation::NeedsCompaction { plan, .. } = threads
        .prepare_manual_context_compaction(
            &thread.thread_id,
            &compact.turn_id,
            ContextBudget::provider_managed(),
        )
        .unwrap()
    else {
        panic!("completed history should be compactable")
    };
    assert!(plan.source_items.iter().any(|item| matches!(item, ThreadItem::UserMessage { text, .. } if text.contains("date=\"2026-09-12\""))));
    threads
        .complete_turn_without_agent_message(&thread.thread_id, &compact.turn_id)
        .unwrap();
    let encoded = serde_json::to_vec(&store.events()).unwrap();
    let decoded: Vec<ash_history::StoredEvent> = serde_json::from_slice(&encoded).unwrap();
    assert_eq!(decoded, store.events());
    let recovered = ThreadController::with_store(store);
    let recovered_snapshot = recovered.recover_thread(&thread.thread_id).unwrap();
    assert_eq!(
        recovered_snapshot.user_time_contexts,
        snapshot.user_time_contexts
    );
    let fork = recovered
        .fork_thread(
            &NoThreadWorktreeBinder,
            ForkThreadRequest {
                command_id: CommandId::new("fork").unwrap(),
                source_thread_id: thread.thread_id,
                title: "fork".into(),
            },
        )
        .unwrap();
    assert_eq!(
        recovered
            .read_thread(&fork.thread_id)
            .unwrap()
            .user_time_contexts,
        snapshot.user_time_contexts
    );
}

#[test]
fn time_context_off_emits_no_time_and_legacy_input_is_not_assigned_a_new_reference() {
    let store = Arc::new(InMemoryThreadStore::default());
    let threads = Arc::new(ThreadController::with_store(store));
    let clock = Arc::new(Clock::default());
    threads
        .install_time_context_provider(clock.clone())
        .unwrap();
    let thread = threads
        .start_thread(
            &NoThreadWorktreeBinder,
            StartThreadRequest {
                agent_id: None,
                agent: None,
                command_id: CommandId::new("off-root").unwrap(),
                title: "off".into(),
            },
        )
        .unwrap();
    let turn = start(
        &threads,
        &thread.thread_id,
        "off",
        "Explain this algorithm.",
    );
    let model = Arc::new(Model::default());
    run(
        &threads,
        &thread.thread_id,
        &turn,
        model.clone(),
        clock.clone(),
    );
    let off = serde_json::to_string(&model.requests.lock().unwrap()[0]).unwrap();
    assert!(!off.contains("time_context"));
    assert!(!off.contains("user_time"));
    let old = threads.read_thread(&thread.thread_id).unwrap();
    assert!(old.user_time_contexts.is_empty());
    *clock.0.lock().unwrap() = Some(time(AFTER, TimeContextMode::Time));
    let next = start(&threads, &thread.thread_id, "enabled", "Continue.");
    let model = Arc::new(Model::default());
    run(&threads, &thread.thread_id, &next, model.clone(), clock);
    let enabled = serde_json::to_string(&model.requests.lock().unwrap()[0]).unwrap();
    assert!(enabled.contains("2026-09-13T00:00:05-07:00"));
    assert!(enabled.contains("unavailable=\\\"true\\\""));
}
