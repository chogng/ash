use super::*;
use ash_history::CURRENT_STORED_EVENT_SCHEMA_VERSION;
use ash_history::EventId;
use ash_history::MINIMUM_SUPPORTED_EVENT_SCHEMA_VERSION;
use ash_history::ThreadCommandReceipt;
use ash_history::Timestamp;
use ash_protocol::CommandId;
use ash_protocol::ContextCheckpointId;
use ash_protocol::ContextCheckpointVerification;
use ash_protocol::ItemId;
use ash_protocol::StableTurnErrorCode;
use ash_protocol::ThreadCommand;
use ash_protocol::ToolCallId;
use ash_protocol::ToolName;
use ash_protocol::UserInput;

fn envelope(sequence: u64, event: ThreadEvent) -> StoredEvent {
    let command = match &event {
        ThreadEvent::TurnAccepted { .. } => Some(ThreadCommandReceipt {
            command_id: CommandId::new(format!("command_{sequence}"))
                .expect("test ID is non-empty"),
            command: ThreadCommand::StartTurn {
                advisor: None,
                kind: ash_protocol::TurnKind::Coding,
                instructions: None,
                model: None,
                activated_skills: Vec::new(),
                host_activated_skills: Some(Vec::new()),
                approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                input: vec![UserInput::Text {
                    text: "hello".into(),
                }],
            },
        }),
        _ => None,
    };
    StoredEvent {
        time_context: None,
        schema_version: CURRENT_STORED_EVENT_SCHEMA_VERSION,
        event_id: EventId(format!("event_{sequence}")),
        sequence,
        thread_id: ThreadId::new("thread_1").expect("test ID is non-empty"),
        recorded_at: Timestamp(u128::from(sequence)),
        command,
        event,
    }
}

fn envelope_at(sequence: u64, recorded_at_unix_ms: u64, event: ThreadEvent) -> StoredEvent {
    let mut envelope = envelope(sequence, event);
    envelope.recorded_at = Timestamp(u128::from(recorded_at_unix_ms));
    envelope
}

#[test]
fn reducer_preserves_the_thread_creation_timestamp() {
    let thread = reduce_thread_event(
        None,
        &envelope(
            1,
            ThreadEvent::ThreadCreated {
                agent_id: Some(ash_protocol::AgentId::new("agent-test").unwrap()),
                origin: Default::default(),
                agent: None,
                session_id: ash_protocol::SessionId::new("session_1").unwrap(),
                thread_id: ThreadId::new("thread_1").unwrap(),
                title: "test".into(),
            },
        ),
    )
    .unwrap();

    assert_eq!(thread.created_at_unix_ms, 1);
}

#[test]
fn reducer_preserves_when_and_why_a_thread_was_archived() {
    let thread_id = ThreadId::new("thread_1").unwrap();
    let created = reduce_thread_event(
        None,
        &envelope_at(
            1,
            100,
            ThreadEvent::ThreadCreated {
                agent_id: Some(ash_protocol::AgentId::new("agent-test").unwrap()),
                origin: Default::default(),
                agent: None,
                session_id: ash_protocol::SessionId::new("session_1").unwrap(),
                thread_id: thread_id.clone(),
                title: "test".into(),
            },
        ),
    )
    .unwrap();
    let archived = reduce_thread_event(
        Some(created),
        &envelope_at(
            2,
            900,
            ThreadEvent::ThreadArchived {
                thread_id,
                reason: ThreadArchiveReason::Stopped,
            },
        ),
    )
    .unwrap();

    assert_eq!(archived.archived_at_unix_ms, Some(900));
    assert_eq!(archived.archive_reason, Some(ThreadArchiveReason::Stopped));
}

#[test]
fn reducer_accumulates_terminal_turn_durations_and_keeps_the_active_turn_start() {
    let thread_id = ThreadId::new("thread_1").unwrap();
    let first_turn_id = TurnId::new("turn_1").unwrap();
    let second_turn_id = TurnId::new("turn_2").unwrap();
    let active_turn_id = TurnId::new("turn_3").unwrap();
    let accepted = |turn_id: TurnId| ThreadEvent::TurnAccepted {
        advisor: None,
        thread_id: thread_id.clone(),
        turn_id,
        kind: ash_protocol::TurnKind::Coding,
        instructions: None,
        policy_revision: "test-policy-v1".into(),
        approval_mode: ash_protocol::ApprovalMode::AskPermissions,
        tool_mode: ash_protocol::ToolMode::Direct,
        activated_skills: Vec::new(),
        model: None,
        tool_profile: None,
    };
    let events = vec![
        envelope_at(
            1,
            100,
            ThreadEvent::ThreadCreated {
                agent_id: Some(ash_protocol::AgentId::new("agent-test").unwrap()),
                origin: Default::default(),
                agent: None,
                session_id: ash_protocol::SessionId::new("session_1").unwrap(),
                thread_id: thread_id.clone(),
                title: "test".into(),
            },
        ),
        envelope_at(2, 200, accepted(first_turn_id.clone())),
        envelope_at(
            3,
            1_000,
            ThreadEvent::TurnStarted {
                thread_id: thread_id.clone(),
                turn_id: first_turn_id.clone(),
            },
        ),
        envelope_at(
            4,
            5_000,
            ThreadEvent::TurnCompleted {
                thread_id: thread_id.clone(),
                turn_id: first_turn_id,
            },
        ),
        envelope_at(5, 6_000, accepted(second_turn_id.clone())),
        envelope_at(
            6,
            8_000,
            ThreadEvent::TurnStarted {
                thread_id: thread_id.clone(),
                turn_id: second_turn_id.clone(),
            },
        ),
        envelope_at(
            7,
            11_000,
            ThreadEvent::TurnFailed {
                thread_id: thread_id.clone(),
                turn_id: second_turn_id,
                error: StableTurnError::model_invocation_failed(),
            },
        ),
        envelope_at(8, 12_000, accepted(active_turn_id.clone())),
        envelope_at(
            9,
            15_000,
            ThreadEvent::TurnStarted {
                thread_id,
                turn_id: active_turn_id,
            },
        ),
    ];
    let snapshot = events
        .iter()
        .try_fold(None, |snapshot, event| {
            reduce_thread_event(snapshot, event).map(Some)
        })
        .unwrap()
        .unwrap();

    assert_eq!(snapshot.completed_turn_duration_ms(), 7_000);
    assert_eq!(snapshot.active_turn_started_at_unix_ms(), Some(15_000));
    assert_eq!(snapshot.turns[0].status_changed_at_unix_ms, 5_000);
    assert_eq!(snapshot.turns[1].status_changed_at_unix_ms, 11_000);
    assert_eq!(snapshot.turns[2].status_changed_at_unix_ms, 15_000);
}

