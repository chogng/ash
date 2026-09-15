use super::super::ContextBudget;
use super::super::ContextCompactionLimit;
use super::super::ContextInput;
use super::super::ContextPreparation;
use super::super::ContextPreparationError;
use super::super::ContextTokenCount;
use super::super::InstructionFragment;
use super::super::InstructionPlacement;
use super::super::InstructionRetention;
use super::super::InstructionSource;
use super::ContextPlanner;
use crate::ThreadCommandSnapshot;
use crate::ThreadSnapshot;
use crate::TurnSnapshot;
use ash_protocol::ContextCheckpoint;
use ash_protocol::ContextCheckpointId;
use ash_protocol::ContextCheckpointVerification;
use ash_protocol::ContextSourceDigest;
use ash_protocol::ContextSourceRange;
use ash_protocol::ItemId;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::ToolCallId;
use ash_protocol::ToolDefinition;
use ash_protocol::ToolName;
use ash_protocol::TurnId;
use ash_protocol::TurnStatus;
use std::collections::BTreeMap;
use std::collections::BTreeSet;

#[test]
fn same_input_produces_an_equivalent_ordered_plan() {
    let previous_turn = id::<TurnId>("previous");
    let current_turn = id::<TurnId>("current");
    let base_snapshot = snapshot(
        current_turn.clone(),
        vec![
            user_item("previous-user", previous_turn.clone(), "earlier"),
            agent_item("previous-agent", previous_turn, "answer"),
            user_item("current-user", current_turn.clone(), "now"),
        ],
    );
    let input = ContextInput::new(
        &base_snapshot,
        current_turn,
        [
            InstructionPlacement::Turn,
            InstructionPlacement::Skill,
            InstructionPlacement::Directory,
            InstructionPlacement::User,
            InstructionPlacement::Product,
            InstructionPlacement::System,
        ]
        .into_iter()
        .map(|placement| {
            instruction(
                &format!("{placement:?}"),
                placement,
                InstructionRetention::Required,
                "rule",
            )
        })
        .collect(),
        Vec::new(),
        budget(1_000),
    );

    let ContextPreparation::Ready(first) = ContextPlanner::prepare(&input).unwrap() else {
        panic!("context must fit");
    };
    let ContextPreparation::Ready(second) = ContextPlanner::prepare(&input).unwrap() else {
        panic!("context must fit");
    };

    assert_eq!(format!("{first:?}"), format!("{second:?}"));
    assert_eq!(first.source_thread_sequence(), base_snapshot.sequence);
    assert_eq!(first.selected_items().len(), 3);
    assert_eq!(
        first
            .instructions()
            .iter()
            .map(|entry| entry.placement())
            .collect::<Vec<_>>(),
        vec![
            InstructionPlacement::System,
            InstructionPlacement::Product,
            InstructionPlacement::User,
            InstructionPlacement::Directory,
            InstructionPlacement::Skill,
            InstructionPlacement::Turn
        ]
    );
    let super::super::ContextBudgetReport::CoreManaged { maximum_input, .. } = first.budget()
    else {
        panic!("test budget must be Core-managed");
    };
    assert!(first.budget().total_input() <= *maximum_input);
}

#[test]
fn skills_preserve_provider_order_within_their_context_layer() {
    let current_turn = id::<TurnId>("current");
    let base_snapshot = snapshot(
        current_turn.clone(),
        vec![user_item("current-user", current_turn.clone(), "now")],
    );
    let input = ContextInput::new(
        &base_snapshot,
        current_turn,
        vec![
            instruction(
                "skill-ash",
                InstructionPlacement::Skill,
                InstructionRetention::Required,
                "first selected Skill",
            ),
            instruction(
                "skill-alpha",
                InstructionPlacement::Skill,
                InstructionRetention::Required,
                "second selected Skill",
            ),
        ],
        Vec::new(),
        budget(1_000),
    );

    let ContextPreparation::Ready(plan) = ContextPlanner::prepare(&input).unwrap() else {
        panic!("context must fit");
    };

    assert_eq!(plan.instructions()[0].source().identity(), "skill-ash");
    assert_eq!(plan.instructions()[1].source().identity(), "skill-alpha");
}

