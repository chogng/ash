use super::*;
use ash_protocol::ItemDelta;

#[test]
fn phase_metadata_updates_the_same_transient_message_without_replacing_text() {
    let mut accumulator = TranscriptAccumulator::new(session_id(), thread_id());
    apply(
        &mut accumulator,
        transient(
            1,
            ThreadUpdate::ItemDelta {
                turn_id: turn_id(),
                item_id: item_id("item-1"),
                delta: ItemDelta::AgentMessage {
                    text: "working".into(),
                },
            },
        ),
    );
    let updated = apply(
        &mut accumulator,
        transient(
            2,
            ThreadUpdate::ItemDelta {
                turn_id: turn_id(),
                item_id: item_id("item-1"),
                delta: ItemDelta::AgentMessagePhase {
                    phase: Some(ash_protocol::MessagePhase::Commentary),
                },
            },
        ),
    );
    let TranscriptApplyResult::Applied(update) = updated else {
        panic!("phase update must reach clients");
    };
    assert!(
        matches!(&update.changes[0], ThreadTranscriptChange::Upsert {
        entry: ThreadTranscriptEntry::Item { entry_id, item: ThreadItem::AgentMessage { text, phase: Some(ash_protocol::MessagePhase::Commentary), .. }, transient: true, .. }
    } if entry_id == "item:item-1" && text == "working")
    );
}
use ash_protocol::ItemId;
use ash_protocol::ModelUsageSummary;
use ash_protocol::SessionId;
use ash_protocol::StreamCursor;
use ash_protocol::StreamInstanceId;
use ash_protocol::Thread;
use ash_protocol::ThreadEvent;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::ThreadStatus;
use ash_protocol::ThreadUpdate;
use ash_protocol::ThreadUpdateEnvelope;
use ash_protocol::ToolCallId;
use ash_protocol::ToolOutputStream;
use ash_protocol::TurnId;

#[test]
fn snapshot_preserves_items_and_turn_plans_in_order() {
    let snapshot = ThreadTranscriptSnapshot::from_thread(&Thread {
        advisor: Default::default(),
        agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
        origin: Default::default(),
        session_id: session_id(),
        thread_id: thread_id(),
        parent_thread_id: None,
        forked_from_id: None,
        title: "Thread".into(),
        status: ThreadStatus::Active,
        sequence: 7,
        usage: ModelUsageSummary::default(),
        reference_cost: ash_protocol::ModelReferenceCostSummary::default(),
        goal: None,
        hook_runs: Vec::new(),
        turns: vec![ash_protocol::Turn {
            mode: ash_protocol::CollaborationMode::Agent,
            advisor: None,
            turn_id: turn_id(),
            status: ash_protocol::TurnStatus::Completed,
            kind: ash_protocol::TurnKind::Coding,
            instructions: None,
            model: None,
            reasoning_effort: None,
            tool_profile: None,
            tool_mode: ash_protocol::ToolMode::Direct,
            approval_mode: ash_protocol::ApprovalMode::Manual,
            usage: ModelUsageSummary::default(),
            context_usage: None,
            items: vec![agent_item("item-1", "done")],
            plan: Some(ash_protocol::PlanUpdate {
                explanation: Some("why".into()),
                steps: Vec::new(),
            }),
            pending_interaction: None,
            error: None,
        }],
    });

    assert_eq!(snapshot.durable_sequence, 7);
    assert_eq!(snapshot.entries.len(), 2);
    assert_eq!(snapshot.entries[0].entry_id(), "item:item-1");
    assert_eq!(snapshot.entries[1].entry_id(), "turn-plan:turn-1");
}

#[test]
fn deltas_emit_complete_upserts_and_committed_item_replaces_transient() {
    let mut accumulator = TranscriptAccumulator::new(session_id(), thread_id());
    let first = apply(
        &mut accumulator,
        transient(
            1,
            ThreadUpdate::ItemDelta {
                turn_id: turn_id(),
                item_id: item_id("item-1"),
                delta: ItemDelta::AgentMessage { text: "hel".into() },
            },
        ),
    );
    let second = apply(
        &mut accumulator,
        transient(
            2,
            ThreadUpdate::ItemDelta {
                turn_id: turn_id(),
                item_id: item_id("item-1"),
                delta: ItemDelta::AgentMessage { text: "lo".into() },
            },
        ),
    );
    let committed = apply(
        &mut accumulator,
        durable(
            1,
            ThreadEvent::ItemCompleted {
                checkpoint_after_sequence: None,
                workspace_checkpoint: None,
                thread_id: thread_id(),
                turn_id: turn_id(),
                item: agent_item("item-1", "hello"),
            },
        ),
    );

    assert_eq!(entry_text(&first), "hel");
    assert_eq!(entry_text(&second), "hello");
    assert_eq!(entry_text(&committed), "hello");
    assert_eq!(revision(&first), 1);
    assert_eq!(revision(&second), 2);
    assert_eq!(revision(&committed), 3);
    let TranscriptApplyResult::Applied(committed) = committed else {
        unreachable!()
    };
    assert!(matches!(
        &committed.changes[0],
        ThreadTranscriptChange::Upsert {
            entry: ThreadTranscriptEntry::Item {
                transient: false,
                ..
            }
        }
    ));
}

