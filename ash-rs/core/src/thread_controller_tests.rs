use super::*;
use crate::thread_controller::CommitContextCheckpointRequest;
use crate::thread_controller::live_interaction;
use ash_async_utils::CancellationSource;
use ash_history::StoredEvent;
use ash_protocol::ActionApprovalCapability;
use ash_protocol::ActionApprovalCapabilityKind;
use ash_protocol::ActionApprovalDecision;
use ash_protocol::ActionApprovalRequest;
use ash_protocol::ActionApprovalResponse;
use ash_protocol::AgentRequest;
use ash_protocol::AgentResponse;
use ash_protocol::CommandId;
use ash_protocol::ContextSourceRange;
use ash_protocol::InteractionDeadline;
use ash_protocol::ModelBillingScope;
use ash_protocol::ModelId;
use ash_protocol::ModelRef;
use ash_protocol::ModelResponseBilling;
use ash_protocol::ModelUsage;
use ash_protocol::PlanStep;
use ash_protocol::PlanStepStatus;
use ash_protocol::PlanUpdate;
use ash_protocol::ProviderId;
use ash_protocol::RequestId;
use ash_protocol::RequestUserInput;
use ash_protocol::RequestUserInputResponse;
use ash_protocol::SessionId;
use ash_protocol::StableTurnError;
use ash_protocol::StableTurnErrorCode;
use ash_protocol::ThreadEvent;
use ash_protocol::ThreadGoalStatus;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::ToolCallId;
use ash_protocol::ToolName;
use ash_protocol::TurnId;
use ash_protocol::UserInput;
use ash_protocol::UserInputQuestion;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

struct OneShotActivation {
    calls: Arc<AtomicU64>,
}

impl ash_extension_api::SkillActivationContributor for OneShotActivation {
    fn contribute(
        &self,
        _: ash_extension_api::SkillActivationContext<'_>,
    ) -> Result<Vec<ash_protocol::FrozenSkillActivation>, ash_extension_api::ExtensionError> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        Ok(Vec::new())
    }
}

struct AutomaticActivation {
    calls: Arc<AtomicU64>,
}

impl ash_extension_api::SkillActivationContributor for AutomaticActivation {
    fn contribute(
        &self,
        _: ash_extension_api::SkillActivationContext<'_>,
    ) -> Result<Vec<ash_protocol::FrozenSkillActivation>, ash_extension_api::ExtensionError> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        Ok(vec![automatic_test_activation()])
    }
}

static NEXT_THREAD: AtomicU64 = AtomicU64::new(1);

fn start_request(key: &str) -> StartTurnRequest {
    StartTurnRequest {
        advisor: None,
        kind: ash_protocol::TurnKind::Coding,
        instructions: crate::test_turn_instructions(),
        command_id: CommandId::new(key).expect("test ID is non-empty"),
        expected_sequence: SequenceExpectation::Any,
        model: None,
        policy_revision: "test-policy-v1".into(),
        approval_mode: ash_protocol::ApprovalMode::AskPermissions,
        tool_mode: ash_protocol::ToolMode::Direct,
        tool_profile: None,
        activated_skills: Vec::new(),
        input: vec![UserInput::Text {
            text: "hello".into(),
        }],
    }
}

fn automatic_test_activation() -> ash_protocol::FrozenSkillActivation {
    ash_protocol::FrozenSkillActivation {
        id: ash_protocol::SkillId::new(
            ash_protocol::SkillSourceId::new("builtin:skill-source:test").unwrap(),
            ash_protocol::SkillName::new("review").unwrap(),
        ),
        content_digest: ash_protocol::ContentDigest::sha256(b"review body"),
        catalog_generation: 7,
        reason: ash_protocol::SkillActivationReason::Automatic,
    }
}

fn create_thread(controller: &ThreadController, title: &str) -> ThreadId {
    let thread_id = ThreadId::new(format!(
        "thread_{}",
        NEXT_THREAD.fetch_add(1, Ordering::Relaxed)
    ))
    .expect("test ID is non-empty");
    controller
        .create_thread(CreateThreadRequest {
            agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
            origin: Default::default(),
            agent: None,
            session_id: SessionId::new("session_1").expect("test ID is non-empty"),
            thread_id: thread_id.clone(),
            title: title.into(),
        })
        .unwrap();
    thread_id
}

#[test]
fn restoring_a_session_replays_durably_without_reopening_children() {
    let store = Arc::new(InMemoryThreadStore::default());
    let threads = ThreadController::with_store(store.clone());
    let session_id = SessionId::new("restore-session").unwrap();
    let root = ThreadId::new(session_id.as_str()).unwrap();
    let child = ThreadId::new("restore-child").unwrap();
    for id in [&root, &child] {
        threads
            .create_thread(CreateThreadRequest {
                agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
                origin: Default::default(),
                agent: None,
                session_id: session_id.clone(),
                thread_id: id.clone(),
                title: id.to_string(),
            })
            .unwrap();
    }
    threads
        .start_turn(&root, start_request("before-archive"))
        .unwrap();
    threads
        .archive_session_threads(
            &session_id,
            &CommandId::new("archive").unwrap(),
            ash_protocol::ThreadArchiveReason::Completed,
        )
        .unwrap();
    let before = threads.read_thread(&root).unwrap();
    let restored = threads.restore_session(&session_id).unwrap();
    assert_eq!(restored.status, ash_protocol::ThreadStatus::Active);
    assert_eq!(restored.turns, before.turns);
    assert_eq!(restored.archived_at_unix_ms, None);
    assert_eq!(restored.archive_reason, None);
    assert_eq!(
        threads.restore_session(&session_id).unwrap().sequence,
        restored.sequence
    );
    drop(threads);
    let reopened = ThreadController::with_store(store);
    assert_eq!(
        reopened.read_thread(&root).unwrap().status,
        ash_protocol::ThreadStatus::Active
    );
    assert_eq!(
        reopened.read_thread(&child).unwrap().status,
        ash_protocol::ThreadStatus::Archived
    );
    assert!(
        reopened
            .start_turn(&root, start_request("after-restore"))
            .is_ok()
    );
}

#[test]
fn deleting_a_session_forgets_loaded_threads_and_keeps_other_sessions() {
    let store = Arc::new(InMemoryThreadStore::default());
    let threads = ThreadController::with_store(store);
    let deleted_session = SessionId::new("session_1").unwrap();
    let first = create_thread(&threads, "First");
    let second = create_thread(&threads, "Second");
    let kept_session = SessionId::new("session_2").unwrap();
    let kept = ThreadId::new("thread_kept").unwrap();
    threads
        .create_thread(CreateThreadRequest {
            agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
            origin: Default::default(),
            agent: None,
            session_id: kept_session.clone(),
            thread_id: kept.clone(),
            title: "Kept".into(),
        })
        .unwrap();
    threads.read_thread(&first).unwrap();
    threads
        .archive_session_threads(
            &deleted_session,
            &CommandId::new("archive-before-delete").unwrap(),
            ash_protocol::ThreadArchiveReason::Stopped,
        )
        .unwrap();

    let mut expected = vec![first.clone(), second.clone()];
    expected.sort();
    assert_eq!(
        threads.delete_session_threads(&deleted_session).unwrap(),
        expected
    );

    assert!(matches!(
        threads.read_thread(&first),
        Err(CoreError::NotFound(_))
    ));
    assert!(matches!(
        threads.read_thread(&second),
        Err(CoreError::NotFound(_))
    ));
    assert_eq!(threads.read_thread(&kept).unwrap().session_id, kept_session);
    assert!(
        threads
            .list_loaded_threads()
            .unwrap()
            .iter()
            .all(|thread| thread.session_id != deleted_session)
    );
}

fn start_turn(threads: &ThreadController, thread: &ThreadId, key: &str) -> TurnId {
    threads
        .start_turn(thread, start_request(key))
        .unwrap()
        .turn_id
}

fn user_input_interaction() -> AgentRequest {
    AgentRequest::UserInput {
        request: RequestUserInput {
            questions: vec![UserInputQuestion {
                id: "answer".into(),
                header: "Answer".into(),
                question: "Continue?".into(),
                options: Vec::new(),
                allow_free_form: true,
            }],
        },
    }
}

fn user_input_response() -> AgentResponse {
    AgentResponse::UserInput {
        response: RequestUserInputResponse {
            answers: BTreeMap::new(),
        },
    }
}

fn approval_interaction() -> AgentRequest {
    AgentRequest::Approval {
        request: ActionApprovalRequest {
            action_digest: "a".repeat(64),
            policy_revision: "policy-1".into(),
            capabilities: vec![ActionApprovalCapability {
                kind: ActionApprovalCapabilityKind::Network,
                scope: "api.example.com".into(),
            }],
            reason: "network requires unsandboxed execution".into(),
            sandbox_denial: None,
        },
    }
}

fn approval_response(decision: ActionApprovalDecision) -> AgentResponse {
    AgentResponse::Approval {
        response: ActionApprovalResponse { decision },
    }
}

#[test]
fn completion_is_durable_before_snapshot_exposes_it() {
    let journal = Arc::new(InMemoryThreadStore::default());
    let threads = ThreadController::with_store(journal.clone());
    let thread = create_thread(&threads, "test");
    let turn = start_turn(&threads, &thread, "completion");
    threads
        .complete_turn(&thread, &turn, "answer".into())
        .unwrap();
    let snapshot = threads.read_thread(&thread).unwrap();
    assert_eq!(snapshot.turns[0].turn_id, turn);
    assert_eq!(snapshot.turns[0].status, TurnStatus::Completed);
    assert_eq!(
        journal.events().last().unwrap().event.kind(),
        "turn.completed"
    );
}

#[test]
fn thread_catalog_marks_only_unfinished_work_for_startup_recovery() {
    let journal = Arc::new(InMemoryThreadStore::default());
    let threads = ThreadController::with_store(journal);
    let thread = create_thread(&threads, "catalog");
    assert!(
        !threads
            .thread_catalog_record(&thread)
            .unwrap()
            .requires_startup_recovery
    );

    let turn = start_turn(&threads, &thread, "catalog-turn");
    assert!(
        threads
            .thread_catalog_record(&thread)
            .unwrap()
            .requires_startup_recovery
    );

    threads
        .complete_turn(&thread, &turn, "done".into())
        .unwrap();
    assert!(
        !threads
            .thread_catalog_record(&thread)
            .unwrap()
            .requires_startup_recovery
    );
}

