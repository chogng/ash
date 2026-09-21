use super::ThreadState;
use crate::thread::ThreadPresentationEvent;
use crate::thread::transcript::CommandStatus;
use crate::thread::transcript::MessageRole;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptChange;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptEntry;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptSnapshot;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptUpdateEnvelope;
use ash_protocol::ItemId;
use ash_protocol::PlanStep;
use ash_protocol::PlanStepStatus;
use ash_protocol::PlanUpdate;
use ash_protocol::SessionId;
use ash_protocol::Thread;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::ThreadStatus;
use ash_protocol::Turn;
use ash_protocol::TurnId;
use ash_protocol::TurnStatus;

#[test]
fn transcript_snapshot_replaces_local_rows_and_preserves_rendering() {
    let mut state = ThreadState::default();
    state.update(ThreadPresentationEvent::UserSubmitted("optimistic".into()));
    state.update(ThreadPresentationEvent::TranscriptSnapshotReceived(
        ThreadTranscriptSnapshot::from_thread(&thread_snapshot()),
    ));
    assert_eq!(
        state
            .messages()
            .iter()
            .map(|message| (message.role(), message.text().into_owned()))
            .collect::<Vec<_>>(),
        vec![
            (MessageRole::User, "canonical prompt".to_owned()),
            (MessageRole::Reasoning, "Thought".to_owned()),
            (MessageRole::Agent, "canonical response".to_owned()),
        ]
    );
}

#[test]
fn history_snapshot_is_prepended_without_duplicate_entries() {
    let mut state = ThreadState::default();
    state.update(ThreadPresentationEvent::TranscriptSnapshotReceived(
        ThreadTranscriptSnapshot::from_thread(&thread_snapshot()),
    ));
    let older = thread_with_item("turn_0", "older_item", "older prompt");
    state.update(ThreadPresentationEvent::TranscriptHistoryPageReceived(
        ThreadTranscriptSnapshot::from_thread(&older),
    ));
    assert_eq!(state.messages()[0].text(), "older prompt");
    assert_eq!(state.messages().len(), 4);
}

#[test]
fn complete_upsert_replaces_one_stable_transcript_row() {
    let mut state = ThreadState::default();
    state.update(ThreadPresentationEvent::TranscriptSnapshotReceived(
        empty_snapshot(),
    ));
    state.update(ThreadPresentationEvent::TranscriptUpdateReceived(Box::new(
        update(vec![upsert_agent("stream item", true)]),
    )));
    state.update(ThreadPresentationEvent::TranscriptUpdateReceived(Box::new(
        update(vec![upsert_agent("complete text", true)]),
    )));
    assert_eq!(state.messages().len(), 1);
    assert_eq!(state.messages()[0].text(), "complete text");
    assert_eq!(
        state.messages()[0].cell_id.as_deref(),
        Some("entry:item:item_stream")
    );
}

#[test]
fn clear_transient_preserves_committed_and_local_rows() {
    let mut state = ThreadState::default();
    state.update(ThreadPresentationEvent::TranscriptSnapshotReceived(
        ThreadTranscriptSnapshot::from_thread(&thread_snapshot()),
    ));
    state.update(ThreadPresentationEvent::NoticeReceived(
        "local notice".into(),
    ));
    state.update(ThreadPresentationEvent::TranscriptUpdateReceived(Box::new(
        update(vec![upsert_agent("temporary", true)]),
    )));
    state.update(ThreadPresentationEvent::TranscriptUpdateReceived(Box::new(
        update(vec![ThreadTranscriptChange::ClearTransient]),
    )));
    assert!(
        state
            .messages()
            .iter()
            .all(|message| message.text() != "temporary")
    );
    assert!(
        state
            .messages()
            .iter()
            .any(|message| message.text() == "canonical response")
    );
    assert!(
        state
            .messages()
            .iter()
            .any(|message| message.text() == "local notice")
    );
}