#[test]
fn reports_distinct_mandatory_tool_current_and_shape_failures() {
    let turn_id = id::<TurnId>("current");
    let base_snapshot = snapshot(
        turn_id.clone(),
        vec![user_item("current-user", turn_id.clone(), "hello")],
    );
    let mandatory = ContextInput::new(
        &base_snapshot,
        turn_id.clone(),
        vec![instruction(
            "system",
            InstructionPlacement::System,
            InstructionRetention::Required,
            &"x".repeat(1_000),
        )],
        Vec::new(),
        budget(120),
    );
    assert!(matches!(
        ContextPlanner::prepare(&mandatory),
        Err(ContextPreparationError::MandatoryInstructionsTooLarge { .. })
    ));

    let tool = ToolDefinition {
        name: ToolName::new("large-tool").unwrap(),
        description: "x".repeat(1_000),
        parameters: serde_json::json!({"type": "object"}),
        strict: true,
    };
    let tools = ContextInput::new(
        &base_snapshot,
        turn_id.clone(),
        Vec::new(),
        vec![tool],
        budget(120),
    );
    assert!(matches!(
        ContextPlanner::prepare(&tools),
        Err(ContextPreparationError::ToolDefinitionsTooLarge { .. })
    ));

    let large_current = snapshot(
        turn_id.clone(),
        vec![user_item(
            "current-user",
            turn_id.clone(),
            &"x".repeat(1_000),
        )],
    );
    let current = ContextInput::new(
        &large_current,
        turn_id.clone(),
        Vec::new(),
        Vec::new(),
        budget(120),
    );
    assert!(matches!(
        ContextPlanner::prepare(&current),
        Err(ContextPreparationError::CurrentInputTooLarge { .. })
    ));

    let dangling = snapshot(
        turn_id.clone(),
        vec![ThreadItem::ToolResult {
            item_id: id("result"),
            turn_id: turn_id.clone(),
            tool_call_id: id("missing-call"),
            text: "result".into(),
            content: None,
            is_error: false,
        }],
    );
    let unsupported = ContextInput::new(&dangling, turn_id, Vec::new(), Vec::new(), budget(120));
    assert!(matches!(
        ContextPlanner::prepare(&unsupported),
        Err(ContextPreparationError::UnsupportedContextShape(_))
    ));
}

#[test]
fn requests_compaction_for_an_oldest_prefix_without_dropping_current_input() {
    let old_one = id::<TurnId>("old-one");
    let old_two = id::<TurnId>("old-two");
    let recent = id::<TurnId>("recent");
    let current = id::<TurnId>("current");
    let snapshot = snapshot(
        current.clone(),
        vec![
            user_item("old-one", old_one.clone(), &"a".repeat(4_000)),
            user_item("old-two", old_two.clone(), &"b".repeat(4_000)),
            user_item("recent", recent.clone(), &"c".repeat(4_000)),
            user_item("current", current.clone(), &"d".repeat(100)),
        ],
    );
    let input = ContextInput::new(
        &snapshot,
        current,
        Vec::new(),
        Vec::new(),
        ContextBudget::core_managed(
            ContextTokenCount::new(3_300),
            ContextTokenCount::new(200),
            ContextTokenCount::new(100),
            ContextCompactionLimit::ContextWindow,
        ),
    );

    let ContextPreparation::NeedsCompaction(plan) = ContextPlanner::prepare(&input).unwrap() else {
        panic!("old history must require compaction");
    };

    assert_eq!(plan.source_thread_sequence, snapshot.sequence);
    assert_eq!(plan.covered_turns, vec![old_one]);
    assert!(!plan.covered_turns.contains(&old_two));
    let super::super::ContextBudgetReport::CoreManaged {
        current_turn_tokens,
        ..
    } = plan.budget
    else {
        panic!("test budget must be Core-managed");
    };
    assert!(current_turn_tokens.get() > 0);
}