#[test]
fn policy_interruption_publishes_its_reason_while_cancellation_only_clears_transients() {
    for policy_stop in [false, true] {
        let mut accumulator = TranscriptAccumulator::new(session_id(), thread_id());
        apply(
            &mut accumulator,
            transient(
                1,
                ThreadUpdate::ItemDelta {
                    turn_id: turn_id(),
                    item_id: item_id("in-progress"),
                    delta: ItemDelta::AgentMessage {
                        text: "still working".into(),
                    },
                },
            ),
        );
        let error = policy_stop.then(|| {
            ash_protocol::StableTurnError::policy_circuit_breaker("three actions rejected".into())
        });
        let update = apply(
            &mut accumulator,
            durable(
                1,
                ThreadEvent::TurnInterrupted {
                    thread_id: thread_id(),
                    turn_id: turn_id(),
                    error: error.clone(),
                },
            ),
        );
        let TranscriptApplyResult::Applied(update) = update else {
            panic!("terminal event must update transcript")
        };
        let mut expected = vec![ThreadTranscriptChange::Remove {
            entry_ids: vec!["item:in-progress".into()],
        }];
        if let Some(error) = error {
            expected.push(ThreadTranscriptChange::Upsert {
                entry: ThreadTranscriptEntry::TurnError {
                    entry_id: "turn-error:turn-1".into(),
                    turn_id: turn_id(),
                    error,
                },
            });
        }
        assert_eq!(update.changes, expected);
    }
}

#[test]
fn scope_mismatch_and_duplicate_cursor_are_ignored() {
    let mut accumulator = TranscriptAccumulator::new(session_id(), thread_id());
    let wrong = ThreadUpdateEnvelope {
        session_id: SessionId::new("other").unwrap(),
        ..transient(
            1,
            ThreadUpdate::ItemDelta {
                turn_id: turn_id(),
                item_id: item_id("item-1"),
                delta: ItemDelta::Reasoning { text: "x".into() },
            },
        )
    };
    assert_eq!(accumulator.apply(&wrong), TranscriptApplyResult::Ignored);

    let update = transient(
        1,
        ThreadUpdate::ItemDelta {
            turn_id: turn_id(),
            item_id: item_id("item-1"),
            delta: ItemDelta::Reasoning { text: "x".into() },
        },
    );
    assert!(matches!(
        accumulator.apply(&update),
        TranscriptApplyResult::Applied(_)
    ));
    assert_eq!(accumulator.apply(&update), TranscriptApplyResult::Ignored);
}

#[test]
fn stream_gap_clears_transient_entries_instead_of_emitting_partial_text() {
    let mut accumulator = TranscriptAccumulator::new(session_id(), thread_id());
    apply(
        &mut accumulator,
        transient(
            1,
            ThreadUpdate::ItemDelta {
                turn_id: turn_id(),
                item_id: item_id("item-1"),
                delta: ItemDelta::AgentMessage {
                    text: "first".into(),
                },
            },
        ),
    );
    let result = apply(
        &mut accumulator,
        transient(
            3,
            ThreadUpdate::ItemDelta {
                turn_id: turn_id(),
                item_id: item_id("item-1"),
                delta: ItemDelta::AgentMessage {
                    text: "missing".into(),
                },
            },
        ),
    );
    let TranscriptApplyResult::Applied(update) = result else {
        unreachable!()
    };
    assert_eq!(update.changes, vec![ThreadTranscriptChange::ClearTransient]);

    assert_eq!(
        accumulator.apply(&transient(
            4,
            ThreadUpdate::ItemDelta {
                turn_id: turn_id(),
                item_id: item_id("item-1"),
                delta: ItemDelta::AgentMessage {
                    text: "still partial".into(),
                },
            },
        )),
        TranscriptApplyResult::Ignored
    );
    assert!(matches!(
        accumulator.apply(&transient_for_stream(
            "stream-2",
            1,
            ThreadUpdate::ItemDelta {
                turn_id: turn_id(),
                item_id: item_id("item-2"),
                delta: ItemDelta::AgentMessage {
                    text: "complete again".into(),
                },
            },
        )),
        TranscriptApplyResult::Applied(_)
    ));
}