#[test]
fn failure_is_durable_before_snapshot_exposes_it() {
    let journal = Arc::new(InMemoryThreadStore::default());
    let threads = ThreadController::with_store(journal.clone());
    let thread = create_thread(&threads, "test");
    let turn = start_turn(&threads, &thread, "failure");
    threads
        .fail_turn(&thread, &turn, StableTurnError::model_invocation_failed())
        .unwrap();
    let snapshot = threads.read_thread(&thread).unwrap();
    assert_eq!(snapshot.turns[0].status, TurnStatus::Failed);
    assert_eq!(
        snapshot.turns[0].failure.as_ref().unwrap().code,
        StableTurnErrorCode::ModelInvocationFailed
    );
}

#[test]
fn thread_goal_lifecycle_is_durable_and_unfinished_goals_cannot_be_replaced() {
    let store = Arc::new(InMemoryThreadStore::default());
    let threads = ThreadController::with_store(store.clone());
    let thread = create_thread(&threads, "goal lifecycle");

    let created = threads
        .create_goal(&thread, "finish the implementation".into(), Some(100))
        .unwrap();
    assert_eq!(created.status, ThreadGoalStatus::Active);
    assert_eq!(created.tokens_used, 0);
    assert_eq!(threads.get_goal(&thread).unwrap(), Some(created.clone()));
    assert!(
        threads
            .create_goal(&thread, "a duplicate objective".into(), None)
            .is_err()
    );

    let paused = threads
        .set_goal(
            &thread,
            SetGoalRequest {
                objective: Some("finish the implementation carefully".into()),
                status: Some(ThreadGoalStatus::Paused),
                token_budget: Some(Some(200)),
            },
        )
        .unwrap()
        .goal;
    assert_eq!(paused.goal_id, created.goal_id);
    assert_eq!(paused.status, ThreadGoalStatus::Paused);
    assert!(
        threads
            .create_goal(&thread, "still a duplicate".into(), None)
            .is_err()
    );

    let completed = threads
        .set_goal(
            &thread,
            SetGoalRequest {
                status: Some(ThreadGoalStatus::Complete),
                ..SetGoalRequest::default()
            },
        )
        .unwrap()
        .goal;
    assert_eq!(completed.status, ThreadGoalStatus::Complete);
    let replacement = threads
        .create_goal(&thread, "start the next objective".into(), Some(50))
        .unwrap();
    assert_ne!(replacement.goal_id, completed.goal_id);
    assert!(threads.clear_goal(&thread).unwrap());
    assert!(!threads.clear_goal(&thread).unwrap());

    let recovered = ThreadController::with_store(store)
        .recover_thread(&thread)
        .unwrap();
    assert_eq!(recovered.goal, None);
}

#[test]
fn thread_goal_usage_accumulates_across_turns_without_inventing_missing_input() {
    let store = Arc::new(InMemoryThreadStore::default());
    let threads = ThreadController::with_store(store.clone());
    let thread = create_thread(&threads, "goal usage");
    threads
        .create_goal(&thread, "finish the implementation".into(), Some(15))
        .unwrap();

    let first_turn = start_turn(&threads, &thread, "goal-usage-first");
    threads
        .record_model_usage(
            &thread,
            &first_turn,
            Some(ModelUsage {
                input_tokens: Some(10),
                cached_input_tokens: Some(2),
                cache_write_input_tokens: Some(0),
                output_tokens: Some(3),
                reasoning_tokens: None,
            }),
        )
        .unwrap();
    threads
        .complete_turn(&thread, &first_turn, "first answer".into())
        .unwrap();

    let second_turn = start_turn(&threads, &thread, "goal-usage-second");
    threads
        .record_model_usage(
            &thread,
            &second_turn,
            Some(ModelUsage {
                input_tokens: Some(4),
                cached_input_tokens: Some(0),
                cache_write_input_tokens: Some(0),
                output_tokens: Some(0),
                reasoning_tokens: None,
            }),
        )
        .unwrap();
    assert_eq!(threads.get_goal(&thread).unwrap().unwrap().tokens_used, 15);
    threads
        .record_model_usage(
            &thread,
            &second_turn,
            Some(ModelUsage {
                input_tokens: Some(1),
                cached_input_tokens: Some(0),
                cache_write_input_tokens: Some(0),
                output_tokens: Some(2),
                reasoning_tokens: None,
            }),
        )
        .unwrap();
    threads
        .complete_turn(&thread, &second_turn, "second answer".into())
        .unwrap();

    let third_turn = start_turn(&threads, &thread, "goal-usage-third");
    threads
        .record_model_usage(
            &thread,
            &third_turn,
            Some(ModelUsage {
                input_tokens: Some(100),
                cached_input_tokens: None,
                cache_write_input_tokens: None,
                output_tokens: Some(100),
                reasoning_tokens: None,
            }),
        )
        .unwrap();

    let goal = threads.get_goal(&thread).unwrap().unwrap();
    assert_eq!(goal.tokens_used, 18);
    assert_eq!(goal.status, ThreadGoalStatus::BudgetLimited);
    assert_eq!(goal.remaining_tokens(), Some(0));

    let recovered = ThreadController::with_store(store)
        .recover_thread(&thread)
        .unwrap();
    assert_eq!(recovered.goal, Some(goal));
}

#[test]
fn completed_fast_response_records_the_reported_price() {
    let store = Arc::new(InMemoryThreadStore::default());
    let threads = ThreadController::with_store(store.clone());
    let thread = create_thread(&threads, "fast accounting");
    let requested_model = ModelRef::new(
        ProviderId::new("openai").unwrap(),
        ModelId::new("gpt-5.6").unwrap(),
    );
    let mut request = start_request("fast-accounting");
    request.model = Some(requested_model.clone());
    let turn = threads.start_turn(&thread, request).unwrap().turn_id;

    threads
        .record_model_invocation(
            &thread,
            &turn,
            Some(&requested_model),
            Some(&ModelResponseBilling {
                resolved_model: Some(ModelId::new("gpt-5.6-sol").unwrap()),
                applied_service_tier: Some("priority".into()),
            }),
            ModelBillingScope::PublicApi,
            Some(ModelUsage {
                input_tokens: Some(1_100),
                cached_input_tokens: Some(100),
                cache_write_input_tokens: Some(0),
                output_tokens: Some(50),
                reasoning_tokens: None,
            }),
            None,
            None,
            1_788_480_000_000,
            1_788_480_000_100,
        )
        .unwrap();

    let events = store.events();
    let ash_protocol::ThreadEvent::ModelInvocationRecorded { record, .. } =
        &events.last().unwrap().event
    else {
        panic!("expected a model invocation fact");
    };
    let ash_protocol::ModelReferenceCostRecord::Complete { cost } = &record.reference_cost else {
        panic!("expected a complete reference cost");
    };
    assert_eq!(
        record.resolved_model.as_ref().unwrap().as_str(),
        "gpt-5.6-sol"
    );
    assert_eq!(cost.amount.pico_units, "10080000000");
    assert_eq!(
        threads.read_thread(&thread).unwrap().reference_cost,
        ash_protocol::ModelReferenceCostSummary {
            known_amounts: vec![ash_protocol::ModelMoneyAmount {
                currency: "USD".into(),
                pico_units: "10080000000".into(),
            }],
            complete: true,
        }
    );
}

#[test]
fn thread_goal_turn_failures_stop_the_goal_with_their_stable_category() {
    let threads = ThreadController::with_store(Arc::new(InMemoryThreadStore::default()));
    let thread = create_thread(&threads, "goal failure");
    threads
        .create_goal(&thread, "finish the implementation".into(), None)
        .unwrap();

    let blocked_turn = start_turn(&threads, &thread, "goal-blocked");
    threads
        .fail_turn(
            &thread,
            &blocked_turn,
            StableTurnError::model_invocation_failed(),
        )
        .unwrap();
    assert_eq!(
        threads.get_goal(&thread).unwrap().unwrap().status,
        ThreadGoalStatus::Blocked
    );

    threads
        .set_goal(
            &thread,
            SetGoalRequest {
                status: Some(ThreadGoalStatus::Active),
                ..SetGoalRequest::default()
            },
        )
        .unwrap();
    let limited_turn = start_turn(&threads, &thread, "goal-usage-limited");
    threads
        .fail_turn(&thread, &limited_turn, StableTurnError::usage_limited())
        .unwrap();
    assert_eq!(
        threads.get_goal(&thread).unwrap().unwrap().status,
        ThreadGoalStatus::UsageLimited
    );
}

#[test]
fn terminal_turn_cannot_restart() {
    assert!(
        crate::state::transition_turn_status(TurnStatus::Completed, TurnStatus::Running).is_err()
    );
}

#[test]
fn accepted_turn_can_be_cancelled_before_it_starts_running() {
    assert_eq!(
        crate::state::transition_turn_status(TurnStatus::Created, TurnStatus::Cancelling).unwrap(),
        TurnStatus::Cancelling
    );
}

#[test]
fn item_and_tool_terminal_states_are_distinct() {
    assert_eq!(
        ItemStatus::Created
            .transition(ItemStatus::InProgress)
            .unwrap(),
        ItemStatus::InProgress
    );
    assert_eq!(
        ToolCallStatus::AwaitingApproval
            .transition(ToolCallStatus::Declined)
            .unwrap(),
        ToolCallStatus::Declined
    );
    assert!(
        ToolCallStatus::Declined
            .transition(ToolCallStatus::Running)
            .is_err()
    );
}

struct ToggleStore {
    reject_writes: AtomicBool,
}

impl agent_graph_store::AgentGraphStore for ToggleStore {
    fn read_agent(
        &self,
        _agent_id: &ash_protocol::AgentId,
    ) -> Result<Option<agent_graph_store::AgentRecord>, agent_graph_store::AgentGraphStoreError>
    {
        Ok(None)
    }
    fn read_thread_binding(
        &self,
        _thread_id: &ThreadId,
    ) -> Result<Option<agent_graph_store::ThreadBinding>, agent_graph_store::AgentGraphStoreError>
    {
        Ok(None)
    }
    fn list_agent_threads(
        &self,
        _agent_id: &ash_protocol::AgentId,
    ) -> Result<Vec<agent_graph_store::ThreadBinding>, agent_graph_store::AgentGraphStoreError>
    {
        Ok(Vec::new())
    }
    fn list_spawn_children(
        &self,
        _thread_id: &ThreadId,
    ) -> Result<Vec<ThreadId>, agent_graph_store::AgentGraphStoreError> {
        Ok(Vec::new())
    }
    fn list_spawn_descendants(
        &self,
        _thread_id: &ThreadId,
    ) -> Result<Vec<ThreadId>, agent_graph_store::AgentGraphStoreError> {
        Ok(Vec::new())
    }
}