#[test]
fn overflow_recovery_compacts_the_complete_terminal_prefix_and_excludes_the_current_turn() {
    let old_one = id::<TurnId>("overflow-old-one");
    let old_two = id::<TurnId>("overflow-old-two");
    let current = id::<TurnId>("overflow-current");
    let snapshot = snapshot(
        current.clone(),
        vec![
            user_item("overflow-old-one", old_one.clone(), &"a".repeat(4_000)),
            user_item("overflow-old-two", old_two.clone(), &"b".repeat(4_000)),
            user_item("overflow-current", current.clone(), &"c".repeat(4_000)),
        ],
    );
    let input = ContextInput::new(
        &snapshot,
        current,
        Vec::new(),
        Vec::new(),
        ContextBudget::provider_managed(),
    );

    let plan = ContextPlanner::prepare_overflow_recovery(&input).unwrap();

    assert_eq!(plan.covered_turns, vec![old_one, old_two]);
    assert_eq!(plan.covered.end_sequence, 3);
    assert_eq!(
        plan.source_items
            .iter()
            .map(|item| item.item_id().as_str())
            .collect::<Vec<_>>(),
        vec!["overflow-old-one", "overflow-old-two"]
    );
    assert!(plan.target_tokens.get() <= super::MAX_OVERFLOW_CHECKPOINT_TOKENS);
}

#[test]
fn overflow_recovery_uses_bounded_tool_results_without_rewriting_durable_history() {
    let old = id::<TurnId>("overflow-tool-old");
    let current = id::<TurnId>("overflow-tool-current");
    let call_id = id::<ToolCallId>("overflow-shell-call");
    let durable_output = format!("HEAD\n{}\nTAIL", "x".repeat(100_000));
    let snapshot = snapshot(
        current.clone(),
        vec![
            ThreadItem::ToolCall {
                item_id: id("overflow-shell-call-item"),
                turn_id: old.clone(),
                tool_call_id: call_id.clone(),
                name: ToolName::new("shell-command").unwrap(),
                arguments_json: "{}".into(),
                binding: None,
            },
            ThreadItem::ToolResult {
                item_id: id("overflow-shell-result"),
                turn_id: old.clone(),
                tool_call_id: call_id,
                text: durable_output.clone(),
                content: None,
                is_error: false,
            },
            user_item("overflow-tool-current", current.clone(), "continue"),
        ],
    );
    let input = ContextInput::new(
        &snapshot,
        current,
        Vec::new(),
        Vec::new(),
        ContextBudget::provider_managed(),
    );

    let plan = ContextPlanner::prepare_overflow_recovery(&input).unwrap();

    let ThreadItem::ToolResult { text: selected, .. } = &plan.source_items[1] else {
        panic!("compaction source must preserve the paired Tool Result");
    };
    assert!(selected.len() <= 30 * 1024);
    assert!(selected.contains("context truncated"));
    assert!(selected.starts_with("HEAD"));
    assert!(selected.ends_with("TAIL"));
    let ThreadItem::ToolResult { text: durable, .. } = &snapshot.items[1] else {
        panic!("snapshot must contain the durable Tool Result");
    };
    assert_eq!(durable, &durable_output);
    assert_eq!(input.items(), snapshot.items);
}

#[test]
fn overflow_recovery_rejects_a_turn_without_completed_history() {
    let current = id::<TurnId>("overflow-only-current");
    let snapshot = snapshot(
        current.clone(),
        vec![user_item(
            "overflow-only-current",
            current.clone(),
            &"current".repeat(100),
        )],
    );
    let input = ContextInput::new(
        &snapshot,
        current,
        Vec::new(),
        Vec::new(),
        ContextBudget::provider_managed(),
    );

    assert_eq!(
        ContextPlanner::prepare_overflow_recovery(&input).unwrap_err(),
        ContextPreparationError::NoCompactionCandidate
    );
}