#[test]
fn reducer_keeps_legacy_external_execution_attempts_readable() {
    let thread_id = ThreadId::new("thread_1").expect("test ID is non-empty");
    let turn_id = TurnId::new("turn_1").expect("test ID is non-empty");
    let thread = reduce_thread_event(
        None,
        &envelope(
            1,
            ThreadEvent::ThreadCreated {
                agent_id: Some(ash_protocol::AgentId::new("agent-test").unwrap()),
                origin: Default::default(),
                agent: None,
                session_id: ash_protocol::SessionId::new("session_1")
                    .expect("test ID is non-empty"),
                thread_id: thread_id.clone(),
                title: "test".into(),
            },
        ),
    )
    .unwrap();
    let thread = reduce_thread_event(
        Some(thread),
        &envelope(
            2,
            ThreadEvent::TurnAccepted {
                advisor: None,
                kind: ash_protocol::TurnKind::Coding,
                instructions: None,
                thread_id: thread_id.clone(),
                turn_id: turn_id.clone(),
                policy_revision: "test-policy-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                tool_mode: ash_protocol::ToolMode::Direct,
                activated_skills: Vec::new(),
                model: None,
                tool_profile: None,
            },
        ),
    )
    .unwrap();
    let thread = reduce_thread_event(
        Some(thread),
        &envelope(
            3,
            ThreadEvent::TurnStarted {
                thread_id: thread_id.clone(),
                turn_id: turn_id.clone(),
            },
        ),
    )
    .unwrap();
    let thread = reduce_thread_event(
        Some(thread),
        &envelope(
            4,
            ThreadEvent::TurnExecutionAttempted {
                thread_id,
                turn_id: turn_id.clone(),
                backend: "legacy-external-backend".into(),
            },
        ),
    )
    .unwrap();

    assert_eq!(
        thread.turns[0].execution_backend_attempt.as_deref(),
        Some("legacy-external-backend")
    );
}

#[test]
fn reducer_rebuilds_a_failed_turn_with_stable_error_details() {
    let thread = reduce_thread_event(
        None,
        &envelope(
            1,
            ThreadEvent::ThreadCreated {
                agent_id: Some(ash_protocol::AgentId::new("agent-test").unwrap()),
                origin: Default::default(),
                agent: None,
                session_id: ash_protocol::SessionId::new("session_1")
                    .expect("test ID is non-empty"),
                thread_id: ThreadId::new("thread_1").expect("test ID is non-empty"),
                title: "test".into(),
            },
        ),
    )
    .unwrap();
    let thread = reduce_thread_event(
        Some(thread),
        &envelope(
            2,
            ThreadEvent::TurnAccepted {
                advisor: None,
                kind: ash_protocol::TurnKind::Coding,
                instructions: None,
                thread_id: ThreadId::new("thread_1").expect("test ID is non-empty"),
                turn_id: TurnId::new("turn_1").expect("test ID is non-empty"),
                policy_revision: "test-policy-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                tool_mode: ash_protocol::ToolMode::Direct,
                activated_skills: Vec::new(),
                model: None,
                tool_profile: None,
            },
        ),
    )
    .unwrap();
    let thread = reduce_thread_event(
        Some(thread),
        &envelope(
            3,
            ThreadEvent::TurnStarted {
                thread_id: ThreadId::new("thread_1").expect("test ID is non-empty"),
                turn_id: TurnId::new("turn_1").expect("test ID is non-empty"),
            },
        ),
    )
    .unwrap();
    let thread = reduce_thread_event(
        Some(thread),
        &envelope(
            4,
            ThreadEvent::TurnFailed {
                thread_id: ThreadId::new("thread_1").expect("test ID is non-empty"),
                turn_id: TurnId::new("turn_1").expect("test ID is non-empty"),
                error: StableTurnError::model_invocation_failed(),
            },
        ),
    )
    .unwrap();

    assert_eq!(thread.turns[0].status, TurnStatus::Failed);
    assert_eq!(
        thread.turns[0].failure.as_ref().unwrap().code,
        StableTurnErrorCode::ModelInvocationFailed
    );
}