impl ThreadStore for ToggleStore {
    fn pending_checkpoint_cleanup(
        &self,
    ) -> Result<Vec<(String, ash_protocol::RepositoryCheckpoint)>, ThreadStoreError> {
        Ok(Vec::new())
    }
    fn acknowledge_checkpoint_cleanup(&self, _: &str) -> Result<(), ThreadStoreError> {
        Ok(())
    }

    fn load_history_prefix(
        &self,
        _prefix: &ash_protocol::HistoryPrefixRef,
    ) -> Result<ash_history::HistoryPrefix, ThreadStoreError> {
        Err(ThreadStoreError::Storage("no history prefix".into()))
    }

    fn list_session_thread_ids(
        &self,
        session_id: &SessionId,
    ) -> Result<Vec<ThreadId>, ThreadStoreError> {
        let _ = session_id;
        Ok(Vec::new())
    }

    fn list_thread_ids(&self) -> Result<Vec<ThreadId>, ThreadStoreError> {
        Ok(Vec::new())
    }

    fn load(&self, _: &ThreadId) -> Result<Vec<StoredEvent>, ThreadStoreError> {
        Ok(Vec::new())
    }

    fn list_catalog(&self) -> Result<Vec<ash_thread_store::ThreadCatalogRecord>, ThreadStoreError> {
        Ok(Vec::new())
    }

    fn list_sessions(&self) -> Result<Vec<ash_protocol::Session>, ThreadStoreError> {
        Ok(Vec::new())
    }

    fn read_session(
        &self,
        _: &SessionId,
    ) -> Result<Option<ash_protocol::Session>, ThreadStoreError> {
        Ok(None)
    }

    fn session_catalog(
        &self,
        _: &SessionId,
    ) -> Result<Vec<ash_thread_store::ThreadCatalogRecord>, ThreadStoreError> {
        Ok(Vec::new())
    }

    fn backfill_catalog(
        &self,
        _: &ash_thread_store::ThreadCatalogRecord,
    ) -> Result<(), ThreadStoreError> {
        Ok(())
    }

    fn rebuild_session(&self, _: &SessionId) -> Result<(), ThreadStoreError> {
        Ok(())
    }

    fn delete_session(&self, _: &SessionId) -> Result<Vec<ThreadId>, ThreadStoreError> {
        Ok(Vec::new())
    }

    fn append_batch(
        &self,
        batch: &ThreadEventBatch,
    ) -> Result<AppendBatchResult, ThreadStoreError> {
        if self.reject_writes.load(Ordering::Relaxed) {
            Err(ThreadStoreError::Storage("simulated write failure".into()))
        } else {
            validate_append_batch(batch, batch.expected_sequence)
        }
    }
}

#[test]
fn failed_writes_do_not_expose_uncommitted_projection_changes() {
    let store = Arc::new(ToggleStore {
        reject_writes: AtomicBool::new(false),
    });
    let threads = ThreadController::with_store(store.clone());
    let thread = create_thread(&threads, "test");
    store.reject_writes.store(true, Ordering::Relaxed);

    assert!(
        threads
            .start_turn(&thread, start_request("failed-start"))
            .is_err()
    );
    assert!(threads.read_thread(&thread).unwrap().turns.is_empty());
}

#[test]
fn context_checkpoint_is_durable_before_projection_and_recovers_exactly() {
    let store = Arc::new(InMemoryThreadStore::default());
    let threads = ThreadController::with_store(store.clone());
    let thread = create_thread(&threads, "checkpoint");
    let turn = start_turn(&threads, &thread, "checkpoint-turn");
    threads
        .complete_turn(&thread, &turn, "answer".into())
        .unwrap();
    let source = threads.read_thread(&thread).unwrap();
    let checkpoint = threads
        .commit_context_checkpoint(&thread, checkpoint_request(&source, source.sequence))
        .unwrap();

    assert_eq!(
        store.events().last().unwrap().event.kind(),
        "context.checkpoint_committed"
    );
    assert_eq!(
        threads.read_thread(&thread).unwrap().context_checkpoints,
        vec![checkpoint.clone()]
    );
    let recovered = ThreadController::with_store(store)
        .recover_thread(&thread)
        .unwrap();
    assert_eq!(recovered.context_checkpoints, vec![checkpoint]);
}

#[test]
fn fork_retains_large_history_without_copying_turn_events() {
    let store = Arc::new(InMemoryThreadStore::default());
    let threads = ThreadController::with_store(store.clone());
    let source_thread_id = create_thread(&threads, "large-fork-source");
    for index in 0..64 {
        let turn_id = start_turn(&threads, &source_thread_id, &format!("fork-turn-{index}"));
        threads
            .complete_turn(
                &source_thread_id,
                &turn_id,
                format!("answer-{index}-{}", "x".repeat(4_096)),
            )
            .unwrap();
    }
    let source_sequence = threads.read_thread(&source_thread_id).unwrap().sequence;
    let child_thread_id = ThreadId::new("large-fork-child").unwrap();

    let child = threads
        .create_forked_thread(CreateForkedThreadRequest {
            session_id: SessionId::new("session_1").unwrap(),
            thread_id: child_thread_id.clone(),
            title: "large fork child".into(),
            source_thread_id,
            source_sequence,
        })
        .unwrap();

    assert_eq!(child.turns.len(), 64);
    let child_events = store
        .events()
        .into_iter()
        .filter(|event| event.thread_id == child_thread_id)
        .collect::<Vec<_>>();
    assert_eq!(child_events.len(), 2);
    let ThreadEvent::HistoryPrefixBound { prefix, .. } = &child_events[1].event else {
        panic!("fork must bind an immutable prefix");
    };
    let retained = store.load_history_prefix(prefix).unwrap();
    assert_eq!(retained.events.len() as u64, source_sequence);
    assert!(
        retained
            .events
            .iter()
            .all(|event| event.thread_id == prefix.source_thread_id)
    );
    let restarted = ThreadController::with_store(store);
    assert_eq!(restarted.read_thread(&child_thread_id).unwrap(), child);
}

#[test]
fn forked_thread_can_supersede_an_inherited_checkpoint() {
    let threads = ThreadController::with_store(Arc::new(InMemoryThreadStore::default()));
    let source_thread_id = create_thread(&threads, "checkpoint-source");
    let source_turn_id = start_turn(&threads, &source_thread_id, "checkpoint-source-turn");
    threads
        .complete_turn(&source_thread_id, &source_turn_id, "source answer".into())
        .unwrap();
    let source = threads.read_thread(&source_thread_id).unwrap();
    let inherited = threads
        .commit_context_checkpoint(
            &source_thread_id,
            checkpoint_request(&source, source.sequence),
        )
        .unwrap();
    let source_sequence = threads.read_thread(&source_thread_id).unwrap().sequence;
    let child_thread_id = ThreadId::new("checkpoint-child").unwrap();
    threads
        .create_forked_thread(CreateForkedThreadRequest {
            session_id: SessionId::new("session_1").unwrap(),
            thread_id: child_thread_id.clone(),
            title: "checkpoint child".into(),
            source_thread_id,
            source_sequence,
        })
        .unwrap();
    let child_turn_id = start_turn(&threads, &child_thread_id, "checkpoint-child-turn");
    threads
        .complete_turn(&child_thread_id, &child_turn_id, "child answer".into())
        .unwrap();
    let child = threads.read_thread(&child_thread_id).unwrap();

    let child_checkpoint = threads
        .commit_context_checkpoint(&child_thread_id, checkpoint_request(&child, child.sequence))
        .unwrap();

    let checkpoints = threads
        .read_thread(&child_thread_id)
        .unwrap()
        .context_checkpoints;
    assert_eq!(checkpoints, vec![inherited, child_checkpoint.clone()]);
    assert_eq!(child_checkpoint.source_thread_id, child_thread_id);
}

#[test]
fn context_overflow_recovery_checkpoint_is_bound_once_to_the_running_turn() {
    let store = Arc::new(InMemoryThreadStore::default());
    let threads = ThreadController::with_store(store.clone());
    let thread = create_thread(&threads, "overflow-checkpoint");
    let history_turn = start_turn(&threads, &thread, "overflow-history");
    threads
        .complete_turn(&thread, &history_turn, "history".repeat(100))
        .unwrap();
    let current_turn = start_turn(&threads, &thread, "overflow-current");
    let source = threads.read_thread(&thread).unwrap();
    let covered_end_sequence = source
        .items
        .iter()
        .filter(|item| item.turn_id() == &history_turn)
        .filter_map(|item| source.item_sequences.get(item.item_id()))
        .copied()
        .max()
        .unwrap();

    let checkpoint = threads
        .commit_context_overflow_recovery(
            &thread,
            &current_turn,
            checkpoint_request(&source, covered_end_sequence),
        )
        .unwrap();

    assert_eq!(
        store.events().last().unwrap().event.kind(),
        "context.overflow_recovery_committed"
    );
    let committed = threads.read_thread(&thread).unwrap();
    assert_eq!(committed.context_checkpoints, vec![checkpoint.clone()]);
    assert_eq!(
        committed.context_overflow_recoveries.get(&current_turn),
        Some(&checkpoint.checkpoint_id)
    );
    assert!(
        threads
            .commit_context_overflow_recovery(
                &thread,
                &current_turn,
                checkpoint_request(&committed, covered_end_sequence),
            )
            .is_err()
    );
    assert_eq!(
        threads
            .read_thread(&thread)
            .unwrap()
            .context_checkpoints
            .len(),
        1
    );

    let recovered = ThreadController::with_store(store)
        .recover_thread(&thread)
        .unwrap();
    assert_eq!(
        recovered.context_overflow_recoveries.get(&current_turn),
        Some(&checkpoint.checkpoint_id)
    );
    assert_eq!(recovered.context_checkpoints, vec![checkpoint]);
    assert_eq!(
        recovered
            .turns
            .iter()
            .find(|turn| turn.turn_id == current_turn)
            .unwrap()
            .status,
        TurnStatus::Interrupted
    );
}

#[test]
fn failed_checkpoint_commit_does_not_expose_an_uncommitted_summary() {
    let store = Arc::new(ToggleStore {
        reject_writes: AtomicBool::new(false),
    });
    let threads = ThreadController::with_store(store.clone());
    let thread = create_thread(&threads, "checkpoint-failure");
    let turn = start_turn(&threads, &thread, "checkpoint-failure-turn");
    threads
        .complete_turn(&thread, &turn, "answer".into())
        .unwrap();
    let source_sequence = threads.read_thread(&thread).unwrap().sequence;
    store.reject_writes.store(true, Ordering::Relaxed);

    assert!(
        threads
            .commit_context_checkpoint(
                &thread,
                checkpoint_request(&threads.read_thread(&thread).unwrap(), source_sequence),
            )
            .is_err()
    );
    assert!(
        threads
            .read_thread(&thread)
            .unwrap()
            .context_checkpoints
            .is_empty()
    );
}