#[test]
fn compaction_request_uses_the_hard_window_not_the_pressure_threshold() {
    let old_one = id::<TurnId>("pressure-old-one");
    let old_two = id::<TurnId>("pressure-old-two");
    let recent = id::<TurnId>("pressure-recent");
    let current = id::<TurnId>("pressure-current");
    let snapshot = snapshot(
        current.clone(),
        vec![
            user_item("pressure-old-one", old_one.clone(), &"a".repeat(4_000)),
            user_item("pressure-old-two", old_two.clone(), &"b".repeat(4_000)),
            user_item("pressure-recent", recent, &"c".repeat(4_000)),
            user_item("pressure-current", current.clone(), "now"),
        ],
    );
    let input = ContextInput::new(
        &snapshot,
        current,
        Vec::new(),
        Vec::new(),
        ContextBudget::core_managed(
            ContextTokenCount::new(4_000),
            ContextTokenCount::new(200),
            ContextTokenCount::new(100),
            ContextCompactionLimit::Tokens(ContextTokenCount::new(2_500)),
        ),
    );

    let ContextPreparation::NeedsCompaction(plan) = ContextPlanner::prepare(&input).unwrap() else {
        panic!("the pressure threshold must request compaction");
    };

    assert_eq!(plan.covered_turns, vec![old_one, old_two]);
}

#[test]
fn best_effort_instructions_are_omitted_before_history_is_compacted() {
    let previous = id::<TurnId>("previous");
    let current = id::<TurnId>("current");
    let snapshot = snapshot(
        current.clone(),
        vec![
            user_item("previous", previous, "history"),
            user_item("current", current.clone(), "now"),
        ],
    );
    let input = ContextInput::new(
        &snapshot,
        current,
        vec![instruction(
            "best-effort-skill",
            InstructionPlacement::Skill,
            InstructionRetention::BestEffort,
            &"x".repeat(1_000),
        )],
        Vec::new(),
        budget(120),
    );

    let ContextPreparation::Ready(plan) = ContextPlanner::prepare(&input).unwrap() else {
        panic!("best-effort instructions must not force compaction");
    };

    assert!(plan.instructions().is_empty());
    assert_eq!(plan.omitted_instructions().len(), 1);
    assert_eq!(
        plan.omitted_instructions()[0].source_identity(),
        "best-effort-skill"
    );
}

#[test]
fn inherited_checkpoint_uses_item_provenance_and_preserves_the_raw_tail() {
    let old = id::<TurnId>("old");
    let recent = id::<TurnId>("recent");
    let current = id::<TurnId>("current");
    let mut snapshot = snapshot(
        current.clone(),
        vec![
            user_item("old", old, "old raw history"),
            user_item("recent", recent, "recent raw history"),
            user_item("current", current.clone(), "current input"),
        ],
    );
    snapshot.context_checkpoints.push(ContextCheckpoint {
        checkpoint_id: ContextCheckpointId::new("checkpoint").unwrap(),
        source_thread_id: ThreadId::new("parent-thread").unwrap(),
        covered: ContextSourceRange {
            start_sequence: 1,
            end_sequence: 100,
        },
        referenced_items: vec![ItemId::new("old").unwrap()],
        source_digest: ContextSourceDigest::new(format!("sha256:{}", "a".repeat(64))).unwrap(),
        summary: "old history summary".into(),
        schema_revision: "context-checkpoint-v1".into(),
        prompt_revision: "compaction-v2".into(),
        context_policy_revision: "context-policy-v1".into(),
        generator_model: None,
        created_at_unix_ms: 1,
        verification: ContextCheckpointVerification::Verified,
    });
    let input = ContextInput::new(&snapshot, current, Vec::new(), Vec::new(), budget(1_000));

    let ContextPreparation::Ready(plan) = ContextPlanner::prepare(&input).unwrap() else {
        panic!("checkpoint plus raw tail must fit");
    };

    assert_eq!(plan.checkpoint().unwrap().summary, "old history summary");
    let super::super::ContextBudgetReport::CoreManaged { history_tokens, .. } = plan.budget()
    else {
        panic!("core budget required");
    };
    assert!(
        history_tokens.get() as usize
            >= ash_prompts::checkpoint_prompt(plan.checkpoint().unwrap())
                .body()
                .len()
                / 4,
        "the checkpoint prefix, escaped body and wrapper must all count toward the history budget"
    );
    assert_eq!(
        plan.selected_items()
            .iter()
            .map(|item| item.item_id().as_str())
            .collect::<Vec<_>>(),
        vec!["recent", "current"]
    );
}