#[test]
fn reducer_rebuilds_model_calibration_and_rejects_unknown_algorithm_revisions() {
    let model = ash_protocol::ModelRef::new(
        ash_protocol::ProviderId::new("provider").unwrap(),
        ash_protocol::ModelId::new("model").unwrap(),
    );
    let mut accepted = envelope(
        2,
        ThreadEvent::TurnAccepted {
            advisor: None,
            kind: ash_protocol::TurnKind::Coding,
            instructions: None,
            thread_id: ThreadId::new("thread_1").unwrap(),
            turn_id: TurnId::new("turn_1").unwrap(),
            policy_revision: "test-policy-v1".into(),
            approval_mode: ash_protocol::ApprovalMode::AskPermissions,
            tool_mode: ash_protocol::ToolMode::Direct,
            activated_skills: Vec::new(),
            model: Some(model.clone()),
            tool_profile: None,
        },
    );
    accepted.command = Some(ThreadCommandReceipt {
        command_id: CommandId::new("command_2").unwrap(),
        command: ThreadCommand::StartTurn {
            advisor: None,
            kind: ash_protocol::TurnKind::Coding,
            instructions: None,
            model: Some(model.clone()),
            activated_skills: Vec::new(),
            host_activated_skills: Some(Vec::new()),
            approval_mode: ash_protocol::ApprovalMode::AskPermissions,
            tool_mode: ash_protocol::ToolMode::Direct,
            tool_profile: None,
            input: vec![UserInput::Text {
                text: "hello".into(),
            }],
        },
    });
    let events = [
        envelope(
            1,
            ThreadEvent::ThreadCreated {
                agent_id: Some(ash_protocol::AgentId::new("agent-test").unwrap()),
                origin: Default::default(),
                agent: None,
                session_id: ash_protocol::SessionId::new("session_1").unwrap(),
                thread_id: ThreadId::new("thread_1").unwrap(),
                title: "test".into(),
            },
        ),
        accepted,
        envelope(
            3,
            ThreadEvent::TurnStarted {
                thread_id: ThreadId::new("thread_1").unwrap(),
                turn_id: TurnId::new("turn_1").unwrap(),
            },
        ),
    ];
    let snapshot = events
        .iter()
        .try_fold(None, |snapshot, event| {
            reduce_thread_event(snapshot, event).map(Some)
        })
        .unwrap()
        .unwrap();
    let usage = ash_protocol::ModelUsage {
        input_tokens: Some(120),
        output_tokens: Some(8),
        cached_input_tokens: Some(0),
        cache_write_input_tokens: Some(0),
        reasoning_tokens: None,
    };
    let invalid = ThreadEvent::ModelUsageRecorded {
        thread_id: ThreadId::new("thread_1").unwrap(),
        turn_id: TurnId::new("turn_1").unwrap(),
        usage: Some(usage.clone()),
        input_estimate: Some(ash_protocol::ModelInputEstimate {
            estimated_input_tokens: 100,
            estimator_revision: crate::context::CONTEXT_ESTIMATOR_REVISION.into(),
            calibration_revision: "unknown-calibration-v2".into(),
        }),
    };
    assert!(reduce_thread_event(Some(snapshot.clone()), &envelope(4, invalid)).is_err());
    assert_eq!(snapshot.usage.model_invocations, 0);

    let valid = ThreadEvent::ModelUsageRecorded {
        thread_id: ThreadId::new("thread_1").unwrap(),
        turn_id: TurnId::new("turn_1").unwrap(),
        usage: Some(usage),
        input_estimate: Some(ash_protocol::ModelInputEstimate {
            estimated_input_tokens: 100,
            estimator_revision: crate::context::CONTEXT_ESTIMATOR_REVISION.into(),
            calibration_revision: crate::context::CONTEXT_CALIBRATION_REVISION.into(),
        }),
    };
    let rebuilt = reduce_thread_event(Some(snapshot), &envelope(4, valid)).unwrap();

    assert_eq!(rebuilt.usage.model_invocations, 1);
    assert_eq!(
        rebuilt.turns[0].context_usage,
        Some(ash_protocol::ModelContextUsage {
            used_tokens: 128,
            source: ash_protocol::ModelContextUsageSource::ProviderReported,
        })
    );
    let calibration = rebuilt
        .context_calibration(&model, crate::context::CONTEXT_ESTIMATOR_REVISION)
        .unwrap();
    assert_eq!(calibration.correction_ratio_ppm(), 1_200_000);
    assert_eq!(calibration.samples(), 1);
}

