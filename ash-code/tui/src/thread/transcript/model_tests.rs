use super::CellLifecycle;
use super::TranscriptCellId;
use super::TranscriptModel;
use crate::thread::transcript::CommandStatus;
use crate::thread::transcript::LocalCommandCompletion;
use crate::thread::transcript::MessageRole;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptEntry;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptSnapshot;
use ash_protocol::ContentDigest;
use ash_protocol::InstructionRef;
use ash_protocol::InstructionSource;
use ash_protocol::ItemId;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::ToolCallId;
use ash_protocol::ToolName;
use ash_protocol::ToolOutputStream;
use ash_protocol::TurnId;
use std::collections::BTreeSet;

#[test]
fn selected_instruction_is_visible_without_exposing_its_body_as_chat_text() {
    let turn_id = turn_id("selected-instruction");
    let mut model = TranscriptModel::default();
    model.replace(snapshot(vec![ThreadTranscriptEntry::Item {
        entry_id: "instruction-entry".into(),
        turn_id: turn_id.clone(),
        item: ThreadItem::UserInstruction {
            item_id: item_id("instruction-item"),
            turn_id,
            reference: InstructionRef {
                source: InstructionSource::User,
                relative_path: "manual.md".into(),
                digest: ContentDigest::sha256(b"secret guidance"),
            },
        },
        transient: false,
    }]));

    let views = model.views(&BTreeSet::new(), None);
    assert_eq!(views[0].text(), "Instruction · manual.md");
}

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
                binding: None,
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
    assert_eq!(views[0].text(), "Ran exec");
}

#[test]
fn history_prefix_stops_at_live_cells_and_active_turns() {
    let old = turn_id("old");
    let active = turn_id("active");
    let mut model = TranscriptModel::default();
    let old_message = message("old", &old, MessageRole::Agent, "old");
    let final_message = message("current", &active, MessageRole::Agent, "current");
    model.replace(snapshot(vec![old_message.clone(), final_message.clone()]));
    assert_eq!(model.history_prefix(Some(&active)).len(), 1);
    assert_eq!(model.history_prefix(None).len(), 2);
    let mut live_message = final_message;
    if let ThreadTranscriptEntry::Item { transient, .. } = &mut live_message {
        *transient = true;
    }
    model.replace(snapshot(vec![
        old_message,
        live_message,
        message("later", &old, MessageRole::Agent, "later"),
    ]));
    assert_eq!(model.history_prefix(None).len(), 1);
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
    model.replace(snapshot(vec![
        tool_call("one", &turn),
        tool_result("one", &turn),
    ]));
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
    model.push_message(MessageRole::User, "second prompt".into());
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
            binding: None,
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

fn message(entry: &str, turn: &TurnId, role: MessageRole, text: &str) -> ThreadTranscriptEntry {
    let item = match role {
        MessageRole::User => ThreadItem::UserMessage {
            item_id: item_id(entry),
            turn_id: turn.clone(),
            text: text.into(),
        },
        MessageRole::Agent => ThreadItem::AgentMessage {
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