fn checkpoint_request(
    snapshot: &ThreadSnapshot,
    covered_end_sequence: u64,
) -> CommitContextCheckpointRequest {
    CommitContextCheckpointRequest {
        source_thread_sequence: snapshot.sequence,
        referenced_items: snapshot
            .items
            .iter()
            .filter(|item| {
                snapshot
                    .item_sequences
                    .get(item.item_id())
                    .is_some_and(|sequence| *sequence <= covered_end_sequence)
            })
            .map(|item| item.item_id().clone())
            .collect(),
        covered: ContextSourceRange {
            start_sequence: 1,
            end_sequence: covered_end_sequence,
        },
        summary: "durable summary".into(),
        schema_revision: "context-checkpoint-v1".into(),
        prompt_revision: "compaction-v2".into(),
        context_policy_revision: "context-policy-v1".into(),
        generator_model: None,
    }
}

#[test]
fn failed_thread_creation_does_not_register_a_projection() {
    let store = Arc::new(ToggleStore {
        reject_writes: AtomicBool::new(true),
    });
    let threads = ThreadController::with_store(store);
    let thread_id = ThreadId::new("failed").expect("test ID is non-empty");

    assert!(
        threads
            .create_thread(CreateThreadRequest {
                agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
                origin: Default::default(),
                agent: None,
                session_id: SessionId::new("session_1").expect("test ID is non-empty"),
                thread_id,
                title: "test".into(),
            })
            .is_err()
    );
    assert!(threads.list_threads().unwrap().is_empty());
}

#[test]
fn one_thread_durable_commit_does_not_block_another_thread() {
    let store = Arc::new(PerThreadBlockingStore::default());
    let threads = Arc::new(ThreadController::with_store(store.clone()));
    let blocked_thread = create_thread(&threads, "blocked");
    let independent_thread = create_thread(&threads, "independent");
    store.block_next_append_for(blocked_thread.clone());
    let blocked_threads = threads.clone();
    let blocked_thread_for_task = blocked_thread.clone();
    let blocked = thread::spawn(move || {
        blocked_threads
            .start_turn(&blocked_thread_for_task, start_request("blocked-start"))
            .unwrap();
    });
    store.wait_until_blocked();
    let independent_threads = threads.clone();
    let (completed_tx, completed_rx) = mpsc::channel();

    thread::spawn(move || {
        let result =
            independent_threads.start_turn(&independent_thread, start_request("independent-start"));
        completed_tx.send(result).unwrap();
    });

    let independent = completed_rx.recv_timeout(Duration::from_secs(1));
    store.release();
    blocked.join().unwrap();
    independent
        .expect("independent Thread commit was blocked")
        .unwrap();
}

#[test]
fn recovery_interrupts_non_terminal_turns() {
    let journal = Arc::new(InMemoryThreadStore::default());
    let original = ThreadController::with_store(journal.clone());
    let thread = create_thread(&original, "recover me");
    let turn = start_turn(&original, &thread, "recovery");
    let recovered = ThreadController::with_store(journal.clone());
    let snapshot = recovered.recover_thread(&thread).unwrap();
    assert_eq!(snapshot.title, "recover me");
    assert_eq!(snapshot.turns[0].turn_id, turn);
    assert_eq!(snapshot.turns[0].status, TurnStatus::Interrupted);
}

#[derive(Default)]
struct PerThreadBlockingStore {
    inner: InMemoryThreadStore,
    state: Mutex<PerThreadBlockingState>,
    changed: Condvar,
}

#[derive(Default)]
struct PerThreadBlockingState {
    blocked_thread: Option<ThreadId>,
    entered: bool,
    released: bool,
}

impl PerThreadBlockingStore {
    fn block_next_append_for(&self, thread_id: ThreadId) {
        let mut state = self.state.lock().unwrap();
        state.blocked_thread = Some(thread_id);
        state.entered = false;
        state.released = false;
    }

    fn wait_until_blocked(&self) {
        let mut state = self.state.lock().unwrap();
        while !state.entered {
            state = self.changed.wait(state).unwrap();
        }
    }

    fn release(&self) {
        let mut state = self.state.lock().unwrap();
        state.released = true;
        self.changed.notify_all();
    }
}

impl agent_graph_store::AgentGraphStore for PerThreadBlockingStore {
    fn read_agent(
        &self,
        agent_id: &ash_protocol::AgentId,
    ) -> Result<Option<agent_graph_store::AgentRecord>, agent_graph_store::AgentGraphStoreError>
    {
        self.inner.read_agent(agent_id)
    }
    fn read_thread_binding(
        &self,
        thread_id: &ThreadId,
    ) -> Result<Option<agent_graph_store::ThreadBinding>, agent_graph_store::AgentGraphStoreError>
    {
        self.inner.read_thread_binding(thread_id)
    }
    fn list_agent_threads(
        &self,
        agent_id: &ash_protocol::AgentId,
    ) -> Result<Vec<agent_graph_store::ThreadBinding>, agent_graph_store::AgentGraphStoreError>
    {
        self.inner.list_agent_threads(agent_id)
    }
    fn list_spawn_children(
        &self,
        thread_id: &ThreadId,
    ) -> Result<Vec<ThreadId>, agent_graph_store::AgentGraphStoreError> {
        self.inner.list_spawn_children(thread_id)
    }
    fn list_spawn_descendants(
        &self,
        thread_id: &ThreadId,
    ) -> Result<Vec<ThreadId>, agent_graph_store::AgentGraphStoreError> {
        self.inner.list_spawn_descendants(thread_id)
    }
}

impl ThreadStore for PerThreadBlockingStore {
    fn pending_checkpoint_cleanup(
        &self,
    ) -> Result<Vec<(String, ash_protocol::RepositoryCheckpoint)>, ThreadStoreError> {
        Ok(Vec::new())
    }
    fn acknowledge_checkpoint_cleanup(&self, _: &str) -> Result<(), ThreadStoreError> {
        Ok(())
    }

    fn load_history_prefix(
        &self,
        prefix: &ash_protocol::HistoryPrefixRef,
    ) -> Result<ash_history::HistoryPrefix, ThreadStoreError> {
        self.inner.load_history_prefix(prefix)
    }

    fn list_session_thread_ids(
        &self,
        session_id: &SessionId,
    ) -> Result<Vec<ThreadId>, ThreadStoreError> {
        self.inner.list_session_thread_ids(session_id)
    }

    fn list_thread_ids(&self) -> Result<Vec<ThreadId>, ThreadStoreError> {
        self.inner.list_thread_ids()
    }

    fn load(&self, thread_id: &ThreadId) -> Result<Vec<StoredEvent>, ThreadStoreError> {
        self.inner.load(thread_id)
    }

    fn list_catalog(&self) -> Result<Vec<ash_thread_store::ThreadCatalogRecord>, ThreadStoreError> {
        self.inner.list_catalog()
    }

    fn list_sessions(&self) -> Result<Vec<ash_protocol::Session>, ThreadStoreError> {
        self.inner.list_sessions()
    }

    fn read_session(
        &self,
        session_id: &SessionId,
    ) -> Result<Option<ash_protocol::Session>, ThreadStoreError> {
        self.inner.read_session(session_id)
    }

    fn session_catalog(
        &self,
        session_id: &SessionId,
    ) -> Result<Vec<ash_thread_store::ThreadCatalogRecord>, ThreadStoreError> {
        self.inner.session_catalog(session_id)
    }

    fn backfill_catalog(
        &self,
        record: &ash_thread_store::ThreadCatalogRecord,
    ) -> Result<(), ThreadStoreError> {
        self.inner.backfill_catalog(record)
    }

    fn rebuild_session(&self, session_id: &SessionId) -> Result<(), ThreadStoreError> {
        self.inner.rebuild_session(session_id)
    }

    fn delete_session(&self, session_id: &SessionId) -> Result<Vec<ThreadId>, ThreadStoreError> {
        self.inner.delete_session(session_id)
    }

    fn append_batch(
        &self,
        batch: &ThreadEventBatch,
    ) -> Result<AppendBatchResult, ThreadStoreError> {
        let should_block = self
            .state
            .lock()
            .unwrap()
            .blocked_thread
            .as_ref()
            .is_some_and(|thread_id| thread_id == &batch.thread_id);
        if should_block {
            let mut state = self.state.lock().unwrap();
            state.blocked_thread = None;
            state.entered = true;
            self.changed.notify_all();
            while !state.released {
                state = self.changed.wait(state).unwrap();
            }
        }
        self.inner.append_batch(batch)
    }
}

#[test]
fn waiting_interaction_survives_recovery_and_resolves_idempotently() {
    let store = Arc::new(InMemoryThreadStore::default());
    let original = ThreadController::with_store(store.clone());
    let thread = create_thread(&original, "interaction");
    let turn = start_turn(&original, &thread, "interaction-start");
    let requested = original
        .request_turn_interaction(
            &thread,
            &turn,
            RequestTurnInteraction {
                request_id: RequestId::new("request_1").expect("test ID is non-empty"),
                item_id: None,
                request: user_input_interaction(),
                deadline: Some(InteractionDeadline {
                    expires_at_unix_ms: 12_345,
                }),
            },
        )
        .unwrap();
    assert_eq!(requested.sequence, 5);
    assert_eq!(
        original.read_thread(&thread).unwrap().turns[0].status,
        TurnStatus::WaitingForUserInput
    );

    let recovered = ThreadController::with_store(store.clone());
    let snapshot = recovered.recover_thread(&thread).unwrap();
    assert_eq!(snapshot.turns[0].status, TurnStatus::WaitingForUserInput);
    assert_eq!(
        snapshot.turns[0]
            .pending_interaction
            .as_ref()
            .unwrap()
            .deadline,
        Some(InteractionDeadline {
            expires_at_unix_ms: 12_345,
        })
    );

    let resolve = || ResolveTurnInteractionRequest {
        command_id: CommandId::new("resolve_1").expect("test ID is non-empty"),
        expected_sequence: SequenceExpectation::Exact(requested.sequence),
        turn_id: turn.clone(),
        request_id: RequestId::new("request_1").expect("test ID is non-empty"),
        response: user_input_response(),
    };
    let resolved = recovered
        .resolve_turn_interaction(&thread, resolve())
        .unwrap();
    let replayed = recovered
        .resolve_turn_interaction(&thread, resolve())
        .unwrap();

    assert_eq!(
        resolved.disposition,
        ResolveTurnInteractionDisposition::Resolved
    );
    assert_eq!(
        replayed.disposition,
        ResolveTurnInteractionDisposition::Replayed
    );
    assert_eq!(
        recovered.read_thread(&thread).unwrap().turns[0].status,
        TurnStatus::Running
    );
    assert!(
        recovered.read_thread(&thread).unwrap().turns[0]
            .pending_interaction
            .is_none()
    );
    assert!(matches!(
        store.events().last().unwrap().event,
        ThreadEvent::InteractionResolved { .. }
    ));
}