#[test]
fn reducer_rebuilds_a_steer_receipt_from_its_immediately_preceding_items() {
    let mut snapshot = None;
    for event in [
        envelope(
            1,
            ThreadEvent::ThreadCreated {
                agent_id: Some(ash_protocol::AgentId::new("agent-test").unwrap()),
                origin: Default::default(),
                agent: None,
                session_id: ash_protocol::SessionId::new("session_1").unwrap(),
                thread_id: ThreadId::new("thread_1").unwrap(),
                title: "test".into(),
            },
        ),
        envelope(
            2,
            ThreadEvent::TurnAccepted {
                advisor: None,
                kind: ash_protocol::TurnKind::Coding,
                instructions: None,
                thread_id: ThreadId::new("thread_1").unwrap(),
                turn_id: TurnId::new("turn_1").unwrap(),
                policy_revision: "test-policy-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                tool_mode: ash_protocol::ToolMode::Direct,
                activated_skills: Vec::new(),
                model: None,
                tool_profile: None,
            },
        ),
        envelope(
            3,
            ThreadEvent::ItemCompleted {
                checkpoint_after_sequence: None,
                workspace_checkpoint: None,
                thread_id: ThreadId::new("thread_1").unwrap(),
                turn_id: TurnId::new("turn_1").unwrap(),
                item: ThreadItem::UserMessage {
                    item_id: ItemId::new("item_initial").unwrap(),
                    turn_id: TurnId::new("turn_1").unwrap(),
                    text: "initial".into(),
                },
            },
        ),
        envelope(
            4,
            ThreadEvent::TurnStarted {
                thread_id: ThreadId::new("thread_1").unwrap(),
                turn_id: TurnId::new("turn_1").unwrap(),
            },
        ),
        envelope(
            5,
            ThreadEvent::ItemCompleted {
                checkpoint_after_sequence: None,
                workspace_checkpoint: None,
                thread_id: ThreadId::new("thread_1").unwrap(),
                turn_id: TurnId::new("turn_1").unwrap(),
                item: ThreadItem::UserMessage {
                    item_id: ItemId::new("item_steer").unwrap(),
                    turn_id: TurnId::new("turn_1").unwrap(),
                    text: "updated direction".into(),
                },
            },
        ),
    ] {
        snapshot = Some(reduce_thread_event(snapshot, &event).unwrap());
    }
    let mut marker = envelope(
        6,
        ThreadEvent::TurnSteered {
            thread_id: ThreadId::new("thread_1").unwrap(),
            turn_id: TurnId::new("turn_1").unwrap(),
            item_ids: vec![ItemId::new("item_steer").unwrap()],
        },
    );
    marker.command = Some(ThreadCommandReceipt {
        command_id: CommandId::new("steer_1").unwrap(),
        command: ThreadCommand::SteerTurn {
            turn_id: TurnId::new("turn_1").unwrap(),
            input: vec![UserInput::Text {
                text: "updated direction".into(),
            }],
        },
    });

    let rebuilt = reduce_thread_event(snapshot, &marker).unwrap();

    assert!(matches!(
        rebuilt.commands.last().unwrap().result,
        ThreadCommandResult::TurnSteered { ref turn_id } if turn_id.as_str() == "turn_1"
    ));
    assert_eq!(rebuilt.commands.last().unwrap().response_sequence, 6);
    let delivered = reduce_thread_event(
        Some(rebuilt),
        &envelope(
            7,
            ThreadEvent::TurnSteerDelivered {
                thread_id: ThreadId::new("thread_1").unwrap(),
                turn_id: TurnId::new("turn_1").unwrap(),
                command_id: CommandId::new("steer_1").unwrap(),
            },
        ),
    )
    .unwrap();
    assert_eq!(
        delivered
            .steer_deliveries
            .get(&CommandId::new("steer_1").unwrap()),
        Some(&7)
    );
}

#[test]
fn reducer_rejects_history_older_than_minimum_supported_schema() {
    let event = ThreadEvent::ThreadCreated {
        agent_id: Some(ash_protocol::AgentId::new("agent-test").unwrap()),
        origin: Default::default(),
        agent: None,
        session_id: ash_protocol::SessionId::new("session_1").unwrap(),
        thread_id: ThreadId::new("thread_1").unwrap(),
        title: "legacy".into(),
    };
    let mut legacy = envelope(1, event);
    legacy.schema_version = MINIMUM_SUPPORTED_EVENT_SCHEMA_VERSION.saturating_sub(1);

    let error = reduce_thread_event(None, &legacy).unwrap_err();
    assert!(matches!(error, CoreError::Journal(message) if message.contains("unsupported")));
}

#[test]
fn reducer_requires_an_ordered_fork_import_to_complete_before_other_facts() {
    let thread_id = ThreadId::new("thread_1").unwrap();
    let source_thread_id = ThreadId::new("source_thread").unwrap();
    let created = reduce_thread_event(
        None,
        &envelope(
            1,
            ThreadEvent::ThreadCreated {
                agent_id: Some(ash_protocol::AgentId::new("agent-test").unwrap()),
                origin: Default::default(),
                agent: None,
                session_id: ash_protocol::SessionId::new("session_1").unwrap(),
                thread_id: thread_id.clone(),
                title: "fork child".into(),
            },
        ),
    )
    .unwrap();
    let importing = reduce_thread_event(
        Some(created),
        &envelope(
            2,
            ThreadEvent::ForkTurnImported {
                thread_id: thread_id.clone(),
                source_thread_id: source_thread_id.clone(),
                source_sequence: 7,
                turn_index: 0,
                turn: Box::new(imported_turn("imported_turn", Vec::new())),
            },
        ),
    )
    .unwrap();

    let unrelated = ThreadEvent::ForkHistoryImported {
        thread_id: thread_id.clone(),
        source_thread_id: source_thread_id.clone(),
        source_sequence: 7,
        turns: Vec::new(),
    };
    let error = reduce_thread_event(Some(importing.clone()), &envelope(3, unrelated)).unwrap_err();
    assert!(matches!(error, CoreError::Journal(message) if message.contains("must complete")));

    let wrong_source = ThreadEvent::ForkTurnImported {
        thread_id: thread_id.clone(),
        source_thread_id: ThreadId::new("another_source").unwrap(),
        source_sequence: 7,
        turn_index: 1,
        turn: Box::new(imported_turn("another_turn", Vec::new())),
    };
    let error =
        reduce_thread_event(Some(importing.clone()), &envelope(3, wrong_source)).unwrap_err();
    assert!(matches!(error, CoreError::Journal(message) if message.contains("ordering changed")));

    let completed = reduce_thread_event(
        Some(importing),
        &envelope(
            3,
            ThreadEvent::ForkHistoryImportCompleted {
                thread_id,
                source_thread_id,
                source_sequence: 7,
                imported_turn_count: 1,
                context_checkpoint: None,
            },
        ),
    )
    .unwrap();
    assert_eq!(completed.turns.len(), 1);
    assert!(completed.fork_import.is_none());
}