#[test]
fn invalid_budget_is_not_treated_as_empty_history() {
    let current = id::<TurnId>("current");
    let snapshot = snapshot(
        current.clone(),
        vec![user_item("current", current.clone(), "now")],
    );
    let input = ContextInput::new(
        &snapshot,
        current,
        Vec::new(),
        Vec::new(),
        ContextBudget::core_managed(
            ContextTokenCount::new(100),
            ContextTokenCount::new(100),
            ContextTokenCount::ZERO,
            ContextCompactionLimit::ContextWindow,
        ),
    );

    assert_eq!(
        ContextPlanner::prepare(&input).unwrap_err(),
        ContextPreparationError::InvalidBudget
    );
}

fn instruction(
    identity: &str,
    layer: InstructionPlacement,
    retention: InstructionRetention,
    body: &str,
) -> InstructionFragment {
    InstructionFragment::new(
        InstructionSource::new("test", identity, "1"),
        layer,
        retention,
        body,
    )
}

fn budget(context_window: u32) -> ContextBudget {
    ContextBudget::core_managed(
        ContextTokenCount::new(context_window),
        ContextTokenCount::new(20),
        ContextTokenCount::new(10),
        ContextCompactionLimit::ContextWindow,
    )
}

fn user_item(item_id: &str, turn_id: TurnId, text: &str) -> ThreadItem {
    ThreadItem::UserMessage {
        item_id: id(item_id),
        turn_id,
        text: text.into(),
    }
}

fn agent_item(item_id: &str, turn_id: TurnId, text: &str) -> ThreadItem {
    ThreadItem::AgentMessage {
        item_id: id(item_id),
        turn_id,
        text: text.into(),
    }
}