#[test]
fn stdout_and_stderr_stay_independent_until_tool_result_commits() {
    let mut accumulator = TranscriptAccumulator::new(session_id(), thread_id());
    let tool_call_id = ToolCallId::new("call-1").unwrap();
    let stdout = apply(
        &mut accumulator,
        transient(
            1,
            ThreadUpdate::ToolOutputDelta {
                turn_id: turn_id(),
                tool_call_id: tool_call_id.clone(),
                stream: ToolOutputStream::Stdout,
                text: "out".into(),
            },
        ),
    );
    let stderr = apply(
        &mut accumulator,
        transient(
            2,
            ThreadUpdate::ToolOutputDelta {
                turn_id: turn_id(),
                tool_call_id: tool_call_id.clone(),
                stream: ToolOutputStream::Stderr,
                text: "err".into(),
            },
        ),
    );

    let TranscriptApplyResult::Applied(stdout) = stdout else {
        unreachable!()
    };
    let TranscriptApplyResult::Applied(stderr) = stderr else {
        unreachable!()
    };
    assert!(matches!(
        &stdout.changes[0],
        ThreadTranscriptChange::Upsert {
            entry: ThreadTranscriptEntry::ToolOutput {
                stream: ToolOutputStream::Stdout,
                text,
                ..
            }
        } if text == "out"
    ));
    assert!(matches!(
        &stderr.changes[0],
        ThreadTranscriptChange::Upsert {
            entry: ThreadTranscriptEntry::ToolOutput {
                stream: ToolOutputStream::Stderr,
                text,
                ..
            }
        } if text == "err"
    ));

    let committed = apply(
        &mut accumulator,
        durable(
            1,
            ThreadEvent::ItemCompleted {
                checkpoint_after_sequence: None,
                workspace_checkpoint: None,
                thread_id: thread_id(),
                turn_id: turn_id(),
                item: ThreadItem::ToolResult {
                    item_id: item_id("result-1"),
                    turn_id: turn_id(),
                    tool_call_id,
                    text: "done".into(),
                    content: None,
                    is_error: false,
                },
            },
        ),
    );
    let TranscriptApplyResult::Applied(committed) = committed else {
        unreachable!()
    };
    assert!(matches!(
        &committed.changes[0],
        ThreadTranscriptChange::Remove { entry_ids } if entry_ids.len() == 2
    ));
    assert!(matches!(
        &committed.changes[1],
        ThreadTranscriptChange::Upsert {
            entry: ThreadTranscriptEntry::Item {
                transient: false,
                ..
            }
        }
    ));
}

#[test]
fn snapshot_includes_current_transient_entries_for_late_consumers() {
    let mut accumulator = TranscriptAccumulator::new(session_id(), thread_id());
    apply(
        &mut accumulator,
        transient(
            1,
            ThreadUpdate::ItemDelta {
                turn_id: turn_id(),
                item_id: item_id("item-live"),
                delta: ItemDelta::AgentMessage {
                    text: "in progress".into(),
                },
            },
        ),
    );
    let snapshot = accumulator
        .snapshot(&thread_with_turn(
            turn_id(),
            ash_protocol::TurnStatus::Running,
        ))
        .expect("matching Thread scope");

    assert_eq!(snapshot.revision, 1);

    assert!(matches!(
        &snapshot.entries[0],
        ThreadTranscriptEntry::Item {
            item: ThreadItem::AgentMessage { text, .. },
            transient: true,
            ..
        } if text == "in progress"
    ));
}