#[test]
fn reducer_rejects_a_fork_import_with_an_incomplete_tool_exchange() {
    let thread_id = ThreadId::new("thread_1").unwrap();
    let source_thread_id = ThreadId::new("source_thread").unwrap();
    let created = reduce_thread_event(
        None,
        &envelope(
            1,
            ThreadEvent::ThreadCreated {
                agent_id: Some(ash_protocol::AgentId::new("agent-test").unwrap()),
                origin: Default::default(),
                agent: None,
                session_id: ash_protocol::SessionId::new("session_1").unwrap(),
                thread_id: thread_id.clone(),
                title: "fork child".into(),
            },
        ),
    )
    .unwrap();
    let turn_id = TurnId::new("imported_turn").unwrap();
    let importing = reduce_thread_event(
        Some(created),
        &envelope(
            2,
            ThreadEvent::ForkTurnImported {
                thread_id: thread_id.clone(),
                source_thread_id: source_thread_id.clone(),
                source_sequence: 7,
                turn_index: 0,
                turn: Box::new(imported_turn(
                    "imported_turn",
                    vec![ThreadItem::ToolCall {
                        item_id: ItemId::new("tool_call_item").unwrap(),
                        turn_id,
                        tool_call_id: ToolCallId::new("tool_call").unwrap(),
                        name: ToolName::new("shell-command").unwrap(),
                        arguments_json: "{}".into(),
                        binding: None,
                    }],
                )),
            },
        ),
    )
    .unwrap();

    let error = reduce_thread_event(
        Some(importing),
        &envelope(
            3,
            ThreadEvent::ForkHistoryImportCompleted {
                thread_id,
                source_thread_id,
                source_sequence: 7,
                imported_turn_count: 1,
                context_checkpoint: None,
            },
        ),
    )
    .unwrap_err();
    assert!(
        matches!(error, CoreError::Journal(message) if message.contains("incomplete Tool Call/Result"))
    );
}

#[test]
fn empty_fork_completion_preserves_the_source_thread_identity() {
    let thread_id = ThreadId::new("thread_1").unwrap();
    let source_thread_id = ThreadId::new("source_thread").unwrap();
    let created = reduce_thread_event(
        None,
        &envelope(
            1,
            ThreadEvent::ThreadCreated {
                agent_id: Some(ash_protocol::AgentId::new("agent-test").unwrap()),
                origin: Default::default(),
                agent: None,
                session_id: ash_protocol::SessionId::new("session_1").unwrap(),
                thread_id: thread_id.clone(),
                title: "empty fork child".into(),
            },
        ),
    )
    .unwrap();

    let completed = reduce_thread_event(
        Some(created),
        &envelope(
            2,
            ThreadEvent::ForkHistoryImportCompleted {
                thread_id,
                source_thread_id: source_thread_id.clone(),
                source_sequence: 1,
                imported_turn_count: 0,
                context_checkpoint: None,
            },
        ),
    )
    .unwrap();

    assert_eq!(completed.forked_from_id, Some(source_thread_id));
}

fn imported_turn(turn_id: &str, items: Vec<ThreadItem>) -> Turn {
    Turn {
        advisor: None,
        kind: ash_protocol::TurnKind::Coding,
        instructions: None,
        turn_id: TurnId::new(turn_id).unwrap(),
        status: TurnStatus::Interrupted,
        model: None,
        tool_profile: None,
        tool_mode: ash_protocol::ToolMode::Direct,
        approval_mode: ash_protocol::ApprovalMode::AskPermissions,
        usage: ash_protocol::ModelUsageSummary::default(),
        context_usage: None,
        items,
        plan: None,
        pending_interaction: None,
        error: None,
    }
}

#[test]
fn reducer_verifies_and_rebuilds_a_context_checkpoint() {
    let events = [
        envelope(
            1,
            ThreadEvent::ThreadCreated {
                agent_id: Some(ash_protocol::AgentId::new("agent-test").unwrap()),
                origin: Default::default(),
                agent: None,
                session_id: ash_protocol::SessionId::new("session_1").unwrap(),
                thread_id: ThreadId::new("thread_1").unwrap(),
                title: "test".into(),
            },
        ),
        envelope(
            2,
            ThreadEvent::TurnAccepted {
                advisor: None,
                kind: ash_protocol::TurnKind::Coding,
                instructions: None,
                thread_id: ThreadId::new("thread_1").unwrap(),
                turn_id: TurnId::new("turn_1").unwrap(),
                policy_revision: "test-policy-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                tool_mode: ash_protocol::ToolMode::Direct,
                activated_skills: Vec::new(),
                model: None,
                tool_profile: None,
            },
        ),
        envelope(
            3,
            ThreadEvent::ItemCompleted {
                checkpoint_after_sequence: None,
                workspace_checkpoint: None,
                thread_id: ThreadId::new("thread_1").unwrap(),
                turn_id: TurnId::new("turn_1").unwrap(),
                item: ThreadItem::UserMessage {
                    item_id: ItemId::new("item_1").unwrap(),
                    turn_id: TurnId::new("turn_1").unwrap(),
                    text: "hello".into(),
                },
            },
        ),
        envelope(
            4,
            ThreadEvent::TurnStarted {
                thread_id: ThreadId::new("thread_1").unwrap(),
                turn_id: TurnId::new("turn_1").unwrap(),
            },
        ),
        envelope(
            5,
            ThreadEvent::ItemCompleted {
                checkpoint_after_sequence: None,
                workspace_checkpoint: None,
                thread_id: ThreadId::new("thread_1").unwrap(),
                turn_id: TurnId::new("turn_1").unwrap(),
                item: ThreadItem::AgentMessage {
                    item_id: ItemId::new("item_2").unwrap(),
                    turn_id: TurnId::new("turn_1").unwrap(),
                    text: "answer".into(),
                },
            },
        ),
        envelope(
            6,
            ThreadEvent::TurnCompleted {
                thread_id: ThreadId::new("thread_1").unwrap(),
                turn_id: TurnId::new("turn_1").unwrap(),
            },
        ),
    ];
    let snapshot = events
        .iter()
        .try_fold(None, |snapshot, event| {
            reduce_thread_event(snapshot, event).map(Some)
        })
        .unwrap()
        .unwrap();
    let covered = ContextSourceRange {
        start_sequence: 1,
        end_sequence: snapshot.sequence,
    };
    let checkpoint = ContextCheckpoint {
        checkpoint_id: ContextCheckpointId::new("checkpoint_1").unwrap(),
        source_thread_id: snapshot.thread_id.clone(),
        covered,
        referenced_items: snapshot
            .items
            .iter()
            .map(|item| item.item_id().clone())
            .collect(),
        source_digest: snapshot
            .context_items_digest(
                covered,
                &snapshot
                    .items
                    .iter()
                    .map(|item| item.item_id().clone())
                    .collect::<Vec<_>>(),
            )
            .unwrap(),
        summary: "durable summary".into(),
        schema_revision: "context-checkpoint-v1".into(),
        prompt_revision: "compaction-v2".into(),
        context_policy_revision: "context-policy-v1".into(),
        generator_model: None,
        created_at_unix_ms: 7,
        verification: ContextCheckpointVerification::Verified,
    };

    let rebuilt = reduce_thread_event(
        Some(snapshot.clone()),
        &envelope(
            7,
            ThreadEvent::ContextCheckpointCommitted {
                thread_id: snapshot.thread_id.clone(),
                checkpoint: checkpoint.clone(),
            },
        ),
    )
    .unwrap();
    assert_eq!(rebuilt.context_checkpoints, vec![checkpoint.clone()]);

    let mut corrupt = checkpoint;
    corrupt.summary = "rewritten summary".into();
    corrupt.source_digest = ContextSourceDigest::new(format!("sha256:{}", "0".repeat(64))).unwrap();
    assert!(
        reduce_thread_event(
            Some(snapshot.clone()),
            &envelope(
                7,
                ThreadEvent::ContextCheckpointCommitted {
                    thread_id: snapshot.thread_id,
                    checkpoint: corrupt,
                },
            ),
        )
        .is_err()
    );
}