#[test]
fn durable_resolution_wakes_the_exact_live_tool_interaction_without_restarting_the_turn() {
    let threads = ThreadController::with_store(Arc::new(InMemoryThreadStore::default()));
    let thread = create_thread(&threads, "live interaction");
    let turn = start_turn(&threads, &thread, "live-interaction-start");
    let request_id = RequestId::new("live_request_1").unwrap();
    let waiter = threads
        .live_interactions
        .register(live_interaction::LiveInteractionKey {
            thread_id: thread.clone(),
            turn_id: turn.clone(),
            request_id: request_id.clone(),
        })
        .unwrap();
    let requested = threads
        .request_turn_interaction(
            &thread,
            &turn,
            RequestTurnInteraction {
                request_id: request_id.clone(),
                item_id: None,
                request: user_input_interaction(),
                deadline: None,
            },
        )
        .unwrap();
    let cancellation = CancellationSource::new();
    let waiting = thread::spawn(move || waiter.wait(&cancellation.token()).unwrap());

    let response = user_input_response();
    let resolved = threads
        .resolve_turn_interaction(
            &thread,
            ResolveTurnInteractionRequest {
                command_id: CommandId::new("resolve_live_1").unwrap(),
                expected_sequence: SequenceExpectation::Exact(requested.sequence),
                turn_id: turn,
                request_id,
                response: response.clone(),
            },
        )
        .unwrap();

    assert!(resolved.live_execution_woken);
    assert!(matches!(
        waiting.join().unwrap(),
        live_interaction::LiveInteractionOutcome::Response(actual) if actual == response
    ));
}

#[test]
fn approval_interaction_is_durable_bound_and_recoverable() {
    let store = Arc::new(InMemoryThreadStore::default());
    let original = ThreadController::with_store(store.clone());
    let thread = create_thread(&original, "approval");
    let turn = start_turn(&original, &thread, "approval-start");
    let requested = original
        .request_turn_interaction(
            &thread,
            &turn,
            RequestTurnInteraction {
                request_id: RequestId::new("approval_1").unwrap(),
                item_id: None,
                request: approval_interaction(),
                deadline: None,
            },
        )
        .unwrap();
    assert_eq!(
        original.read_thread(&thread).unwrap().turns[0].status,
        TurnStatus::WaitingForApproval
    );

    let recovered = ThreadController::with_store(store.clone());
    let snapshot = recovered.recover_thread(&thread).unwrap();
    assert_eq!(snapshot.turns[0].status, TurnStatus::WaitingForApproval);
    assert_eq!(
        snapshot.turns[0]
            .pending_interaction
            .as_ref()
            .unwrap()
            .request,
        approval_interaction()
    );

    recovered
        .resolve_turn_interaction(
            &thread,
            ResolveTurnInteractionRequest {
                command_id: CommandId::new("approve_1").unwrap(),
                expected_sequence: SequenceExpectation::Exact(requested.sequence),
                turn_id: turn,
                request_id: RequestId::new("approval_1").unwrap(),
                response: approval_response(ActionApprovalDecision::ApproveOnce),
            },
        )
        .unwrap();
    assert_eq!(
        recovered.read_thread(&thread).unwrap().turns[0].status,
        TurnStatus::Running
    );
    assert!(matches!(
        &store.events().last().unwrap().event,
        ThreadEvent::InteractionResolved {
            response: AgentResponse::Approval {
                response: ActionApprovalResponse {
                    decision: ActionApprovalDecision::ApproveOnce
                }
            },
            ..
        }
    ));
}

#[test]
fn interaction_resolution_rejects_a_response_for_another_request() {
    let threads = ThreadController::with_store(Arc::new(InMemoryThreadStore::default()));
    let thread = create_thread(&threads, "interaction");
    let turn = start_turn(&threads, &thread, "interaction-start");
    let requested = threads
        .request_turn_interaction(
            &thread,
            &turn,
            RequestTurnInteraction {
                request_id: RequestId::new("request_1").expect("test ID is non-empty"),
                item_id: None,
                request: user_input_interaction(),
                deadline: None,
            },
        )
        .unwrap();

    assert!(
        threads
            .resolve_turn_interaction(
                &thread,
                ResolveTurnInteractionRequest {
                    command_id: CommandId::new("wrong-request").expect("test ID is non-empty"),
                    expected_sequence: SequenceExpectation::Exact(requested.sequence),
                    turn_id: turn,
                    request_id: RequestId::new("request_2").expect("test ID is non-empty"),
                    response: user_input_response(),
                },
            )
            .is_err()
    );
    assert_eq!(
        threads.read_thread(&thread).unwrap().turns[0].status,
        TurnStatus::WaitingForUserInput
    );
}

#[test]
fn interrupt_closes_an_outstanding_interaction_before_the_turn() {
    let store = Arc::new(InMemoryThreadStore::default());
    let threads = ThreadController::with_store(store.clone());
    let thread = create_thread(&threads, "interaction");
    let turn = start_turn(&threads, &thread, "interaction-start");
    threads
        .request_turn_interaction(
            &thread,
            &turn,
            RequestTurnInteraction {
                request_id: RequestId::new("request_1").expect("test ID is non-empty"),
                item_id: None,
                request: user_input_interaction(),
                deadline: None,
            },
        )
        .unwrap();

    threads
        .interrupt_turn(
            &thread,
            InterruptTurnRequest {
                command_id: CommandId::new("interrupt-wait").expect("test ID is non-empty"),
                expected_sequence: SequenceExpectation::Any,
                turn_id: turn.clone(),
            },
        )
        .unwrap();

    let events = store.events();
    assert!(matches!(
        events[events.len() - 3].event,
        ThreadEvent::InteractionCancelled { .. }
    ));
    assert_eq!(
        threads.read_thread(&thread).unwrap().turns[0].status,
        TurnStatus::Interrupted
    );
}

#[test]
fn start_turn_replays_typed_command_without_creating_another_turn() {
    let store = Arc::new(InMemoryThreadStore::default());
    let threads = ThreadController::with_store(store);
    let thread = create_thread(&threads, "test");

    let created = threads
        .start_turn(&thread, start_request("replay"))
        .unwrap();
    let replayed = threads
        .start_turn(&thread, start_request("replay"))
        .unwrap();

    assert_eq!(created.disposition, StartTurnDisposition::Created);
    assert_eq!(replayed.disposition, StartTurnDisposition::Replayed);
    assert_eq!(replayed.turn_id, created.turn_id);
    assert_eq!(threads.read_thread(&thread).unwrap().turns.len(), 1);
}

#[test]
fn context_compaction_command_is_frozen_and_replayed_without_another_turn() {
    let store = Arc::new(InMemoryThreadStore::default());
    let threads = ThreadController::with_store(store.clone());
    let thread = create_thread(&threads, "compact");
    let history_turn = start_turn(&threads, &thread, "history");
    threads
        .complete_turn(&thread, &history_turn, "durable history".into())
        .unwrap();
    let request = || StartContextCompactionRequest {
        command_id: CommandId::new("compact-command").unwrap(),
        expected_sequence: SequenceExpectation::Any,
        model: None,
        policy_revision: "test-policy-v1".into(),
        retention_prompt: Some("  preserve the deployment decision  ".into()),
    };

    let created = threads
        .start_context_compaction(&thread, request())
        .unwrap();
    let recovered = ThreadController::with_store(store);
    let replayed = recovered
        .start_context_compaction(&thread, request())
        .unwrap();
    let snapshot = recovered.read_thread(&thread).unwrap();

    assert_eq!(created.disposition, StartTurnDisposition::Created);
    assert_eq!(replayed.disposition, StartTurnDisposition::Replayed);
    assert_eq!(replayed.turn_id, created.turn_id);
    assert_eq!(snapshot.turns.len(), 2);
    assert!(matches!(
        &snapshot.commands.last().unwrap().receipt.command,
        ash_protocol::ThreadCommand::CompactContext {
            retention_prompt: Some(prompt),
            ..
        } if prompt == "preserve the deployment decision"
    ));
}

#[test]
fn context_compaction_rejects_a_nonterminal_existing_turn() {
    let threads = ThreadController::with_store(Arc::new(InMemoryThreadStore::default()));
    let thread = create_thread(&threads, "compact");
    start_turn(&threads, &thread, "active");

    let error = match threads.start_context_compaction(
        &thread,
        StartContextCompactionRequest {
            command_id: CommandId::new("compact-command").unwrap(),
            expected_sequence: SequenceExpectation::Any,
            model: None,
            policy_revision: "test-policy-v1".into(),
            retention_prompt: None,
        },
    ) {
        Ok(_) => panic!("active Turn must prevent manual compaction"),
        Err(error) => error,
    };

    assert!(matches!(error, CoreError::InvalidInput(message) if message.contains("terminal")));
    assert_eq!(threads.read_thread(&thread).unwrap().turns.len(), 1);
}