fn snapshot(current_turn_id: TurnId, items: Vec<ThreadItem>) -> ThreadSnapshot {
    let mut turn_ids = items
        .iter()
        .map(|item| item.turn_id().clone())
        .collect::<Vec<_>>();
    turn_ids.dedup();
    let item_sequences = items
        .iter()
        .enumerate()
        .map(|(index, item)| (item.item_id().clone(), index as u64 + 2))
        .collect();
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
        sequence: items.len() as u64 + 2,
        usage: ash_protocol::ModelUsageSummary::default(),
        reference_cost: ash_protocol::ModelReferenceCostSummary::default(),
        goal: None,
        goal_budget_limited_turn_id: None,
        context_calibrations: Vec::new(),
        turns: turn_ids
            .into_iter()
            .map(|turn_id| TurnSnapshot {
                kind: ash_protocol::TurnKind::Coding,
                instructions: None,
                status: if turn_id == current_turn_id {
                    TurnStatus::Running
                } else {
                    TurnStatus::Completed
                },
                status_changed_at_unix_ms: 0,
                started_at_unix_ms: None,
                duration_ms: None,
                turn_id,
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
            })
            .collect(),
        items,
        context_checkpoints: Vec::new(),
        context_overflow_recoveries: BTreeMap::new(),
        item_sequences,
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

impl_test_id!(ItemId, SessionId, ThreadId, ToolCallId, TurnId);

fn id<T: TestId>(value: &str) -> T {
    T::from_test(value)
}

#[test]
fn a_maximum_sized_checkpoint_fits_the_reserved_continuation_space() {
    let old = id::<TurnId>("old");
    let recent = id::<TurnId>("recent");
    let current = id::<TurnId>("current");
    let mut state = snapshot(
        current.clone(),
        vec![
            user_item("old", old.clone(), &"a".repeat(4_000)),
            user_item("recent", recent.clone(), &"b".repeat(1_400)),
            user_item("current", current.clone(), "now"),
        ],
    );
    let limits = ContextBudget::core_managed(
        ContextTokenCount::new(6_000),
        ContextTokenCount::new(200),
        ContextTokenCount::ZERO,
        ContextCompactionLimit::Tokens(ContextTokenCount::new(800)),
    );
    let ContextPreparation::NeedsCompaction(compaction) = ContextPlanner::prepare(
        &ContextInput::new(&state, current.clone(), Vec::new(), Vec::new(), limits),
    )
    .unwrap() else {
        panic!("history must need compaction");
    };
    assert_eq!(
        compaction.covered_turns,
        vec![old, recent],
        "keeping the recent turn would leave too little room for a framed checkpoint"
    );
    state.context_checkpoints.push(ContextCheckpoint {
        checkpoint_id: ContextCheckpointId::new("c".repeat(super::super::CHECKPOINT_ID_BYTES))
            .unwrap(),
        source_thread_id: state.thread_id.clone(),
        covered: compaction.covered,
        referenced_items: compaction
            .source_items
            .iter()
            .map(|item| item.item_id().clone())
            .collect(),
        source_digest: ContextSourceDigest::new(format!("sha256:{}", "a".repeat(64))).unwrap(),
        summary: "x".repeat((compaction.target_tokens.get() as usize - 6) * 4),
        schema_revision: "context-checkpoint-v1".into(),
        prompt_revision: "compaction-v2".into(),
        context_policy_revision: "context-policy-v2".into(),
        generator_model: None,
        created_at_unix_ms: 1,
        verification: ContextCheckpointVerification::Verified,
    });
    let ContextPreparation::Ready(plan) = ContextPlanner::prepare(&ContextInput::new(
        &state,
        current,
        Vec::new(),
        Vec::new(),
        limits,
    ))
    .unwrap() else {
        panic!("the accepted summary and its framing must fit without another compaction");
    };
    assert!(plan.budget().total_input().get() <= 600);
    assert!(super::super::ContextAssembler::assemble(&plan).unwrap().input.iter().any(|item| {
        matches!(item, ash_protocol::InputItem::Message(message) if message.content.iter().any(|content| matches!(content, ash_protocol::ContentPart::Text(text) if text.contains("context_checkpoint"))))
    }));
}

#[test]
fn audio_budget_uses_duration_instead_of_encoded_byte_size() {
    let current = id::<TurnId>("current");
    let audio = |duration_ms| ThreadItem::UserAudioAttachment {
        item_id: id::<ItemId>("audio"),
        turn_id: current.clone(),
        attachment: ash_protocol::AudioAttachmentRef {
            content_digest: ash_protocol::ContentDigest::sha256(b"audio"),
            media_type: ash_protocol::AudioMediaType::Wav,
            encoded_bytes: 16 * 1024 * 1024,
            duration_ms,
        },
    };
    let short = snapshot(current.clone(), vec![audio(1000)]);
    let input = ContextInput::new(
        &short,
        current.clone(),
        Vec::new(),
        Vec::new(),
        budget(1000),
    );
    assert!(matches!(
        ContextPlanner::prepare(&input),
        Ok(ContextPreparation::Ready(_))
    ));
    let long = snapshot(current.clone(), vec![audio(3_600_000)]);
    let input = ContextInput::new(&long, current, Vec::new(), Vec::new(), budget(1000));
    assert!(!matches!(
        ContextPlanner::prepare(&input),
        Ok(ContextPreparation::Ready(_))
    ));
}