#[test]
fn reducer_rejects_sequence_gaps_and_illegal_transitions() {
    let thread = reduce_thread_event(
        None,
        &envelope(
            1,
            ThreadEvent::ThreadCreated {
                agent_id: Some(ash_protocol::AgentId::new("agent-test").unwrap()),
                origin: Default::default(),
                agent: None,
                session_id: ash_protocol::SessionId::new("session_1")
                    .expect("test ID is non-empty"),
                thread_id: ThreadId::new("thread_1").expect("test ID is non-empty"),
                title: "test".into(),
            },
        ),
    )
    .unwrap();
    assert!(
        reduce_thread_event(
            Some(thread.clone()),
            &envelope(
                3,
                ThreadEvent::TurnAccepted {
                    advisor: None,
                    kind: ash_protocol::TurnKind::Coding,
                    instructions: None,
                    thread_id: ThreadId::new("thread_1").expect("test ID is non-empty"),
                    turn_id: TurnId::new("turn_1").expect("test ID is non-empty"),
                    policy_revision: "test-policy-v1".into(),
                    approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                    tool_mode: ash_protocol::ToolMode::Direct,
                    activated_skills: Vec::new(),
                    model: None,
                    tool_profile: None,
                }
            )
        )
        .is_err()
    );

    let thread = reduce_thread_event(
        Some(thread),
        &envelope(
            2,
            ThreadEvent::TurnAccepted {
                advisor: None,
                kind: ash_protocol::TurnKind::Coding,
                instructions: None,
                thread_id: ThreadId::new("thread_1").expect("test ID is non-empty"),
                turn_id: TurnId::new("turn_1").expect("test ID is non-empty"),
                policy_revision: "test-policy-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                tool_mode: ash_protocol::ToolMode::Direct,
                activated_skills: Vec::new(),
                model: None,
                tool_profile: None,
            },
        ),
    )
    .unwrap();
    assert!(
        reduce_thread_event(
            Some(thread),
            &envelope(
                3,
                ThreadEvent::TurnCompleted {
                    thread_id: ThreadId::new("thread_1").expect("test ID is non-empty"),
                    turn_id: TurnId::new("turn_1").expect("test ID is non-empty")
                }
            )
        )
        .is_err()
    );
}