#[test]
fn shell_turn_atomically_persists_its_exact_command_and_tool_call() {
    let threads = ThreadController::with_store(Arc::new(InMemoryThreadStore::default()));
    let thread_id = create_thread(&threads, "shell");
    let request = || StartShellTurnRequest {
        command_id: CommandId::new("shell-start").unwrap(),
        expected_sequence: SequenceExpectation::Any,
        policy_revision: "test-policy-v1".into(),
        approval_mode: ash_protocol::ApprovalMode::AskPermissions,
        tool_call_id: ToolCallId::new("shell-turn-shell-start").unwrap(),
        binding: ash_protocol::ToolCallBinding {
            registry_incarnation: None,
            registry_generation: 1,
            definition_digest: "shell-definition".into(),
            source_chain: vec![ash_protocol::ToolSourceProvenance::Product {
                component: "test".into(),
            }],
            caller: ash_protocol::ToolCallCaller::Direct,
        },
        invocation: ShellTurnInvocation {
            command: "cargo test -p ash-core".into(),
            program: "/bin/sh".into(),
            arguments: vec!["-lc".into(), "cargo test -p ash-core".into()],
            working_directory: ".".into(),
        },
    };

    let created = threads.start_shell_turn(&thread_id, request()).unwrap();
    let replayed = threads.start_shell_turn(&thread_id, request()).unwrap();
    let snapshot = threads.read_thread(&thread_id).unwrap();

    assert_eq!(created.turn_id, replayed.turn_id);
    assert_eq!(replayed.disposition, StartTurnDisposition::Replayed);
    assert_eq!(snapshot.turns.len(), 1);
    assert!(matches!(
        &snapshot.commands[0].receipt.command,
        ash_protocol::ThreadCommand::StartShellTurn { command, .. }
            if command == "cargo test -p ash-core"
    ));
    let ThreadItem::ToolCall {
        turn_id,
        name,
        arguments_json,
        binding,
        ..
    } = &snapshot.items[0]
    else {
        panic!("Shell Turn must own one durable Tool Call");
    };
    assert_eq!(turn_id, &created.turn_id);
    assert_eq!(name.as_str(), "shell-command");
    assert_eq!(
        binding.as_ref().map(|binding| binding.registry_generation),
        Some(1)
    );
    let arguments: serde_json::Value = serde_json::from_str(arguments_json).unwrap();
    assert_eq!(arguments["program"], "/bin/sh");
    assert_eq!(
        arguments["arguments"],
        serde_json::json!(["-lc", "cargo test -p ash-core"])
    );
    assert_eq!(arguments["working_directory"], ".");
}

#[test]
fn typed_command_rejects_reusing_an_id_with_different_input() {
    let threads = ThreadController::with_store(Arc::new(InMemoryThreadStore::default()));
    let thread = create_thread(&threads, "test");
    threads
        .start_turn(&thread, start_request("conflict"))
        .unwrap();
    let conflicting = StartTurnRequest {
        advisor: None,
        kind: ash_protocol::TurnKind::Coding,
        instructions: crate::test_turn_instructions(),
        command_id: CommandId::new("conflict").expect("test ID is non-empty"),
        expected_sequence: SequenceExpectation::Any,
        model: None,
        policy_revision: "test-policy-v1".into(),
        approval_mode: ash_protocol::ApprovalMode::AskPermissions,
        tool_mode: ash_protocol::ToolMode::Direct,
        tool_profile: None,
        activated_skills: Vec::new(),
        input: vec![UserInput::Text {
            text: "different".into(),
        }],
    };

    assert!(matches!(
        threads.start_turn(&thread, conflicting),
        Err(CoreError::CommandConflict)
    ));
}

#[test]
fn replay_does_not_reinvoke_extension_activation() {
    let threads = ThreadController::with_store(Arc::new(InMemoryThreadStore::default()));
    let calls = Arc::new(AtomicU64::new(0));
    let mut extensions = ash_extension_api::ExtensionRegistryBuilder::new();
    extensions.skill_activation_contributor(Arc::new(OneShotActivation {
        calls: Arc::clone(&calls),
    }));
    threads
        .install_extensions(Arc::new(extensions.build()))
        .unwrap();
    let thread = create_thread(&threads, "extension replay");

    threads
        .start_turn(&thread, start_request("extension-replay"))
        .unwrap();
    threads
        .start_turn(&thread, start_request("extension-replay"))
        .unwrap();

    assert_eq!(calls.load(Ordering::Relaxed), 1);
}

#[test]
fn replay_reuses_durable_extension_automatic_activation_without_a_false_conflict() {
    let threads = ThreadController::with_store(Arc::new(InMemoryThreadStore::default()));
    let calls = Arc::new(AtomicU64::new(0));
    let mut extensions = ash_extension_api::ExtensionRegistryBuilder::new();
    extensions.skill_activation_contributor(Arc::new(AutomaticActivation {
        calls: Arc::clone(&calls),
    }));
    threads
        .install_extensions(Arc::new(extensions.build()))
        .unwrap();
    let thread = create_thread(&threads, "automatic extension replay");

    let first = threads
        .start_turn(&thread, start_request("automatic-extension-replay"))
        .unwrap();
    let replayed = threads
        .start_turn(&thread, start_request("automatic-extension-replay"))
        .unwrap();

    assert_eq!(first.turn_id, replayed.turn_id);
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    assert_eq!(
        threads.read_thread(&thread).unwrap().turns[0].activated_skills,
        vec![automatic_test_activation()]
    );
}

#[test]
fn legacy_replay_infers_host_automatic_activations_only_when_the_field_is_absent() {
    let automatic = automatic_test_activation();

    assert_eq!(
        crate::thread_controller::replay_host_activations(None, std::slice::from_ref(&automatic),),
        vec![automatic.clone()]
    );
    assert!(crate::thread_controller::replay_host_activations(Some(&[]), &[automatic]).is_empty());
}

#[test]
fn replay_rejects_different_host_seeded_automatic_activations() {
    let threads = ThreadController::with_store(Arc::new(InMemoryThreadStore::default()));
    let thread = create_thread(&threads, "automatic activation replay");
    let mut initial = start_request("automatic-activation-replay");
    initial.activated_skills = vec![ash_protocol::FrozenSkillActivation {
        id: ash_protocol::SkillId::new(
            ash_protocol::SkillSourceId::new("user:skill-source:test").unwrap(),
            ash_protocol::SkillName::new("review").unwrap(),
        ),
        content_digest: ash_protocol::ContentDigest::sha256(b"review body"),
        catalog_generation: 7,
        reason: ash_protocol::SkillActivationReason::Automatic,
    }];
    threads.start_turn(&thread, initial).unwrap();

    assert!(matches!(
        threads.start_turn(&thread, start_request("automatic-activation-replay")),
        Err(CoreError::CommandConflict)
    ));
}

#[test]
fn start_turn_snapshots_the_selected_model_and_instructions() {
    let threads = ThreadController::with_store(Arc::new(InMemoryThreadStore::default()));
    let thread = create_thread(&threads, "model");
    let model = ash_protocol::ModelRef::new(
        ash_protocol::ProviderId::new("openai").unwrap(),
        ash_protocol::ModelId::new("gpt-5.6").unwrap(),
    );
    let mut request = start_request("model-turn");
    request.model = Some(model.clone());

    let started = threads.start_turn(&thread, request).unwrap();
    let snapshot = threads.read_thread(&thread).unwrap();

    let turn = snapshot
        .turns
        .iter()
        .find(|turn| turn.turn_id == started.turn_id)
        .unwrap();
    assert_eq!(turn.model, Some(model));
    assert_eq!(turn.instructions, Some(crate::test_turn_instructions()));
}

#[test]
fn start_turn_replay_rejects_different_frozen_instructions() {
    let threads = ThreadController::with_store(Arc::new(InMemoryThreadStore::default()));
    let thread = create_thread(&threads, "instructions");
    threads
        .start_turn(&thread, start_request("instructions-conflict"))
        .unwrap();
    let mut conflicting = start_request("instructions-conflict");
    conflicting.instructions = ash_protocol::TurnInstructions::new(
        "core-tests",
        "test/review-instructions",
        "review-v1",
        "review instructions",
    )
    .unwrap();

    assert!(matches!(
        threads.start_turn(&thread, conflicting),
        Err(CoreError::CommandConflict)
    ));
}

#[test]
fn start_turn_freezes_the_selected_approval_mode() {
    let threads = ThreadController::with_store(Arc::new(InMemoryThreadStore::default()));
    let thread = create_thread(&threads, "approval-mode");
    let mut request = start_request("approval-mode-start");
    request.approval_mode = ash_protocol::ApprovalMode::BypassPermissions;

    let started = threads.start_turn(&thread, request).unwrap();
    let snapshot = threads.read_thread(&thread).unwrap();
    let turn = snapshot
        .turns
        .iter()
        .find(|turn| turn.turn_id == started.turn_id)
        .unwrap();

    assert_eq!(
        turn.approval_mode,
        ash_protocol::ApprovalMode::BypassPermissions
    );
}

#[test]
fn recovered_command_replays_without_creating_another_turn() {
    let store = Arc::new(InMemoryThreadStore::default());
    let original = ThreadController::with_store(store.clone());
    let thread = create_thread(&original, "test");
    let created = original
        .start_turn(&thread, start_request("recovered-replay"))
        .unwrap();
    original
        .complete_turn(&thread, &created.turn_id, "answer".into())
        .unwrap();

    let recovered = ThreadController::with_store(store);
    recovered.recover_thread(&thread).unwrap();
    let replayed = recovered
        .start_turn(&thread, start_request("recovered-replay"))
        .unwrap();

    assert_eq!(replayed.disposition, StartTurnDisposition::Replayed);
    assert_eq!(replayed.turn_id, created.turn_id);
}

#[test]
fn interrupt_turn_is_a_retry_safe_typed_command() {
    let threads = ThreadController::with_store(Arc::new(InMemoryThreadStore::default()));
    let thread = create_thread(&threads, "test");
    let turn = start_turn(&threads, &thread, "turn");
    let request = || InterruptTurnRequest {
        command_id: CommandId::new("interrupt").expect("test ID is non-empty"),
        expected_sequence: SequenceExpectation::Any,
        turn_id: turn.clone(),
    };

    let interrupted = threads.interrupt_turn(&thread, request()).unwrap();
    let replayed = threads.interrupt_turn(&thread, request()).unwrap();

    assert_eq!(
        interrupted.disposition,
        InterruptTurnDisposition::Interrupted
    );
    assert_eq!(replayed.disposition, InterruptTurnDisposition::Replayed);
    assert_eq!(
        threads.read_thread(&thread).unwrap().turns[0].status,
        TurnStatus::Interrupted
    );
}