#[test]
fn structured_turn_plan_is_rendered_by_the_tui() {
    let mut thread = thread_snapshot();
    thread.turns[0].plan = Some(PlanUpdate {
        explanation: Some("Implementation plan".into()),
        steps: vec![
            PlanStep {
                step: "inspect".into(),
                status: PlanStepStatus::Completed,
            },
            PlanStep {
                step: "change".into(),
                status: PlanStepStatus::InProgress,
            },
        ],
    });
    let mut state = ThreadState::default();
    state.update(ThreadPresentationEvent::TranscriptSnapshotReceived(
        ThreadTranscriptSnapshot::from_thread(&thread),
    ));
    let messages = state.messages();
    let plan = messages.last().unwrap();
    assert_eq!(plan.role(), MessageRole::Plan);
    assert_eq!(plan.text(), "Implementation plan\n[x] inspect\n[>] change");
    assert_eq!(plan.cell_id.as_deref(), Some("entry:turn-plan:turn_1"));
}

#[test]
fn command_completion_groups_the_command_with_its_result() {
    let mut state = ThreadState::default();
    state.update(ThreadPresentationEvent::CommandSubmitted {
        command: "/theme light".into(),
        completion: crate::thread::transcript::LocalCommandCompletion::Deferred,
    });
    state.update(ThreadPresentationEvent::CommandStarted(
        "/theme light".into(),
    ));
    state.update(ThreadPresentationEvent::CommandCompleted {
        command: "/theme light".into(),
        result: "Theme set".into(),
    });
    let messages = state.messages();
    let message = messages.first().unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(message.command_status(), Some(CommandStatus::Succeeded));
    assert_eq!(message.detail().as_deref(), Some("Theme set"));
}

fn update(changes: Vec<ThreadTranscriptChange>) -> ThreadTranscriptUpdateEnvelope {
    ThreadTranscriptUpdateEnvelope {
        session_id: session_id(),
        thread_id: thread_id(),
        durable_sequence: 7,
        revision: 1,
        stream_cursor: None,
        changes,
    }
}

fn upsert_agent(text: &str, transient: bool) -> ThreadTranscriptChange {
    let turn_id = TurnId::new("turn_stream").unwrap();
    let item_id = ItemId::new("item_stream").unwrap();
    ThreadTranscriptChange::Upsert {
        entry: ThreadTranscriptEntry::Item {
            entry_id: "item:item_stream".into(),
            turn_id: turn_id.clone(),
            item: ThreadItem::AgentMessage {
                item_id,
                turn_id,
                text: text.into(),
            },
            transient,
        },
    }
}

fn empty_snapshot() -> ThreadTranscriptSnapshot {
    ThreadTranscriptSnapshot {
        session_id: session_id(),
        thread_id: thread_id(),
        durable_sequence: 7,
        revision: 1,
        entries: Vec::new(),
    }
}

fn thread_snapshot() -> Thread {
    let turn_id = TurnId::new("turn_1").unwrap();
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
        sequence: 7,
        usage: ash_protocol::ModelUsageSummary::default(),
        reference_cost: ash_protocol::ModelReferenceCostSummary::default(),
        goal: None,
        turns: vec![Turn {
            advisor: None,
            turn_id: turn_id.clone(),
            status: TurnStatus::Completed,
            kind: Default::default(),
            instructions: None,
            model: None,
            tool_profile: None,
            tool_mode: ash_protocol::ToolMode::Direct,
            approval_mode: ash_protocol::ApprovalMode::AskPermissions,
            usage: ash_protocol::ModelUsageSummary::default(),
            context_usage: None,
            items: vec![
                ThreadItem::UserMessage {
                    item_id: ItemId::new("item_1").unwrap(),
                    turn_id: turn_id.clone(),
                    text: "canonical prompt".into(),
                },
                ThreadItem::Reasoning {
                    item_id: ItemId::new("item_2").unwrap(),
                    turn_id: turn_id.clone(),
                    text: "inspect the code".into(),
                },
                ThreadItem::AgentMessage {
                    item_id: ItemId::new("item_3").unwrap(),
                    turn_id,
                    text: "canonical response".into(),
                },
            ],
            plan: None,
            pending_interaction: None,
            error: None,
        }],
    }
}