#[test]
fn reducer_rebuilds_typed_command_receipt_and_all_durable_item_kinds() {
    let mut accepted = envelope(
        2,
        ThreadEvent::TurnAccepted {
            advisor: None,
            kind: ash_protocol::TurnKind::Coding,
            instructions: None,
            thread_id: ThreadId::new("thread_1").expect("test ID is non-empty"),
            turn_id: TurnId::new("turn_1").expect("test ID is non-empty"),
            policy_revision: "test-policy-v1".into(),
            approval_mode: ash_protocol::ApprovalMode::AskPermissions,
            tool_mode: ash_protocol::ToolMode::Direct,
            activated_skills: Vec::new(),
            model: None,
            tool_profile: None,
        },
    );
    accepted.command = Some(ThreadCommandReceipt {
        command_id: CommandId::new("command_1").expect("test ID is non-empty"),
        command: ThreadCommand::StartTurn {
            advisor: None,
            kind: ash_protocol::TurnKind::Coding,
            instructions: None,
            model: None,
            activated_skills: Vec::new(),
            host_activated_skills: Some(Vec::new()),
            approval_mode: ash_protocol::ApprovalMode::AskPermissions,
            tool_mode: ash_protocol::ToolMode::Direct,
            tool_profile: None,
            input: vec![UserInput::Text {
                text: "hello".into(),
            }],
        },
    });
    let events = [
        envelope(
            1,
            ThreadEvent::ThreadCreated {
                agent_id: Some(ash_protocol::AgentId::new("agent-test").unwrap()),
                origin: Default::default(),
                agent: None,
                session_id: ash_protocol::SessionId::new("session_1")
                    .expect("test ID is non-empty"),
                thread_id: ThreadId::new("thread_1").expect("test ID is non-empty"),
                title: "test".into(),
            },
        ),
        accepted,
        envelope(
            3,
            ThreadEvent::ItemCompleted {
                checkpoint_after_sequence: None,
                workspace_checkpoint: None,
                thread_id: ThreadId::new("thread_1").expect("test ID is non-empty"),
                turn_id: TurnId::new("turn_1").expect("test ID is non-empty"),
                item: ThreadItem::UserMessage {
                    item_id: ItemId::new("item_1").expect("test ID is non-empty"),
                    turn_id: TurnId::new("turn_1").expect("test ID is non-empty"),
                    text: "hello".into(),
                },
            },
        ),
        envelope(
            4,
            ThreadEvent::TurnStarted {
                thread_id: ThreadId::new("thread_1").expect("test ID is non-empty"),
                turn_id: TurnId::new("turn_1").expect("test ID is non-empty"),
            },
        ),
        envelope(
            5,
            ThreadEvent::ItemCompleted {
                checkpoint_after_sequence: None,
                workspace_checkpoint: None,
                thread_id: ThreadId::new("thread_1").expect("test ID is non-empty"),
                turn_id: TurnId::new("turn_1").expect("test ID is non-empty"),
                item: ThreadItem::ToolCall {
                    item_id: ItemId::new("item_2").expect("test ID is non-empty"),
                    turn_id: TurnId::new("turn_1").expect("test ID is non-empty"),
                    tool_call_id: ToolCallId::new("tool_1").expect("test ID is non-empty"),
                    name: ToolName::new("search").expect("test tool name is valid"),
                    arguments_json: r#"{"query":"ash"}"#.into(),
                    binding: None,
                },
            },
        ),
        envelope(
            6,
            ThreadEvent::ItemCompleted {
                checkpoint_after_sequence: None,
                workspace_checkpoint: None,
                thread_id: ThreadId::new("thread_1").expect("test ID is non-empty"),
                turn_id: TurnId::new("turn_1").expect("test ID is non-empty"),
                item: ThreadItem::ToolResult {
                    item_id: ItemId::new("item_3").expect("test ID is non-empty"),
                    turn_id: TurnId::new("turn_1").expect("test ID is non-empty"),
                    tool_call_id: ToolCallId::new("tool_1").expect("test ID is non-empty"),
                    text: "result".into(),
                    content: None,
                    is_error: false,
                },
            },
        ),
        envelope(
            7,
            ThreadEvent::ItemCompleted {
                checkpoint_after_sequence: None,
                workspace_checkpoint: None,
                thread_id: ThreadId::new("thread_1").expect("test ID is non-empty"),
                turn_id: TurnId::new("turn_1").expect("test ID is non-empty"),
                item: ThreadItem::AgentMessage {
                    item_id: ItemId::new("item_4").expect("test ID is non-empty"),
                    turn_id: TurnId::new("turn_1").expect("test ID is non-empty"),
                    text: "answer".into(),
                },
            },
        ),
        envelope(
            8,
            ThreadEvent::TurnCompleted {
                thread_id: ThreadId::new("thread_1").expect("test ID is non-empty"),
                turn_id: TurnId::new("turn_1").expect("test ID is non-empty"),
            },
        ),
    ];
    let snapshot = events
        .iter()
        .try_fold(None, |snapshot, event| {
            reduce_thread_event(snapshot, event).map(Some)
        })
        .unwrap()
        .unwrap();

    assert_eq!(snapshot.items.len(), 4);
    assert_eq!(snapshot.commands.len(), 1);
    assert_eq!(snapshot.commands[0].response_sequence, 4);
    assert!(matches!(
        &snapshot.commands[0].result,
        ThreadCommandResult::TurnAccepted { turn_id }
            if turn_id == &TurnId::new("turn_1").expect("test ID is non-empty")
    ));
    assert_eq!(snapshot.turns[0].status, TurnStatus::Completed);
}

#[test]
fn reducer_rejects_a_tool_result_without_its_tool_call() {
    let thread = reduce_thread_event(
        None,
        &envelope(
            1,
            ThreadEvent::ThreadCreated {
                agent_id: Some(ash_protocol::AgentId::new("agent-test").unwrap()),
                origin: Default::default(),
                agent: None,
                session_id: ash_protocol::SessionId::new("session_1")
                    .expect("test ID is non-empty"),
                thread_id: ThreadId::new("thread_1").expect("test ID is non-empty"),
                title: "test".into(),
            },
        ),
    )
    .unwrap();
    let thread = reduce_thread_event(
        Some(thread),
        &envelope(
            2,
            ThreadEvent::TurnAccepted {
                advisor: None,
                kind: ash_protocol::TurnKind::Coding,
                instructions: None,
                thread_id: ThreadId::new("thread_1").expect("test ID is non-empty"),
                turn_id: TurnId::new("turn_1").expect("test ID is non-empty"),
                policy_revision: "test-policy-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                tool_mode: ash_protocol::ToolMode::Direct,
                activated_skills: Vec::new(),
                model: None,
                tool_profile: None,
            },
        ),
    )
    .unwrap();

    assert!(
        reduce_thread_event(
            Some(thread),
            &envelope(
                3,
                ThreadEvent::ItemCompleted {
                    checkpoint_after_sequence: None,
                    workspace_checkpoint: None,
                    thread_id: ThreadId::new("thread_1").expect("test ID is non-empty"),
                    turn_id: TurnId::new("turn_1").expect("test ID is non-empty"),
                    item: ThreadItem::ToolResult {
                        item_id: ItemId::new("item_1").expect("test ID is non-empty"),
                        turn_id: TurnId::new("turn_1").expect("test ID is non-empty"),
                        tool_call_id: ToolCallId::new("missing").expect("test ID is non-empty"),
                        text: "result".into(),
                        content: None,
                        is_error: false,
                    },
                },
            ),
        )
        .is_err()
    );
}