#[test]
fn snapshot_transients_follow_visible_live_turns() {
    use ash_protocol::TurnStatus;
    for status in [
        TurnStatus::Created,
        TurnStatus::Running,
        TurnStatus::WaitingForApproval,
        TurnStatus::WaitingForUserInput,
        TurnStatus::WaitingForCapability,
        TurnStatus::Cancelling,
        TurnStatus::Completed,
        TurnStatus::Failed,
        TurnStatus::Interrupted,
    ] {
        let mut accumulator = TranscriptAccumulator::new(session_id(), thread_id());
        let visible_turn_id = TurnId::new("visible-turn").unwrap();
        for (sequence, id) in [(1, turn_id()), (2, visible_turn_id.clone())] {
            apply(
                &mut accumulator,
                transient(
                    sequence,
                    ThreadUpdate::ItemDelta {
                        turn_id: id,
                        item_id: item_id(&format!("item-{sequence}")),
                        delta: ItemDelta::AgentMessage {
                            text: "streaming".into(),
                        },
                    },
                ),
            );
        }
        let page = thread_with_turn(visible_turn_id.clone(), status);
        let snapshot = accumulator.snapshot(&page).unwrap();
        let terminal = matches!(
            status,
            TurnStatus::Completed | TurnStatus::Failed | TurnStatus::Interrupted
        );
        assert_eq!(snapshot.entries.len(), usize::from(!terminal), "{status:?}");
        assert!(
            snapshot
                .entries
                .iter()
                .all(|entry| entry.turn_id() == Some(&visible_turn_id))
        );
        assert!(
            accumulator
                .snapshot(&empty_thread())
                .unwrap()
                .entries
                .is_empty()
        );
    }
}

#[test]
fn snapshot_excludes_items_and_tool_output_already_committed_in_durable_state() {
    let mut accumulator = TranscriptAccumulator::new(session_id(), thread_id());
    let call_id = ToolCallId::new("completed-call").unwrap();
    let pending_call_id = ToolCallId::new("pending-call").unwrap();
    for (sequence, update) in [
        (
            1,
            ThreadUpdate::ItemDelta {
                turn_id: turn_id(),
                item_id: item_id("message"),
                delta: ItemDelta::AgentMessage {
                    text: "partial".into(),
                },
            },
        ),
        (
            2,
            ThreadUpdate::ItemDelta {
                turn_id: turn_id(),
                item_id: item_id("reasoning"),
                delta: ItemDelta::Reasoning {
                    text: "stale reasoning".into(),
                },
            },
        ),
        (
            3,
            ThreadUpdate::ToolOutputDelta {
                turn_id: turn_id(),
                tool_call_id: call_id.clone(),
                stream: ToolOutputStream::Stdout,
                text: "partial tool output".into(),
            },
        ),
        (
            4,
            ThreadUpdate::ToolOutputDelta {
                turn_id: turn_id(),
                tool_call_id: pending_call_id.clone(),
                stream: ToolOutputStream::Stderr,
                text: "live tool output".into(),
            },
        ),
    ] {
        apply(&mut accumulator, transient(sequence, update));
    }
    let mut thread = thread_with_turn(turn_id(), ash_protocol::TurnStatus::Running);
    thread.sequence = 10;
    thread.turns[0].items = vec![
        agent_item("message", "final"),
        ThreadItem::Reasoning {
            item_id: item_id("reasoning"),
            turn_id: turn_id(),
            text: String::new(),
            state: Vec::new(),
        },
        ThreadItem::ToolResult {
            item_id: item_id("result"),
            turn_id: turn_id(),
            tool_call_id: call_id,
            text: "final tool output".into(),
            content: None,
            is_error: false,
        },
    ];
    // The canonical snapshot has advanced before the accumulator receives the completion events.
    let snapshot = accumulator.snapshot(&thread).unwrap();
    assert_eq!(snapshot.entries.len(), 3);
    assert!(matches!(&snapshot.entries[0], ThreadTranscriptEntry::Item {
        item: ThreadItem::AgentMessage { text, .. }, transient: false, ..
    } if text == "final"));
    assert!(
        matches!(&snapshot.entries[2], ThreadTranscriptEntry::ToolOutput {
        tool_call_id, text, ..
    } if tool_call_id == &pending_call_id && text == "live tool output")
    );
}

fn thread_with_turn(id: TurnId, status: ash_protocol::TurnStatus) -> Thread {
    let mut thread = empty_thread();
    thread.turns.push(ash_protocol::Turn {
        turn_id: id,
        status,
        mode: ash_protocol::CollaborationMode::Agent,
        advisor: None,
        kind: ash_protocol::TurnKind::Coding,
        instructions: None,
        model: None,
        reasoning_effort: None,
        tool_profile: None,
        tool_mode: ash_protocol::ToolMode::Direct,
        approval_mode: ash_protocol::ApprovalMode::Manual,
        usage: ModelUsageSummary::default(),
        context_usage: None,
        items: Vec::new(),
        plan: None,
        pending_interaction: None,
        error: None,
    });
    thread
}