fn thread_with_item(turn: &str, item: &str, text: &str) -> Thread {
    let turn_id = TurnId::new(turn).unwrap();
    Thread {
        turns: vec![Turn {
            advisor: None,
            turn_id: turn_id.clone(),
            status: TurnStatus::Completed,
            kind: Default::default(),
            instructions: None,
            model: None,
            tool_profile: None,
            tool_mode: ash_protocol::ToolMode::Direct,
            approval_mode: ash_protocol::ApprovalMode::AskPermissions,
            usage: ash_protocol::ModelUsageSummary::default(),
            context_usage: None,
            items: vec![ThreadItem::UserMessage {
                item_id: ItemId::new(item).unwrap(),
                turn_id,
                text: text.into(),
            }],
            plan: None,
            pending_interaction: None,
            error: None,
        }],
        ..thread_snapshot()
    }
}

fn session_id() -> SessionId {
    SessionId::new("session_1").unwrap()
}
fn thread_id() -> ThreadId {
    ThreadId::new("thread_1").unwrap()
}

#[test]
fn markdown_updates_render_links_and_tables_without_changing_canonical_messages() {
    use crate::render::Renderable;
    use crate::render::test_context;
    use crate::terminal::hyperlinks::FrameLinks;
    use crate::thread::transcript::ChatHistoryPointerState;
    use crate::thread::transcript::ChatHistoryRenderCache;
    use crate::thread::transcript::ChatHistoryScroll;
    use crate::thread::transcript::ChatHistoryView;
    use ratatui::Terminal;
    use ratatui::backend::CrosstermBackend;
    use ratatui::backend::TestBackend;
    use ratatui::style::Modifier;
    use std::cell::RefCell;

    let mut state = ThreadState::default();
    state.update(ThreadPresentationEvent::TranscriptSnapshotReceived(
        empty_snapshot(),
    ));
    let cache = ChatHistoryRenderCache::default();
    let scroll = ChatHistoryScroll::default();
    let partial = "# Result\n\n[文档](https://example.com)\n\n| Name | State |\n| --- | --- |\n| alpha | pending |";
    let complete = format!("{partial}\n| beta | complete |\n\n```rust\nfn main() {{}}\n```\n");
    let mut terminal = Terminal::new(TestBackend::new(38, 18)).unwrap();
    for (index, source) in [partial, complete.as_str(), "replacement"]
        .into_iter()
        .enumerate()
    {
        state.update(ThreadPresentationEvent::TranscriptUpdateReceived(Box::new(
            update(vec![upsert_agent(source, index == 0)]),
        )));
        let messages = state.messages();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].text(), source);
        let links = RefCell::new(FrameLinks::default());
        terminal
            .draw(|frame| {
                ChatHistoryView {
                    jump_label: "Ctrl+End to jump to bottom ↓",
                    header: None,
                    messages: &messages,
                    scroll: &scroll,
                    render_cache: &cache,
                    pointer: ChatHistoryPointerState::default(),
                }
                .render(
                    frame,
                    frame.area(),
                    test_context().with_hyperlinks(&links),
                )
            })
            .unwrap();
        let buffer = terminal.backend().buffer();
        let mut output = CrosstermBackend::new(Vec::new());
        links
            .borrow()
            .write(&FrameLinks::default(), buffer, None, &mut output)
            .unwrap();
        let output = String::from_utf8(output.writer_mut().clone()).unwrap();
        if index < 2 {
            assert!(output.contains("https://example.com/"));
            assert_eq!(buffer[(0, 0)].symbol(), "●");
            assert_eq!(buffer[(1, 0)].symbol(), " ");
            assert!(
                buffer[(2, 2)].modifier.contains(Modifier::UNDERLINED),
                "{:?}\n{}",
                buffer,
                terminal.backend()
            );
            assert!(buffer[(2, 0)].modifier.contains(Modifier::BOLD));
        } else {
            assert!(!output.contains("https://"));
            assert!(!terminal.backend().to_string().contains("alpha"));
        }
        if index == 1 {
            crate::tui_assert_snapshot!(
                "markdown_transcript_completed",
                terminal.backend().to_string()
            );
        }
    }
}