#[test]
fn steering_is_ordered_retry_safe_and_recovers_without_duplicate_items() {
    let store = Arc::new(InMemoryThreadStore::default());
    let threads = ThreadController::with_store(store.clone());
    let thread = create_thread(&threads, "steering");
    let turn = start_turn(&threads, &thread, "steering-turn");
    let request = |command_id: &str, text: &str| SteerTurnRequest {
        command_id: CommandId::new(command_id).unwrap(),
        expected_sequence: SequenceExpectation::Any,
        turn_id: turn.clone(),
        input: vec![UserInput::Text { text: text.into() }],
    };

    let first = threads
        .steer_turn(&thread, request("steer-1", "first update"))
        .unwrap();
    let replayed = threads
        .steer_turn(&thread, request("steer-1", "first update"))
        .unwrap();
    let delivered = threads
        .mark_turn_steer_delivered(&thread, &turn, &CommandId::new("steer-1").unwrap())
        .unwrap();
    assert_eq!(
        threads
            .mark_turn_steer_delivered(&thread, &turn, &CommandId::new("steer-1").unwrap(),)
            .unwrap(),
        delivered
    );
    let second = threads
        .steer_turn(&thread, request("steer-2", "second update"))
        .unwrap();

    assert_eq!(first.disposition, SteerTurnDisposition::Steered);
    assert_eq!(replayed.disposition, SteerTurnDisposition::Replayed);
    assert_eq!(replayed.sequence, first.sequence);
    assert!(second.sequence > first.sequence);
    let snapshot = threads.read_thread(&thread).unwrap();
    let texts = snapshot
        .items
        .iter()
        .filter_map(|item| match item {
            ThreadItem::UserMessage { text, .. } => Some(text.clone()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(texts, ["hello", "first update", "second update"]);

    let recovered = ThreadController::with_store(store);
    recovered.recover_thread(&thread).unwrap();
    let recovered_replay = recovered
        .steer_turn(&thread, request("steer-1", "first update"))
        .unwrap();
    assert_eq!(recovered_replay.disposition, SteerTurnDisposition::Replayed);
    assert_eq!(
        recovered
            .read_thread(&thread)
            .unwrap()
            .steer_deliveries
            .get(&CommandId::new("steer-1").unwrap()),
        Some(&delivered)
    );
    assert_eq!(
        recovered
            .read_thread(&thread)
            .unwrap()
            .items
            .iter()
            .filter(|item| matches!(item, ThreadItem::UserMessage { text, .. } if text == "first update"))
            .count(),
        1
    );
}

#[test]
fn steering_accepts_interaction_waits_and_rejects_terminal_turns() {
    for (title, request) in [
        ("approval steering", approval_interaction()),
        ("user-input steering", user_input_interaction()),
    ] {
        let threads = ThreadController::with_store(Arc::new(InMemoryThreadStore::default()));
        let thread = create_thread(&threads, title);
        let turn = start_turn(&threads, &thread, title);
        threads
            .request_turn_interaction(
                &thread,
                &turn,
                RequestTurnInteraction {
                    request_id: RequestId::new(format!("request-{title}")).unwrap(),
                    item_id: None,
                    request,
                    deadline: None,
                },
            )
            .unwrap();
        threads
            .steer_turn(
                &thread,
                SteerTurnRequest {
                    command_id: CommandId::new(format!("steer-{title}")).unwrap(),
                    expected_sequence: SequenceExpectation::Any,
                    turn_id: turn.clone(),
                    input: vec![UserInput::Text {
                        text: "remember this".into(),
                    }],
                },
            )
            .unwrap();
        let turn = threads
            .read_thread(&thread)
            .unwrap()
            .turns
            .into_iter()
            .find(|candidate| candidate.turn_id == turn)
            .unwrap();
        assert!(matches!(
            turn.status,
            TurnStatus::WaitingForApproval | TurnStatus::WaitingForUserInput
        ));
    }

    let threads = ThreadController::with_store(Arc::new(InMemoryThreadStore::default()));
    let thread = create_thread(&threads, "terminal steering");
    let turn = start_turn(&threads, &thread, "terminal-steering-turn");
    assert!(matches!(
        threads.steer_turn(
            &thread,
            SteerTurnRequest {
                command_id: CommandId::new("skill-steer").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                turn_id: turn.clone(),
                input: vec![UserInput::Skill {
                    skill: ash_protocol::SkillRef::follow_latest(ash_protocol::SkillId::new(
                        ash_protocol::SkillSourceId::new("user:skill-source:test").unwrap(),
                        ash_protocol::SkillName::new("review").unwrap(),
                    )),
                }],
            }
        ),
        Err(CoreError::InvalidInput(message)) if message.contains("frozen Skill")
    ));
    threads
        .complete_turn(&thread, &turn, "done".into())
        .unwrap();
    assert!(matches!(
        threads.steer_turn(
            &thread,
            SteerTurnRequest {
                command_id: CommandId::new("late-steer").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                turn_id: turn,
                input: vec![UserInput::Text {
                    text: "too late".into()
                }],
            }
        ),
        Err(CoreError::InvalidInput(message)) if message.contains("Completed")
    ));
}

#[test]
fn durable_projection_contains_messages_tools_and_session_identity() {
    let store = Arc::new(InMemoryThreadStore::default());
    let original = ThreadController::with_store(store.clone());
    let thread = create_thread(&original, "test");
    let turn = start_turn(&original, &thread, "items");
    let call = original
        .record_tool_call(
            &thread,
            &turn,
            RecordToolCallRequest {
                tool_call_id: None,
                name: ToolName::new("search").expect("test tool name is valid"),
                arguments_json: r#"{"query":"ash"}"#.into(),
                binding: None,
            },
        )
        .unwrap();
    original
        .record_tool_result(
            &thread,
            &turn,
            RecordToolResultRequest {
                tool_call_id: call.tool_call_id,
                output: ToolCallOutput::Success("result".into()),
            },
        )
        .unwrap();
    original
        .complete_turn(&thread, &turn, "answer".into())
        .unwrap();

    let snapshot = ThreadController::with_store(store)
        .recover_thread(&thread)
        .unwrap();
    assert_eq!(
        snapshot.public_thread().session_id,
        SessionId::new("session_1").expect("test ID is non-empty")
    );
    assert!(matches!(
        &snapshot.items[0],
        ThreadItem::UserMessage { text, .. } if text == "hello"
    ));
    assert!(matches!(
        &snapshot.items[1],
        ThreadItem::ToolCall { name, .. } if name.as_str() == "search"
    ));
    assert!(matches!(
        &snapshot.items[2],
        ThreadItem::ToolResult {
            text,
            is_error: false,
            ..
        } if text == "result"
    ));
}

#[test]
fn repeated_tool_failures_persist_one_reminder_and_recover_as_a_stable_failure() {
    let store = Arc::new(InMemoryThreadStore::default());
    let original = ThreadController::with_store(store.clone());
    let thread = create_thread(&original, "tool repetition");
    let turn = start_turn(&original, &thread, "tool-repetition");

    for index in 1..=5 {
        let call = original
            .record_tool_call(
                &thread,
                &turn,
                RecordToolCallRequest {
                    tool_call_id: Some(ToolCallId::new(format!("repeat-{index}")).unwrap()),
                    name: ToolName::new("search").unwrap(),
                    arguments_json: if index % 2 == 0 {
                        r#"{"limit":5,"query":"ash"}"#.into()
                    } else {
                        r#"{"query":"ash","limit":5}"#.into()
                    },
                    binding: None,
                },
            )
            .unwrap();
        let result = original
            .record_tool_result(
                &thread,
                &turn,
                RecordToolResultRequest {
                    tool_call_id: call.tool_call_id,
                    output: ToolCallOutput::Failure("search failed".into()),
                },
            )
            .unwrap();
        assert_eq!(
            matches!(
                result.item,
                ThreadItem::ToolResult { ref text, .. }
                    if text.contains(crate::tool_repetition::TOOL_REPETITION_REMINDER)
            ),
            index == 3
        );
    }

    let snapshot = original.read_thread(&thread).unwrap();
    assert_eq!(snapshot.turns[0].status, crate::TurnStatus::Running);
    assert_eq!(
        snapshot
            .items
            .iter()
            .filter(|item| matches!(
                item,
                ThreadItem::ToolResult { text, .. }
                    if text.contains(crate::tool_repetition::TOOL_REPETITION_REMINDER)
            ))
            .count(),
        1
    );

    let recovered = ThreadController::with_store(store)
        .recover_thread(&thread)
        .unwrap();
    assert_eq!(recovered.turns[0].status, crate::TurnStatus::Failed);
    assert_eq!(
        recovered.turns[0].failure.as_ref().map(|error| error.code),
        Some(StableTurnErrorCode::ToolRepetition)
    );
}

#[test]
fn tool_image_content_is_prepared_before_it_becomes_durable() {
    let store = Arc::new(InMemoryThreadStore::default());
    let original = ThreadController::with_store(store.clone());
    let thread = create_thread(&original, "tool image");
    let turn = start_turn(&original, &thread, "tool-image");
    let call = original
        .record_tool_call(
            &thread,
            &turn,
            RecordToolCallRequest {
                tool_call_id: Some(
                    ToolCallId::new("tool-image-call").expect("test tool call ID is non-empty"),
                ),
                name: ToolName::new("image-tool").expect("test tool name is valid"),
                arguments_json: "{}".into(),
                binding: None,
            },
        )
        .unwrap();

    original
        .record_tool_result(
            &thread,
            &turn,
            RecordToolResultRequest {
                tool_call_id: call.tool_call_id,
                output: ToolCallOutput::SuccessContent(vec![
                    ash_protocol::ContentPart::Text("before".into()),
                    ash_protocol::ContentPart::ImageUrl {
                        url: crate::test_image::one_pixel_png_data_url(),
                        detail: ash_protocol::ImageDetail::High,
                    },
                ]),
            },
        )
        .unwrap();

    let snapshot = ThreadController::with_store(store)
        .recover_thread(&thread)
        .unwrap();
    assert!(matches!(
        &snapshot.items[2],
        ThreadItem::ToolResult {
            content: Some(content),
            ..
        } if matches!(content.as_slice(), [
            ash_protocol::ContentPart::Text(text),
            ash_protocol::ContentPart::ImageAttachment { .. },
        ] if text == "before")
    ));
}

#[test]
fn start_turn_persists_ordered_text_and_normalized_image_attachment_items() {
    let threads = ThreadController::with_store(Arc::new(InMemoryThreadStore::default()));
    let thread = create_thread(&threads, "image");
    let image_url = crate::test_image::one_pixel_png_data_url();

    let result = threads
        .start_turn(
            &thread,
            StartTurnRequest {
                advisor: None,
                kind: ash_protocol::TurnKind::Coding,
                instructions: crate::test_turn_instructions(),
                command_id: CommandId::new("image-turn").expect("test ID is non-empty"),
                expected_sequence: SequenceExpectation::Any,
                model: None,
                policy_revision: "test-policy-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![
                    UserInput::Text {
                        text: "describe".into(),
                    },
                    UserInput::Image {
                        url: image_url.clone(),
                    },
                ],
            },
        )
        .unwrap();
    let snapshot = threads.read_thread(&thread).unwrap();

    assert!(matches!(
        &snapshot.items[0],
        ThreadItem::UserMessage { turn_id, text, .. }
            if turn_id == &result.turn_id && text == "describe"
    ));
    assert!(matches!(
        &snapshot.items[1],
        ThreadItem::UserImageAttachment { turn_id, attachment, .. }
            if turn_id == &result.turn_id
                && threads.attachments().verify(attachment).is_ok()
    ));
    assert!(matches!(
        &snapshot.commands[0].receipt.command,
        ash_protocol::ThreadCommand::StartTurn { input, .. }
            if matches!(input[1], UserInput::ImageAttachment { .. })
    ));
}

#[test]
fn update_plan_is_idempotent_and_recovers_as_canonical_turn_state() {
    let store = Arc::new(InMemoryThreadStore::default());
    let threads = ThreadController::with_store(store.clone());
    let thread = create_thread(&threads, "plan");
    let turn = start_turn(&threads, &thread, "plan-turn");
    let plan = PlanUpdate {
        explanation: Some("Implement S3".into()),
        steps: vec![
            PlanStep {
                step: "Implement".into(),
                status: PlanStepStatus::InProgress,
            },
            PlanStep {
                step: "Verify".into(),
                status: PlanStepStatus::Pending,
            },
        ],
    };

    let changed = threads.update_plan(&thread, &turn, plan.clone()).unwrap();
    assert_eq!(changed.disposition, UpdatePlanDisposition::Changed);
    let unchanged = threads.update_plan(&thread, &turn, plan.clone()).unwrap();
    assert_eq!(unchanged.disposition, UpdatePlanDisposition::Unchanged);
    assert_eq!(unchanged.sequence, changed.sequence);

    let recovered = ThreadController::with_store(store)
        .recover_thread(&thread)
        .unwrap();
    assert_eq!(recovered.turns[0].plan.as_ref(), Some(&plan));
    assert!(matches!(
        recovered.public_thread().turns[0].plan.as_ref(),
        Some(projected) if projected == &plan
    ));
}

#[derive(Default)]
struct LifecycleLog(Mutex<Vec<(u64, ash_extension_api::ThreadLifecycle)>>);
impl ash_extension_api::LifecycleObserver for LifecycleLog {
    fn thread_changed(
        &self,
        context: ash_extension_api::ThreadContext<'_>,
        event: &ash_extension_api::ThreadLifecycle,
    ) {
        self.0
            .lock()
            .unwrap()
            .push((context.sequence, event.clone()));
    }
    fn config_changed(&self, _: u64) {}
}

#[test]
fn extension_lifecycle_observes_commits_without_replaying_reads() {
    let store = Arc::new(InMemoryThreadStore::default());
    let controller = ThreadController::with_store(store.clone());
    let log = Arc::new(LifecycleLog::default());
    let mut builder = ash_extension_api::ExtensionRegistryBuilder::new();
    builder.lifecycle_observer("test", log.clone());
    controller
        .install_extensions(Arc::new(builder.build()))
        .unwrap();
    let thread_id = create_thread(&controller, "lifecycle");
    let start = controller
        .start_turn(&thread_id, start_request("lifecycle-turn"))
        .unwrap();
    controller
        .complete_turn(&thread_id, &start.turn_id, "done".into())
        .unwrap();
    let events = log.0.lock().unwrap().clone();
    assert_eq!(
        events.first().unwrap().1,
        ash_extension_api::ThreadLifecycle::Created
    );
    assert!(events.iter().any(|(_,event)| matches!(event,ash_extension_api::ThreadLifecycle::TurnCompleted(id) if id==&start.turn_id)));
    assert!(events.windows(2).all(|pair| pair[0].0 < pair[1].0));
    controller.read_thread(&thread_id).unwrap();
    controller
        .start_turn(&thread_id, start_request("lifecycle-turn"))
        .unwrap();
    assert_eq!(*log.0.lock().unwrap(), events);
}

#[test]
fn agent_bindings_cannot_change_through_catalog_backfill() {
    let store = Arc::new(InMemoryThreadStore::default());
    let threads = ThreadController::with_store(store.clone());
    let thread_id = create_thread(&threads, "agent-binding");
    let original = threads.thread_catalog_record(&thread_id).unwrap();
    let mut changed = original.clone();
    changed.binding.agent_id = ash_protocol::AgentId::new("different-agent").unwrap();
    assert!(store.backfill_catalog(&changed).is_err());
    assert_eq!(
        agent_graph_store::AgentGraphStore::read_thread_binding(store.as_ref(), &thread_id)
            .unwrap(),
        Some(original.binding)
    );
    assert!(
        agent_graph_store::AgentGraphStore::read_agent(store.as_ref(), &changed.binding.agent_id)
            .unwrap()
            .is_none()
    );
}

#[test]
fn audio_admission_is_durable_recoverable_and_rejects_forged_metadata_before_commit() {
    let root = tempfile::tempdir().unwrap();
    let open = || {
        Arc::new(ash_attachments::Attachments::new(Arc::new(
            attachment_store::FileAttachmentStore::open(root.path()).unwrap(),
        )))
    };
    let attachments = open();
    let store = Arc::new(InMemoryThreadStore::default());
    let threads = ThreadController::with_store_and_attachments(store.clone(), attachments.clone());
    let thread = create_thread(&threads, "audio");
    let audio = audio::load_bytes(
        include_bytes!("../../utils/audio/tests/fixtures/tone.wav")
            .as_slice()
            .into(),
        audio::AudioFormat::Wav,
    )
    .unwrap();
    let mut request = start_request("audio");
    request.input = vec![UserInput::Audio {
        url: audio.data_url(),
    }];
    let started = threads.start_turn(&thread, request).unwrap();
    threads
        .complete_turn(&thread, &started.turn_id, "heard".into())
        .unwrap();
    let original = threads.read_thread(&thread).unwrap();
    let attachment = original
        .items
        .iter()
        .find_map(|item| match item {
            ThreadItem::UserAudioAttachment { attachment, .. } => Some(attachment.clone()),
            _ => None,
        })
        .unwrap();
    assert!(
        !serde_json::to_string(&original.public_thread())
            .unwrap()
            .contains("data:audio")
    );
    drop(threads);
    drop(attachments);
    let recovered = ThreadController::with_store_and_attachments(store, open());
    let snapshot = recovered.recover_thread(&thread).unwrap();
    assert_eq!(snapshot.items, original.items);
    assert!(
        recovered
            .attachments()
            .materialize_audio_data_url(&attachment)
            .unwrap()
            .starts_with("data:audio/wav;base64,")
    );
    let before = recovered.read_thread(&thread).unwrap().sequence;
    let mut forged = attachment;
    forged.duration_ms += 1;
    let mut invalid = start_request("forged-audio");
    invalid.input = vec![UserInput::AudioAttachment { attachment: forged }];
    assert!(recovered.start_turn(&thread, invalid).is_err());
    assert_eq!(recovered.read_thread(&thread).unwrap().sequence, before);
}

#[test]
fn invalid_tool_audio_does_not_commit_a_result_and_the_call_can_still_finish() {
    let threads = ThreadController::with_store(Arc::new(InMemoryThreadStore::default()));
    let thread = create_thread(&threads, "tool audio");
    let turn = start_turn(&threads, &thread, "tool-audio");
    let call = threads
        .record_tool_call(
            &thread,
            &turn,
            RecordToolCallRequest {
                tool_call_id: Some(ToolCallId::new("audio-call").unwrap()),
                name: ToolName::new("audio-tool").unwrap(),
                arguments_json: "{}".into(),
                binding: None,
            },
        )
        .unwrap();
    let before = threads.read_thread(&thread).unwrap().sequence;
    assert!(
        threads
            .record_tool_result(
                &thread,
                &turn,
                RecordToolResultRequest {
                    tool_call_id: call.tool_call_id.clone(),
                    output: ToolCallOutput::SuccessContent(vec![
                        ash_protocol::ContentPart::AudioUrl {
                            url: "data:audio/wav;base64,AA==".into()
                        }
                    ]),
                }
            )
            .is_err()
    );
    assert_eq!(threads.read_thread(&thread).unwrap().sequence, before);
    let url = audio::load_bytes(
        include_bytes!("../../utils/audio/tests/fixtures/tone.wav")
            .as_slice()
            .into(),
        audio::AudioFormat::Wav,
    )
    .unwrap()
    .data_url();
    threads
        .record_tool_result(
            &thread,
            &turn,
            RecordToolResultRequest {
                tool_call_id: call.tool_call_id,
                output: ToolCallOutput::SuccessContent(vec![ash_protocol::ContentPart::AudioUrl {
                    url,
                }]),
            },
        )
        .unwrap();
    let snapshot = threads.read_thread(&thread).unwrap();
    assert!(
        matches!(&snapshot.items[2], ThreadItem::ToolResult { content: Some(content), .. } if matches!(content.as_slice(), [ash_protocol::ContentPart::AudioAttachment { .. }]))
    );
}

#[test]
fn advisor_selection_is_retry_safe_and_inherited_at_the_fork_boundary() {
    let store = Arc::new(InMemoryThreadStore::default());
    let controller = ThreadController::with_store(store.clone());
    let id = create_thread(&controller, "advisor");
    let before = controller.read_thread(&id).unwrap();
    let command = CommandId::new("advisor-selection").unwrap();
    let config = ash_protocol::AdvisorConfig::new(ModelRef {
        provider: ProviderId::new("test").unwrap(),
        model: ModelId::new("advisor").unwrap(),
    });
    let selection = ash_protocol::AdvisorSelection::Model { config };
    let sequence = controller
        .configure_advisor(
            &id,
            command.clone(),
            SequenceExpectation::Exact(before.sequence),
            selection.clone(),
        )
        .unwrap();
    assert_eq!(
        controller
            .configure_advisor(
                &id,
                command.clone(),
                SequenceExpectation::Exact(before.sequence),
                selection.clone()
            )
            .unwrap(),
        sequence
    );
    assert_eq!(
        controller.configure_advisor(
            &id,
            command,
            SequenceExpectation::Any,
            ash_protocol::AdvisorSelection::Off
        ),
        Err(CoreError::CommandConflict)
    );
    let branch = controller
        .create_forked_thread(CreateForkedThreadRequest {
            session_id: before.session_id,
            thread_id: ThreadId::new("advisor-branch").unwrap(),
            title: "branch".into(),
            source_thread_id: id.clone(),
            source_sequence: sequence,
        })
        .unwrap();
    assert_eq!(branch.advisor, selection);
    controller
        .configure_advisor(
            &id,
            CommandId::new("advisor-off").unwrap(),
            SequenceExpectation::Exact(sequence),
            ash_protocol::AdvisorSelection::Off,
        )
        .unwrap();
    let recovered = ThreadController::with_store(store);
    assert_eq!(
        recovered.read_thread(&id).unwrap().advisor,
        ash_protocol::AdvisorSelection::Off
    );
    assert_eq!(
        recovered.read_thread(&branch.thread_id).unwrap().advisor,
        selection
    );
}