fn apply(
    accumulator: &mut TranscriptAccumulator,
    update: ThreadUpdateEnvelope,
) -> TranscriptApplyResult {
    accumulator.apply(&update)
}

fn entry_text(result: &TranscriptApplyResult) -> &str {
    let TranscriptApplyResult::Applied(update) = result else {
        panic!("update applied")
    };
    let ThreadTranscriptChange::Upsert {
        entry: ThreadTranscriptEntry::Item { item, .. },
    } = &update.changes[0]
    else {
        panic!("item upsert")
    };
    match item {
        ThreadItem::AgentMessage { text, .. } => text,
        _ => panic!("agent item"),
    }
}

fn revision(result: &TranscriptApplyResult) -> u64 {
    let TranscriptApplyResult::Applied(update) = result else {
        panic!("update applied")
    };
    update.revision
}

fn transient(sequence: u64, update: ThreadUpdate) -> ThreadUpdateEnvelope {
    transient_for_stream("stream-1", sequence, update)
}

fn transient_for_stream(
    stream_id: &str,
    sequence: u64,
    update: ThreadUpdate,
) -> ThreadUpdateEnvelope {
    ThreadUpdateEnvelope {
        session_id: session_id(),
        thread_id: thread_id(),
        durable_sequence: 0,
        stream_cursor: Some(StreamCursor {
            stream_instance_id: StreamInstanceId::new(stream_id).unwrap(),
            sequence,
        }),
        update,
    }
}

fn durable(sequence: u64, event: ThreadEvent) -> ThreadUpdateEnvelope {
    ThreadUpdateEnvelope {
        session_id: session_id(),
        thread_id: thread_id(),
        durable_sequence: sequence,
        stream_cursor: None,
        update: ThreadUpdate::Committed { event },
    }
}

fn agent_item(item: &str, text: &str) -> ThreadItem {
    ThreadItem::AgentMessage {
        phase: None,
        item_id: item_id(item),
        turn_id: turn_id(),
        text: text.into(),
    }
}

fn empty_thread() -> Thread {
    Thread {
        advisor: Default::default(),
        agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
        origin: Default::default(),
        session_id: session_id(),
        thread_id: thread_id(),
        parent_thread_id: None,
        forked_from_id: None,
        title: "Thread".into(),
        status: ThreadStatus::Active,
        sequence: 0,
        usage: ModelUsageSummary::default(),
        reference_cost: ash_protocol::ModelReferenceCostSummary::default(),
        goal: None,
        hook_runs: Vec::new(),
        turns: Vec::new(),
    }
}

fn session_id() -> SessionId {
    SessionId::new("session-1").unwrap()
}

fn thread_id() -> ThreadId {
    ThreadId::new("thread-1").unwrap()
}

fn turn_id() -> TurnId {
    TurnId::new("turn-1").unwrap()
}

fn item_id(value: &str) -> ItemId {
    ItemId::new(value).unwrap()
}

#[test]
fn encrypted_reasoning_without_a_summary_has_no_visible_transcript_entry() {
    let item = ThreadItem::Reasoning {
        item_id: item_id("r1"),
        turn_id: turn_id(),
        text: String::new(),
        state: vec![ash_protocol::ReasoningState {
            token_estimate: None,
            context: None,
            scope: "scope".into(),
            item: serde_json::json!({"type":"reasoning","encrypted_content":"opaque"}),
        }],
    };
    let mut accumulator = TranscriptAccumulator::new(session_id(), thread_id());
    let result = apply(
        &mut accumulator,
        durable(
            1,
            ThreadEvent::ItemCompleted {
                item,
                checkpoint_after_sequence: None,
                workspace_checkpoint: None,
                thread_id: thread_id(),
                turn_id: turn_id(),
            },
        ),
    );
    let TranscriptApplyResult::Applied(update) = result else {
        panic!("committed update")
    };
    assert_eq!(
        update.changes,
        vec![ThreadTranscriptChange::Remove {
            entry_ids: vec!["item:r1".into()]
        }]
    );
}

