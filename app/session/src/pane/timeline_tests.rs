//! Thread timeline presentation tests.

use super::{ThreadTimeline, ThreadTimelineStyle};
use crate::TranscriptState;
use ash_protocol::{
    ItemId, SessionId, StableTurnError, Thread, ThreadId, ThreadItem, ThreadStatus, ToolCallId,
    ToolName, Turn, TurnId, TurnStatus,
};
use ash_thread_transcript::ThreadTranscriptSnapshot;
use zui::ui::{Color, Rect};

#[test]
fn timeline_groups_shell_result_under_its_tool_call() {
    let thread = Thread {
        agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
        origin: Default::default(),
        session_id: SessionId::new("session").unwrap(),
        thread_id: ThreadId::new("thread").unwrap(),
        parent_thread_id: None,
        forked_from_id: None,
        title: "Agent".to_owned(),
        status: ThreadStatus::Active,
        sequence: 5,
        usage: Default::default(),
        reference_cost: Default::default(),
        goal: None,
        turns: vec![Turn {
            turn_id: TurnId::new("turn").unwrap(),
            status: TurnStatus::Completed,
            kind: ash_protocol::TurnKind::Coding,
            instructions: None,
            model: None,
            tool_profile: None,
            tool_mode: Default::default(),
            approval_mode: ash_protocol::ApprovalMode::AskPermissions,
            usage: Default::default(),
            context_usage: None,
            items: vec![
                ThreadItem::UserMessage {
                    item_id: ItemId::new("user").unwrap(),
                    turn_id: TurnId::new("turn").unwrap(),
                    text: "run the tests".to_owned(),
                },
                ThreadItem::UserContext {
                    item_id: ItemId::new("context").unwrap(),
                    turn_id: TurnId::new("turn").unwrap(),
                    name: "README selection".to_owned(),
                    content: "selected content".to_owned(),
                },
                ThreadItem::UserAudioAttachment {
                    item_id: ItemId::new("audio").unwrap(), turn_id: TurnId::new("turn").unwrap(),
                    attachment: ash_protocol::AudioAttachmentRef {
                        content_digest: ash_protocol::ContentDigest::sha256(b"recording"),
                        media_type: ash_protocol::AudioMediaType::Wav, encoded_bytes: 32044, duration_ms: 1001,
                    },
                },
                ThreadItem::ToolCall {
                    item_id: ItemId::new("call-item").unwrap(),
                    turn_id: TurnId::new("turn").unwrap(),
                    tool_call_id: ToolCallId::new("call").unwrap(),
                    name: ToolName::new("shell-command").unwrap(),
                    arguments_json: r#"{"program":"/bin/sh","arguments":["-lc","cargo test"],"working_directory":"."}"#.to_owned(),
                    binding: None,
                },
                ThreadItem::ToolResult {
                    item_id: ItemId::new("result").unwrap(),
                    turn_id: TurnId::new("turn").unwrap(),
                    tool_call_id: ToolCallId::new("call").unwrap(),
                    text: r#"{"exit_code":0,"stdout":"42 passed\n","stderr":"","stdout_truncated":false,"stderr_truncated":false}"#.to_owned(),
                    content: None,
                    is_error: false,
                },
            ],
            plan: None,
            pending_interaction: None,
            error: Some(StableTurnError::model_invocation_failed()),
        }],
    };
    let mut transcript = TranscriptState::default();
    transcript.replace_snapshot(ThreadTranscriptSnapshot::from_thread(&thread));

    let timeline = ThreadTimeline::new(
        Rect::from_xywh(0.0, 0.0, 800.0, 600.0),
        &transcript,
        0,
        ThreadTimelineStyle::new(
            Color::rgb(246, 246, 247),
            Color::rgb(38, 38, 41),
            Color::rgb(126, 126, 132),
            Color::rgb(180, 38, 38),
        ),
    );
    assert_eq!(
        timeline.visible_text(),
        vec![
            "You",
            "run the tests",
            "You · Context",
            "README selection",
            "You · Audio",
            "audio/wav · 2 seconds",
            "Tool · shell-command",
            "$ cargo test",
            "42 passed",
            "Agent · Error",
            "Model invocation failed"
        ]
    );
}