#[test]
fn streaming_deadlines_change_the_visible_panel_without_changing_message_text() {
    use crate::render::Renderable;
    use crate::render::test_context;
    use crate::thread::transcript::ChatHistoryPointerState;
    use crate::thread::transcript::ChatHistoryRenderCache;
    use crate::thread::transcript::ChatHistoryScroll;
    use crate::thread::transcript::ChatHistoryView;
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;
    use std::collections::BTreeSet;
    use std::time::Duration;
    use std::time::Instant;

    let now = Instant::now();
    let mut state = ThreadState::default();
    state.update_at(
        ThreadPresentationEvent::TranscriptSnapshotReceived(empty_snapshot()),
        now,
    );
    let text = "first line\nsecond line\nthird line";
    state.update_at(
        ThreadPresentationEvent::TranscriptUpdateReceived(Box::new(update(vec![upsert_agent(
            text, true,
        )]))),
        now,
    );
    let cache = ChatHistoryRenderCache::default();
    let scroll = ChatHistoryScroll::default();
    let mut terminal = Terminal::new(TestBackend::new(24, 5)).unwrap();
    let mut phases = Vec::new();
    let revision = state.messages()[0].render_revision;
    for elapsed in [0, 40, 80] {
        assert!(state.advance_stream(now + Duration::from_millis(elapsed)));
        assert_eq!(state.messages()[0].text(), text);
        assert_eq!(state.messages()[0].render_revision, revision);
        let messages = state.visible_views(&BTreeSet::new(), None);
        terminal
            .draw(|frame| {
                ChatHistoryView {
                    jump_label: "Ctrl+End to jump to bottom ↓",
                    header: None,
                    messages: &messages,
                    scroll: &scroll,
                    render_cache: &cache,
                    pointer: ChatHistoryPointerState::default(),
                }
                .render(frame, frame.area(), test_context())
            })
            .unwrap();
        assert_eq!(terminal.backend().buffer()[(0, 0)].symbol(), "●");
        assert_eq!(terminal.backend().buffer()[(1, 0)].symbol(), " ");
        phases.push(format!("{elapsed} ms\n{}", terminal.backend()));
    }
    assert!(state.stream_deadline().is_none());
    assert_eq!(cache.entry_count(), 1);
    crate::tui_assert_snapshot!("streaming_commit_phases", phases.join("\n"));
}

#[test]
fn switching_threads_and_interrupting_stop_pending_stream_animation() {
    use std::collections::BTreeSet;
    use std::time::Instant;
    let now = Instant::now();
    let mut state = ThreadState::default();
    let source = "one\ntwo\nthree";
    state.update_at(
        ThreadPresentationEvent::TranscriptUpdateReceived(Box::new(update(vec![upsert_agent(
            source, true,
        )]))),
        now,
    );
    state.advance_stream(now);
    assert_eq!(
        state.visible_views(&BTreeSet::new(), None)[0].text(),
        "one\n"
    );
    let other = ThreadId::new("other").unwrap();
    state.switch_transcript(&thread_id(), &other);
    assert!(state.stream_deadline().is_none());
    state.switch_transcript(&other, &thread_id());
    assert_eq!(
        state.visible_views(&BTreeSet::new(), None)[0].text(),
        source
    );
    assert!(state.stream_deadline().is_none());
    state.update_at(
        ThreadPresentationEvent::TranscriptUpdateReceived(Box::new(update(vec![upsert_agent(
            "one\ntwo\nthree\nlast",
            true,
        )]))),
        now,
    );
    assert!(state.stream_deadline().is_some());
    state.update_at(ThreadPresentationEvent::Interrupted, now);
    assert!(state.stream_deadline().is_none());
    assert_eq!(
        state.visible_views(&BTreeSet::new(), None)[0].text(),
        "one\ntwo\nthree\nlast"
    );
}