#[test]
fn hook_completion_replaces_its_running_transcript_entry_and_replays_stably() {
    let mut accumulator = TranscriptAccumulator::new(session_id(), thread_id());
    let mut run = ash_protocol::HookRunRecord {
        run_id: "run".into(),
        hook_id: "user:hook:test".into(),
        event: ash_protocol::HookEvent::PreToolUse,
        status: ash_protocol::HookRunStatus::Running,
        started_at_unix_ms: 1,
        duration_ms: 0,
        turn_id: Some(turn_id()),
        tool_call_id: Some(ToolCallId::new("tool").unwrap()),
        tool_name: Some("shell-command".into()),
    };
    let update = |sequence, run| ThreadUpdateEnvelope {
        session_id: session_id(),
        thread_id: thread_id(),
        durable_sequence: sequence,
        stream_cursor: None,
        update: ThreadUpdate::Committed {
            event: ThreadEvent::HookRunUpdated {
                thread_id: thread_id(),
                run,
            },
        },
    };
    apply(&mut accumulator, update(1, run.clone()));
    run.status = ash_protocol::HookRunStatus::Denied {
        reason: "blocked".into(),
    };
    run.duration_ms = 7;
    let TranscriptApplyResult::Applied(completed) = apply(&mut accumulator, update(2, run.clone()))
    else {
        panic!("completion must update transcript");
    };
    assert_eq!(
        completed.changes,
        vec![ThreadTranscriptChange::Upsert {
            entry: ThreadTranscriptEntry::HookRun {
                entry_id: "hook:run".into(),
                turn_id: turn_id(),
                run: run.clone()
            }
        }]
    );
    let mut thread = empty_thread();
    thread.sequence = 2;
    thread.turns.push(serde_json::from_value(serde_json::json!({"turnId":"turn-1", "status":"completed", "mode":"agent", "kind":"coding", "toolMode":"direct", "approvalMode":"manual", "usage":ModelUsageSummary::default(), "items":[]})).unwrap());
    thread.hook_runs.push(run);
    assert_eq!(
        ThreadTranscriptSnapshot::from_thread(&thread).entries,
        vec![match completed.changes[0].clone() {
            ThreadTranscriptChange::Upsert { entry } => entry,
            _ => unreachable!(),
        }]
    );
}

#[test]
fn voice_transcripts_have_no_execution_owner_and_keep_their_original_snapshot_anchor() {
    let committed = |durable_sequence, event| ThreadUpdateEnvelope {
        session_id: session_id(),
        thread_id: thread_id(),
        durable_sequence,
        stream_cursor: None,
        update: ThreadUpdate::Committed { event },
    };
    let mut accumulator = TranscriptAccumulator::new(session_id(), thread_id());
    let transcript = ash_protocol::VoiceTranscript {
        item_id: ItemId::new("voice-1").unwrap(),
        voice_session_id: "voice-source".into(),
        media_epoch: 1,
        speaker: ash_protocol::VoiceTranscriptSpeaker::User,
        text: "Review these changes".into(),
        start_ms: 0,
        end_ms: 200,
        after_item_id: None,
    };
    let TranscriptApplyResult::Applied(update) = apply(
        &mut accumulator,
        committed(
            1,
            ThreadEvent::VoiceTranscriptRecorded {
                thread_id: thread_id(),
                transcript: transcript.clone(),
            },
        ),
    ) else {
        panic!("voice update must be applied")
    };
    let ThreadTranscriptChange::Upsert { entry } = &update.changes[0] else {
        panic!("voice must use original transcript mutations")
    };
    assert_eq!(entry.turn_id(), None);
    assert!(!entry.is_transient());
    assert_eq!(entry.entry_id(), "voice-1");
    let mut next = transcript.clone();
    next.text.push_str(" please");
    next.end_ms = 300;
    let TranscriptApplyResult::Applied(update) = apply(
        &mut accumulator,
        committed(
            2,
            ThreadEvent::VoiceTranscriptRecorded {
                thread_id: thread_id(),
                transcript: next.clone(),
            },
        ),
    ) else {
        panic!("voice update must be applied")
    };
    assert!(
        matches!(&update.changes[0], ThreadTranscriptChange::Upsert { entry: ThreadTranscriptEntry::VoiceTranscript { transcript, .. } } if transcript == &next)
    );
    let empty = ThreadTranscriptSnapshot {
        session_id: session_id(),
        thread_id: thread_id(),
        durable_sequence: 2,
        revision: 0,
        entries: Vec::new(),
    };
    assert_eq!(
        empty
            .clone()
            .with_voice_transcripts(&[transcript])
            .entries
            .len(),
        1
    );
    next.after_item_id = Some(ItemId::new("outside-history-page").unwrap());
    assert!(empty.with_voice_transcripts(&[next]).entries.is_empty());
}
