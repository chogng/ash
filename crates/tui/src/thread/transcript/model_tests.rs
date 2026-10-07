use super::CellLifecycle;
use super::TranscriptCellId;
use super::TranscriptModel;
use crate::render::Renderable;
use crate::thread::transcript::ChatHistoryPointerState;
use crate::thread::transcript::ChatHistoryRenderCache;
use crate::thread::transcript::ChatHistoryScroll;
use crate::thread::transcript::ChatHistoryView;
use crate::thread::transcript::CommandStatus;
use crate::thread::transcript::LocalCommandCompletion;
use crate::thread::transcript::MessageRole;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptChange;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptEntry;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptSnapshot;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptUpdateEnvelope;
use ash_protocol::ItemId;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::ToolActivity;
use ash_protocol::ToolCallId;
use ash_protocol::ToolName;
use ash_protocol::ToolOutputStream;
use ash_protocol::TurnId;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use std::collections::BTreeSet;
use unicode_width::UnicodeWidthStr;

#[test]
fn tool_call_output_and_result_form_one_exec_cell() {
    let turn_id = turn_id("turn");
    let tool_call_id = call_id("call");
    let mut model = TranscriptModel::default();
    model.replace(snapshot(vec![
        ThreadTranscriptEntry::Item {
            entry_id: "call-entry".into(),
            turn_id: turn_id.clone(),
            item: ThreadItem::ToolCall {
                item_id: item_id("call-item"),
                turn_id: turn_id.clone(),
                tool_call_id: tool_call_id.clone(),
                name: ToolName::new("exec").unwrap(),
                arguments_json: "{\"cmd\":\"test\"}".into(),
                binding: Some(activity_binding(ToolActivity::Run)),
            },
            transient: false,
        },
        ThreadTranscriptEntry::ToolOutput {
            entry_id: "output-entry".into(),
            turn_id: turn_id.clone(),
            tool_call_id: tool_call_id.clone(),
            stream: ToolOutputStream::Stdout,
            text: "running".into(),
        },
        ThreadTranscriptEntry::Item {
            entry_id: "result-entry".into(),
            turn_id: turn_id.clone(),
            item: ThreadItem::ToolResult {
                item_id: item_id("result-item"),
                turn_id,
                tool_call_id,
                text: "passed".into(),
                content: None,
                is_error: false,
            },
            transient: false,
        },
    ]));

    assert_eq!(model.cells().len(), 1);
    assert_eq!(model.cells()[0].lifecycle(), CellLifecycle::Final);
    let views = model.views(&BTreeSet::new(), None);
    assert_eq!(views[0].command_status(), Some(CommandStatus::Succeeded));
    assert_eq!(views[0].text(), "Command finished");

    let expanded = BTreeSet::from([model.cells()[0].cell_id().clone()]);
    let views = model.views(&expanded, None);
    let scroll = ChatHistoryScroll::default();
    let cache = ChatHistoryRenderCache::default();
    let view = ChatHistoryView {
        jump_label: "Jump to bottom",
        header: None,
        messages: &views,
        scroll: &scroll,
        render_cache: &cache,
        pointer: Default::default(),
    };
    let mut terminal = Terminal::new(TestBackend::new(40, 9)).unwrap();
    terminal
        .draw(|frame| view.render(frame, frame.area(), crate::render::test_context()))
        .unwrap();
    let buffer = terminal.backend().buffer();
    assert_eq!(buffer[(0, 1)].symbol(), " ");
    assert_eq!(buffer[(1, 1)].symbol(), "└");
    assert_eq!(buffer[(4, 1)].symbol(), "e");
    assert_eq!(buffer[(4, 5)].symbol(), "r");
    assert_eq!(buffer[(4, 6)].symbol(), "p");
    assert_eq!(buffer[(4, 7)].symbol(), "v");
    let visible = (0..9)
        .map(|y| {
            (0..40)
                .map(|x| buffer[(x, y)].symbol())
                .collect::<String>()
                .trim_end()
                .to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n");
    insta::assert_snapshot!(visible, @r#"
    ● Command finished
     └─ exec [call]
        {
          "cmd": "test"
        }
        running
        passed
        view full
    "#);
}

#[test]
fn policy_stop_transcript_keeps_the_reason_without_a_retry_suggestion() {
    let mut model = TranscriptModel::default();
    model.replace(snapshot(vec![ThreadTranscriptEntry::TurnError {
        entry_id: "turn-error:policy-stop".into(),
        turn_id: turn_id("policy-stop"),
        error: ash_protocol::StableTurnError::policy_circuit_breaker(
            "Automatic review rejected three consecutive actions.".into(),
        ),
    }]));
    let views = model.views(&BTreeSet::new(), None);
    assert_eq!(views[0].role(), MessageRole::Error);
    insta::assert_snapshot!(views[0].text(), @"Automatic review rejected three consecutive actions.");
}

#[test]
fn grouped_history_failure_names_the_failed_call_and_command_completion_stays_neutral() {
    let turn = turn_id("turn");
    let call = |name: &str, activity: ToolActivity| ThreadTranscriptEntry::Item {
        entry_id: format!("call-{name}"),
        turn_id: turn.clone(),
        item: ThreadItem::ToolCall {
            item_id: item_id(&format!("call-item-{name}")),
            turn_id: turn.clone(),
            tool_call_id: call_id(name),
            name: ToolName::new(name).unwrap(),
            arguments_json: "{}".into(),
            binding: Some(activity_binding(activity)),
        },
        transient: false,
    };
    let result = |name: &str, text: &str, is_error: bool| ThreadTranscriptEntry::Item {
        entry_id: format!("result-{name}"),
        turn_id: turn.clone(),
        item: ThreadItem::ToolResult {
            item_id: item_id(&format!("result-item-{name}")),
            turn_id: turn.clone(),
            tool_call_id: call_id(name),
            text: text.into(),
            content: None,
            is_error,
        },
        transient: false,
    };
    let mut model = TranscriptModel::default();
    model.replace(snapshot(vec![
        call(
            "history_list",
            ToolActivity::List {
                target: "history".into(),
            },
        ),
        result("history_list", "2 entries", false),
        call(
            "history_read",
            ToolActivity::Read {
                target: "history".into(),
            },
        ),
        result("history_read", "record missing", true),
        call("shell-command", ToolActivity::Run),
        result("shell-command", "exit 0", false),
    ]));

    assert_eq!(model.cells().len(), 2);
    let views = model.views(&BTreeSet::new(), None);
    let context = crate::render::test_context().with_language(crate::nls::Language::Chinese);
    let scroll = ChatHistoryScroll::default();
    let render_cache = ChatHistoryRenderCache::default();
    let view = ChatHistoryView {
        jump_label: "Jump to bottom",
        header: None,
        messages: &views,
        scroll: &scroll,
        render_cache: &render_cache,
        pointer: ChatHistoryPointerState::default(),
    };
    let mut terminal = Terminal::new(TestBackend::new(50, 16)).unwrap();
    terminal
        .draw(|frame| view.render(frame, frame.area(), context))
        .unwrap();
    let buffer = terminal.backend().buffer();
    let visible = (0..16)
        .map(|y| {
            let mut row = String::new();
            let mut continuation = 0;
            for x in 0..50 {
                if continuation > 0 {
                    continuation -= 1;
                    continue;
                }
                let symbol = buffer[(x, y)].symbol();
                row.push_str(symbol);
                continuation = UnicodeWidthStr::width(symbol).saturating_sub(1);
            }
            row.trim_end().to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n");
    crate::tui_assert_snapshot!("grouped_history_failure_chinese", visible);
    assert_eq!(buffer[(0, 0)].fg, context.muted());
    assert_eq!(buffer[(0, 1)].symbol(), " ");
    assert_eq!(buffer[(1, 1)].symbol(), "└");
    assert_eq!(buffer[(4, 3)].fg, context.danger());
    assert_eq!(buffer[(0, 7)].fg, context.muted());
}

#[test]
fn expansion_is_derived_without_changing_cell_lifecycle() {
    let turn_id = turn_id("turn");
    let tool_call_id = call_id("call");
    let mut model = TranscriptModel::default();
    model.replace(snapshot(vec![ThreadTranscriptEntry::Item {
        entry_id: "call-entry".into(),
        turn_id: turn_id.clone(),
        item: ThreadItem::ToolCall {
            item_id: item_id("call-item"),
            turn_id,
            tool_call_id: tool_call_id.clone(),
            name: ToolName::new("exec").unwrap(),
            arguments_json: "{\"cmd\":\"test\"}".into(),
            binding: None,
        },
        transient: true,
    }]));
    let mut expanded = BTreeSet::new();
    let cell_id = TranscriptCellId::for_tool_call(&tool_call_id);
    expanded.insert(cell_id.clone());

    let view = model.views(&expanded, Some(&cell_id));
    assert!(view[0].expanded);
    assert!(view[0].selected);
    assert_eq!(model.cells()[0].lifecycle(), CellLifecycle::Live);
}

#[test]
fn exec_cell_identity_is_derived_from_the_first_tool_call_across_resync() {
    let turn_id = turn_id("turn");
    let call_id = call_id("stable-call");
    let entries = vec![ThreadTranscriptEntry::Item {
        entry_id: "replaceable-entry".into(),
        turn_id: turn_id.clone(),
        item: ThreadItem::ToolCall {
            item_id: item_id("call-item"),
            turn_id,
            tool_call_id: call_id.clone(),
            name: ToolName::new("exec").unwrap(),
            arguments_json: "{}".into(),
            binding: None,
        },
        transient: false,
    }];
    let mut model = TranscriptModel::default();
    model.replace(snapshot(entries.clone()));
    let first = model.cells()[0].cell_id().clone();
    model.replace(snapshot(entries));

    assert_eq!(first, TranscriptCellId::for_tool_call(&call_id));
    assert_eq!(model.cells()[0].cell_id(), &first);
}

#[test]
fn reinstalling_a_cell_advances_its_render_revision() {
    let turn_id = turn_id("turn");
    let entries = vec![ThreadTranscriptEntry::Item {
        entry_id: "agent-entry".into(),
        turn_id: turn_id.clone(),
        item: ThreadItem::AgentMessage {
            phase: None,
            item_id: item_id("agent-item"),
            turn_id,
            text: "streamed answer".into(),
        },
        transient: false,
    }];
    let mut model = TranscriptModel::default();
    model.replace(snapshot(entries.clone()));
    let first = model.views(&BTreeSet::new(), None)[0].render_revision;

    model.replace(snapshot(entries));
    let second = model.views(&BTreeSet::new(), None)[0].render_revision;

    assert!(second > first);
}

#[test]
fn a_completed_execution_group_accepts_more_calls_from_the_same_turn() {
    let turn = turn_id("group-turn");
    let mut model = TranscriptModel::default();
    let mut first_result = tool_result("one", &turn);
    if let ThreadTranscriptEntry::Item {
        item: ThreadItem::ToolResult { text, .. },
        ..
    } = &mut first_result
    {
        *text = format!("result one\n{}", "long output\n".repeat(20));
    }
    model.replace(snapshot(vec![tool_call("one", &turn), first_result]));
    let id = model.cells()[0].cell_id().clone();
    model.upsert(tool_call("two", &turn));
    model.upsert(tool_result("two", &turn));
    assert_eq!(model.cells().len(), 1);
    assert_eq!(model.cells()[0].cell_id(), &id);
    let detail = model.cells()[0]
        .history_view()
        .detail()
        .unwrap()
        .into_owned();
    assert!(detail.contains("result one"));
    assert!(detail.contains("result two"));
    let expanded = BTreeSet::from([id]);
    let views = model.views(&expanded, None);
    let lines = views[0].lines(crate::render::test_context(), None, 80);
    let visible = lines
        .lines
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(visible.contains("result one"));
    assert!(
        visible.contains("result two"),
        "the first call must not consume the entire group preview"
    );
}

#[test]
fn execution_groups_never_merge_across_turns() {
    let first = turn_id("first");
    let second = turn_id("second");
    let mut model = TranscriptModel::default();
    model.replace(snapshot(vec![
        tool_call("one", &first),
        tool_result("one", &first),
        tool_call("two", &second),
    ]));
    assert_eq!(model.cells().len(), 2);
    assert_eq!(
        model.cells()[1].cell_id(),
        &TranscriptCellId::for_tool_call(&call_id("two"))
    );
}

#[test]
fn streamed_user_confirmation_replaces_the_optimistic_message() {
    let turn = turn_id("turn");
    let mut model = TranscriptModel::default();
    model.push_user_message(
        ash_protocol::CommandId::new("user").unwrap(),
        "same prompt".into(),
    );
    model.apply(ThreadTranscriptUpdateEnvelope {
        session_id: session_id("session"),
        thread_id: thread_id("thread"),
        durable_sequence: 1,
        revision: 1,
        stream_cursor: None,
        changes: vec![
            ThreadTranscriptChange::Upsert {
                entry: message("user", &turn, MessageRole::User, "same prompt"),
            },
            ThreadTranscriptChange::Upsert {
                entry: message("agent", &turn, MessageRole::Agent, "reply"),
            },
        ],
    });
    let views = model.views(&BTreeSet::new(), None);
    assert_eq!(views.len(), 2);
    assert_eq!(views[0].text(), "same prompt");
    assert_eq!(views[1].text(), "reply");
}

#[test]
fn identical_submissions_are_confirmed_by_id_even_when_receipts_arrive_in_reverse_order() {
    let mut model = TranscriptModel::default();
    let command = |id| ash_protocol::CommandId::new(id).unwrap();
    model.push_user_message(command("first"), "rebase".into());
    model.push_user_message(command("second"), "rebase".into());
    let turn = turn_id("turn");
    let first = message("first", &turn, MessageRole::User, "first canonical prompt");
    let second = message(
        "second",
        &turn,
        MessageRole::User,
        "second canonical prompt",
    );
    let update = |entry| ThreadTranscriptUpdateEnvelope {
        session_id: session_id("session"),
        thread_id: thread_id("thread"),
        durable_sequence: 1,
        revision: 1,
        stream_cursor: None,
        changes: vec![ThreadTranscriptChange::Upsert { entry }],
    };

    model.apply(update(second.clone()));
    assert_eq!(model.cells().len(), 2);
    assert_eq!(model.cells()[0].source_entry_id, None);
    assert_eq!(model.cells()[1].source_entry_id.as_deref(), Some("second"));
    assert_eq!(model.views(&BTreeSet::new(), None)[0].text(), "rebase");
    assert!(model.history_prefix(None).is_empty());

    model.apply(update(first.clone()));
    model.apply(update(second.clone()));
    assert_eq!(model.cells().len(), 2);
    assert_eq!(model.cells()[0].source_entry_id.as_deref(), Some("first"));
    assert_eq!(model.cells()[1].source_entry_id.as_deref(), Some("second"));
    model.replace(snapshot(vec![first, second]));
    let views = model.views(&BTreeSet::new(), None);
    assert_eq!(views.len(), 2);
    assert_eq!(views[0].text(), "first canonical prompt");
    assert_eq!(views[1].text(), "second canonical prompt");
}

#[test]
fn snapshot_confirms_only_its_submission_and_keeps_other_identical_local_messages() {
    let mut model = TranscriptModel::default();
    let command = |id| ash_protocol::CommandId::new(id).unwrap();
    model.push_user_message(command("first"), "rebase".into());
    model.push_user_message(command("second"), "rebase".into());
    let turn = turn_id("turn");
    let first = message("first", &turn, MessageRole::User, "canonical prompt");
    let other = message("another-client", &turn, MessageRole::User, "rebase");
    model.replace(snapshot(vec![first.clone(), other.clone()]));
    model.replace(snapshot(vec![first, other]));
    assert_eq!(model.cells().len(), 3);
    let pending = model
        .cells()
        .iter()
        .filter(|cell| cell.source_entry_id.is_none())
        .collect::<Vec<_>>();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].client_id.as_ref(), Some(&command("second")));
}

#[test]
fn attachment_only_receipt_confirms_the_local_submission() {
    let mut model = TranscriptModel::default();
    let command_id = ash_protocol::CommandId::new("attachment").unwrap();
    model.push_user_message(command_id.clone(), "[Image #1]".into());
    let entry = ThreadTranscriptEntry::Item {
        entry_id: "image".into(),
        turn_id: turn_id("turn"),
        item: ThreadItem::UserImage {
            client_id: Some(command_id),
            item_id: item_id("image"),
            turn_id: turn_id("turn"),
            url: "https://example.com/image.png".into(),
        },
        transient: false,
    };
    model.replace(snapshot(vec![entry]));
    assert_eq!(model.cells().len(), 1);
    assert_eq!(model.cells()[0].source_entry_id.as_deref(), Some("image"));
    assert_eq!(model.views(&BTreeSet::new(), None)[0].text(), "[Image]");
}

#[test]
fn snapshot_keeps_local_commands_in_order_and_replaces_the_optimistic_user_message() {
    let first = turn_id("first");
    let second = turn_id("second");
    let first_entries = vec![
        message("first-user", &first, MessageRole::User, "first prompt"),
        message("first-agent", &first, MessageRole::Agent, "first reply"),
    ];
    let mut model = TranscriptModel::default();
    model.replace(snapshot(first_entries.clone()));
    model.command_submitted("/status".into(), LocalCommandCompletion::Immediate);
    model.push_user_message(
        ash_protocol::CommandId::new("second-user").unwrap(),
        "second prompt".into(),
    );
    model.command_submitted(
        "/status-after-submit".into(),
        LocalCommandCompletion::Immediate,
    );

    let mut confirmed = first_entries;
    confirmed.push(message(
        "second-user",
        &second,
        MessageRole::User,
        "second prompt",
    ));
    confirmed.push(message(
        "second-agent",
        &second,
        MessageRole::Agent,
        "second reply",
    ));
    model.replace(snapshot(confirmed));

    let texts = model
        .views(&BTreeSet::new(), None)
        .into_iter()
        .map(|cell| cell.text().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(
        texts,
        [
            "first prompt",
            "first reply",
            "/status",
            "second prompt",
            "/status-after-submit",
            "second reply"
        ]
    );
}

fn tool_call(name: &str, turn: &TurnId) -> ThreadTranscriptEntry {
    ThreadTranscriptEntry::Item {
        entry_id: format!("call-{name}"),
        turn_id: turn.clone(),
        transient: false,
        item: ThreadItem::ToolCall {
            item_id: item_id(&format!("item-{name}")),
            turn_id: turn.clone(),
            tool_call_id: call_id(name),
            name: ToolName::new("read_file").unwrap(),
            arguments_json: "{}".into(),
            binding: Some(activity_binding(ToolActivity::Read {
                target: "file".into(),
            })),
        },
    }
}

#[test]
fn local_commands_wait_for_their_history_page_without_being_lost_or_duplicated() {
    let turn = turn_id("history");
    let older = message("older", &turn, MessageRole::Agent, "older reply");
    let newer = message("newer", &turn, MessageRole::Agent, "newer reply");
    let mut model = TranscriptModel::default();
    model.replace(snapshot(vec![older.clone()]));
    model.command_submitted("/status".into(), LocalCommandCompletion::Immediate);
    model.command_submitted("/help".into(), LocalCommandCompletion::Immediate);
    let ids = model
        .cells()
        .iter()
        .skip(1)
        .map(|cell| cell.cell_id().clone())
        .collect::<Vec<_>>();
    for _ in 0..2 {
        model.replace(snapshot(vec![newer.clone()]));
        assert_eq!(model.cells().len(), 1);
    }
    for _ in 0..2 {
        model.prepend_history(snapshot(vec![older.clone()]));
        assert_eq!(
            model
                .views(&BTreeSet::new(), None)
                .iter()
                .map(|cell| cell.text().into_owned())
                .collect::<Vec<_>>(),
            ["older reply", "/status", "/help", "newer reply"]
        );
        assert_eq!(
            model
                .cells()
                .iter()
                .skip(1)
                .take(2)
                .map(|cell| cell.cell_id().clone())
                .collect::<Vec<_>>(),
            ids
        );
    }
    model.replace(snapshot(vec![newer]));
    model.clear();
    model.prepend_history(snapshot(vec![older]));
    assert_eq!(model.cells().len(), 1);
}

fn tool_result(name: &str, turn: &TurnId) -> ThreadTranscriptEntry {
    ThreadTranscriptEntry::Item {
        entry_id: format!("result-{name}"),
        turn_id: turn.clone(),
        transient: false,
        item: ThreadItem::ToolResult {
            item_id: item_id(&format!("result-item-{name}")),
            turn_id: turn.clone(),
            tool_call_id: call_id(name),
            text: format!("result {name}"),
            content: None,
            is_error: false,
        },
    }
}

fn activity_binding(activity: ToolActivity) -> ash_protocol::ToolCallBinding {
    ash_protocol::ToolCallBinding {
        registry_incarnation: None,
        registry_generation: 1,
        definition_digest: "test-definition".into(),
        source_chain: vec![ash_protocol::ToolSourceProvenance::Product {
            component: "test".into(),
        }],
        activity: Some(activity),
        caller: ash_protocol::ToolCallCaller::Direct,
    }
}

fn message(entry: &str, turn: &TurnId, role: MessageRole, text: &str) -> ThreadTranscriptEntry {
    let item = match role {
        MessageRole::User => ThreadItem::UserMessage {
            client_id: Some(ash_protocol::CommandId::new(entry).unwrap()),
            item_id: item_id(entry),
            turn_id: turn.clone(),
            text: text.into(),
        },
        MessageRole::Agent => ThreadItem::AgentMessage {
            phase: None,
            item_id: item_id(entry),
            turn_id: turn.clone(),
            text: text.into(),
        },
        _ => panic!("test helper supports user and agent messages"),
    };
    ThreadTranscriptEntry::Item {
        entry_id: entry.into(),
        turn_id: turn.clone(),
        item,
        transient: false,
    }
}

fn snapshot(entries: Vec<ThreadTranscriptEntry>) -> ThreadTranscriptSnapshot {
    ThreadTranscriptSnapshot {
        session_id: session_id("session"),
        thread_id: thread_id("thread"),
        durable_sequence: 1,
        revision: 1,
        entries,
    }
}

fn turn_id(value: &str) -> TurnId {
    TurnId::new(value).expect("the test Turn ID is valid")
}

fn call_id(value: &str) -> ToolCallId {
    ToolCallId::new(value).expect("the test ToolCall ID is valid")
}

fn item_id(value: &str) -> ItemId {
    ItemId::new(value).expect("the test item ID is valid")
}

fn session_id(value: &str) -> SessionId {
    SessionId::new(value).expect("the test Session ID is valid")
}

fn thread_id(value: &str) -> ThreadId {
    ThreadId::new(value).expect("the test Thread ID is valid")
}

#[test]
fn audio_history_is_a_user_message_with_a_visible_duration() {
    let mut model = TranscriptModel::default();
    model.replace(snapshot(vec![ThreadTranscriptEntry::Item {
        entry_id: "audio-entry".into(),
        turn_id: turn_id("turn"),
        transient: false,
        item: ThreadItem::UserAudioAttachment {
            client_id: None,
            item_id: item_id("audio"),
            turn_id: turn_id("turn"),
            attachment: ash_protocol::AudioAttachmentRef {
                content_digest: ash_protocol::ContentDigest::sha256(b"recording"),
                media_type: ash_protocol::AudioMediaType::Wav,
                encoded_bytes: 32044,
                duration_ms: 1001,
            },
        },
    }]));
    let expanded = BTreeSet::new();
    let views = model.views(&expanded, None);
    assert_eq!(views.len(), 1);
    assert_eq!(model.cells()[0].lifecycle(), CellLifecycle::Final);
    insta::assert_snapshot!(views[0].text(), @"[Audio · 2 seconds]");
}

#[test]
fn absent_reasoning_stays_hidden_until_a_public_summary_arrives() {
    let turn = turn_id("turn");
    let reasoning = |text: &str| ThreadTranscriptEntry::Item {
        entry_id: "reasoning".into(),
        turn_id: turn.clone(),
        transient: true,
        item: ThreadItem::Reasoning {
            item_id: item_id("reasoning"),
            turn_id: turn.clone(),
            text: text.into(),
            state: vec![ash_protocol::ReasoningState {
                scope: "provider".into(),
                item: serde_json::json!({"opaque":"state"}),
            }],
        },
    };
    let mut model = TranscriptModel::default();
    model.replace(snapshot(vec![reasoning("  ")]));
    let id = model.cells()[0].cell_id().clone();
    assert_eq!(model.cells().len(), 1);
    assert!(!model.cells()[0].is_visible());
    assert!(model.views(&BTreeSet::new(), None).is_empty());
    assert!(
        model.cells()[0]
            .history_view()
            .lines(crate::render::test_context(), None, 40)
            .lines
            .is_empty()
    );
    model.apply(ThreadTranscriptUpdateEnvelope {
        session_id: session_id("session"),
        thread_id: thread_id("thread"),
        durable_sequence: 2,
        revision: 2,
        stream_cursor: None,
        changes: vec![ThreadTranscriptChange::Upsert {
            entry: reasoning("Inspect daemon startup"),
        }],
    });
    assert_eq!(model.cells()[0].cell_id(), &id);
    assert!(model.cells()[0].is_visible());
    let views = model.views(&BTreeSet::new(), None);
    assert_eq!(views.len(), 1);
    assert_eq!(views[0].detail().as_deref(), Some("Inspect daemon startup"));
}
