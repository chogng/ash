use super::App;
use crate::TuiStartupContext;
use crate::thread::Event as ThreadEvent;
use crate::thread::composer::ChatInputCatalog;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptChange;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptEntry;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptSnapshot;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptUpdateEnvelope;
use ash_protocol::ItemId;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::TurnId;

#[test]
fn completed_streamed_mermaid_block_is_ready_before_rendering() {
    let profile = tempfile::tempdir().unwrap();
    let mut context = TuiStartupContext::new(profile.path());
    context.profile_root = Some(profile.path().to_path_buf());
    let mut app = App::for_dir_with_input_catalog_and_startup_context(
        profile.path(),
        ChatInputCatalog::default(),
        context,
    );
    let session_id = SessionId::new("tui-session").unwrap();
    let thread_id = ThreadId::new("tui-local").unwrap();
    app.update(ThreadEvent::ContextChanged {
        session_id: session_id.clone(),
        thread_id: thread_id.clone(),
    });
    let turn_id = TurnId::new("mermaid-turn").unwrap();
    let item_id = ItemId::new("mermaid-item").unwrap();
    app.update(ThreadEvent::TranscriptSnapshotReceived(
        ThreadTranscriptSnapshot {
            session_id: session_id.clone(),
            thread_id: thread_id.clone(),
            durable_sequence: 1,
            revision: 1,
            entries: vec![ThreadTranscriptEntry::Item {
                entry_id: "item:mermaid-item".into(),
                turn_id: turn_id.clone(),
                item: ThreadItem::AgentMessage {
                    item_id: item_id.clone(),
                    turn_id: turn_id.clone(),
                    text: "```mermaid\nflowchart LR\nA --> B".into(),
                },
                transient: false,
            }],
        },
    ));
    assert!(
        app.render_context()
            .mermaid_preview_url("flowchart LR\nA --> B\n")
            .is_none()
    );
    app.update(ThreadEvent::TranscriptUpdateReceived(Box::new(
        ThreadTranscriptUpdateEnvelope {
            session_id,
            thread_id,
            durable_sequence: 2,
            revision: 2,
            stream_cursor: None,
            changes: vec![ThreadTranscriptChange::Upsert {
                entry: ThreadTranscriptEntry::Item {
                    entry_id: "item:mermaid-item".into(),
                    turn_id: turn_id.clone(),
                    item: ThreadItem::AgentMessage {
                        item_id,
                        turn_id,
                        text: "```mermaid\nflowchart LR\nA --> B\n```".into(),
                    },
                    transient: false,
                },
            }],
        },
    )));
    assert!(
        app.render_context()
            .mermaid_preview_url("flowchart LR\nA --> B\n")
            .is_some()
    );
}
