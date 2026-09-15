use super::ContextManager;
use crate::ContextBudget;
use crate::ThreadCommandSnapshot;
use crate::ThreadSnapshot;
use crate::TurnSnapshot;
use crate::context::ContextInput;
use crate::context::ContextPreparation;
use crate::context::ContextPreparationError;
use ash_protocol::ItemId;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::TurnId;
use ash_protocol::TurnStatus;
use std::collections::BTreeMap;
use std::collections::BTreeSet;

#[test]
fn manager_can_be_discarded_and_rebuilt_from_the_same_durable_facts() {
    let turn_id = id::<TurnId>("turn");
    let snapshot = snapshot(7, turn_id.clone());
    let input = ContextInput::new(
        &snapshot,
        turn_id,
        Vec::new(),
        Vec::new(),
        ContextBudget::provider_managed(),
    );

    let first = ContextManager::default().prepare(&input).unwrap();
    let second = ContextManager::default().prepare(&input).unwrap();

    assert_eq!(format!("{first:?}"), format!("{second:?}"));
    assert!(matches!(first, ContextPreparation::Ready(_)));
}

#[test]
fn manager_rejects_a_snapshot_older_than_its_observed_sequence() {
    let turn_id = id::<TurnId>("turn");
    let older = snapshot(7, turn_id.clone());
    let newer = snapshot(8, turn_id.clone());
    let older_input = ContextInput::new(
        &older,
        turn_id.clone(),
        Vec::new(),
        Vec::new(),
        ContextBudget::provider_managed(),
    );
    let newer_input = ContextInput::new(
        &newer,
        turn_id,
        Vec::new(),
        Vec::new(),
        ContextBudget::provider_managed(),
    );
    let mut manager = ContextManager::default();

    manager.prepare(&newer_input).unwrap();

    assert!(matches!(
        manager.prepare(&older_input),
        Err(ContextPreparationError::UnsupportedContextShape(_))
    ));
}

fn snapshot(sequence: u64, turn_id: TurnId) -> ThreadSnapshot {
    ThreadSnapshot {
        user_time_contexts: Default::default(),
        history_sources: Default::default(),
        message_checkpoints: Default::default(),
        agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
        origin: Default::default(),
        session_id: id::<SessionId>("session"),
        thread_id: id::<ThreadId>("thread"),
        created_at_unix_ms: 0,
        parent_thread_id: None,
        forked_from_id: None,
        title: "test".into(),
        status: ash_protocol::ThreadStatus::Active,
        archived_at_unix_ms: None,
        archive_reason: None,
        turn_execution_binding: None,
        sequence,
        usage: ash_protocol::ModelUsageSummary::default(),
        reference_cost: ash_protocol::ModelReferenceCostSummary::default(),
        goal: None,
        goal_budget_limited_turn_id: None,
        context_calibrations: Vec::new(),
        turns: vec![TurnSnapshot {
            kind: ash_protocol::TurnKind::Coding,
            instructions: None,
            turn_id: turn_id.clone(),
            status: TurnStatus::Running,
            status_changed_at_unix_ms: 0,
            started_at_unix_ms: None,
            duration_ms: None,
            model: None,
            policy_revision: "test-policy-v1".into(),
            approval_mode: ash_protocol::ApprovalMode::AskPermissions,
            tool_mode: ash_protocol::ToolMode::Direct,
            activated_skills: Vec::new(),
            failure: None,
            pending_interaction: None,
            execution_backend_attempt: None,
            tool_profile: None,
            plan: None,
            usage: ash_protocol::ModelUsageSummary::default(),
            context_usage: None,
        }],
        items: vec![ThreadItem::UserMessage {
            item_id: id::<ItemId>("item"),
            turn_id,
            text: "hello".into(),
        }],
        context_checkpoints: Vec::new(),
        context_overflow_recoveries: BTreeMap::new(),
        item_sequences: BTreeMap::new(),
        event_digests: BTreeMap::new(),
        commands: Vec::<ThreadCommandSnapshot>::new(),
        steer_deliveries: BTreeMap::new(),
        seen_interaction_ids: BTreeSet::new(),
        resolved_interactions: Vec::new(),
        started_tool_calls: BTreeSet::new(),
        tool_execution_starts: BTreeMap::new(),
        escalated_tool_calls: BTreeSet::new(),
        agent: None,
        agent_context_seed: None,
        delegations: BTreeMap::new(),
        agent_cancellations_received: BTreeSet::new(),
        agent_joins: BTreeMap::new(),
        produced_delegation_results: BTreeMap::new(),
        received_delegation_results: BTreeMap::new(),
        sent_agent_messages: BTreeMap::new(),
        received_agent_messages: BTreeMap::new(),
        fork_import: None,
    }
}

trait TestId: Sized {
    fn from_test(value: &str) -> Self;
}

macro_rules! impl_test_id {
    ($($type:ty),+ $(,)?) => {
        $(
            impl TestId for $type {
                fn from_test(value: &str) -> Self {
                    Self::new(value).expect("test ID is non-empty")
                }
            }
        )+
    };
}

impl_test_id!(ItemId, SessionId, ThreadId, TurnId);

fn id<T: TestId>(value: &str) -> T {
    T::from_test(value)
}