#[test]
fn reducer_rejects_unsafe_or_rebound_tool_escalation() {
    let thread = started_sandboxed_tool_snapshot();
    let denial_output = ash_protocol::ProcessExecutionOutput::from_captured_streams(
        ash_protocol::ProcessExitStatus::Code(1),
        "",
        "operation not permitted",
    );
    let unsafe_escalation = ThreadEvent::ToolExecutionEscalated {
        thread_id: ThreadId::new("thread_1").unwrap(),
        turn_id: TurnId::new("turn_1").unwrap(),
        tool_call_id: ToolCallId::new("tool_1").unwrap(),
        action_digest: "action-1".into(),
        policy_revision: "policy-1".into(),
        denial: ash_protocol::SandboxDenialOutput::may_have_side_effects(
            "write denied after process start",
            denial_output.clone(),
        ),
        authority: ash_protocol::ToolExecutionAuthority::AutoReviewed {
            assessment_id: "assessment-1".into(),
        },
    };
    assert!(reduce_thread_event(Some(thread.clone()), &envelope(6, unsafe_escalation)).is_err());

    let rebound_escalation = ThreadEvent::ToolExecutionEscalated {
        thread_id: ThreadId::new("thread_1").unwrap(),
        turn_id: TurnId::new("turn_1").unwrap(),
        tool_call_id: ToolCallId::new("tool_1").unwrap(),
        action_digest: "another-action".into(),
        policy_revision: "policy-1".into(),
        denial: ash_protocol::SandboxDenialOutput::safe_to_retry(
            "sandbox setup failed",
            denial_output,
        ),
        authority: ash_protocol::ToolExecutionAuthority::AutoReviewed {
            assessment_id: "assessment-1".into(),
        },
    };
    assert!(reduce_thread_event(Some(thread.clone()), &envelope(6, rebound_escalation)).is_err());

    let unbound_approval_escalation = ThreadEvent::ToolExecutionEscalated {
        thread_id: ThreadId::new("thread_1").unwrap(),
        turn_id: TurnId::new("turn_1").unwrap(),
        tool_call_id: ToolCallId::new("tool_1").unwrap(),
        action_digest: "action-1".into(),
        policy_revision: "policy-1".into(),
        denial: ash_protocol::SandboxDenialOutput::safe_to_retry(
            "sandbox setup failed",
            ash_protocol::ProcessExecutionOutput::from_captured_streams(
                ash_protocol::ProcessExitStatus::Code(1),
                "",
                "operation not permitted",
            ),
        ),
        authority: ash_protocol::ToolExecutionAuthority::ApprovedOnce {
            request_id: ash_protocol::RequestId::new("missing-approval").unwrap(),
        },
    };
    assert!(reduce_thread_event(Some(thread), &envelope(6, unbound_approval_escalation)).is_err());
}

fn started_sandboxed_tool_snapshot() -> ThreadSnapshot {
    let events = [
        envelope(
            1,
            ThreadEvent::ThreadCreated {
                agent_id: Some(ash_protocol::AgentId::new("agent-test").unwrap()),
                origin: Default::default(),
                agent: None,
                session_id: ash_protocol::SessionId::new("session_1").unwrap(),
                thread_id: ThreadId::new("thread_1").unwrap(),
                title: "test".into(),
            },
        ),
        envelope(
            2,
            ThreadEvent::TurnAccepted {
                advisor: None,
                kind: ash_protocol::TurnKind::Coding,
                instructions: None,
                thread_id: ThreadId::new("thread_1").unwrap(),
                turn_id: TurnId::new("turn_1").unwrap(),
                policy_revision: "test-policy-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                tool_mode: ash_protocol::ToolMode::Direct,
                activated_skills: Vec::new(),
                model: None,
                tool_profile: None,
            },
        ),
        envelope(
            3,
            ThreadEvent::TurnStarted {
                thread_id: ThreadId::new("thread_1").unwrap(),
                turn_id: TurnId::new("turn_1").unwrap(),
            },
        ),
        envelope(
            4,
            ThreadEvent::ItemCompleted {
                checkpoint_after_sequence: None,
                workspace_checkpoint: None,
                thread_id: ThreadId::new("thread_1").unwrap(),
                turn_id: TurnId::new("turn_1").unwrap(),
                item: ThreadItem::ToolCall {
                    item_id: ItemId::new("item_1").unwrap(),
                    turn_id: TurnId::new("turn_1").unwrap(),
                    tool_call_id: ToolCallId::new("tool_1").unwrap(),
                    name: ToolName::new("shell-command").unwrap(),
                    arguments_json: "{}".into(),
                    binding: None,
                },
            },
        ),
        envelope(
            5,
            ThreadEvent::ToolExecutionStarted {
                thread_id: ThreadId::new("thread_1").unwrap(),
                turn_id: TurnId::new("turn_1").unwrap(),
                tool_call_id: ToolCallId::new("tool_1").unwrap(),
                action_digest: "action-1".into(),
                policy_revision: "policy-1".into(),
                authority: ash_protocol::ToolExecutionAuthority::Sandboxed,
            },
        ),
    ];
    events
        .iter()
        .try_fold(None, |snapshot, event| {
            reduce_thread_event(snapshot, event).map(Some)
        })
        .unwrap()
        .unwrap()
}
