use super::super::tests::app;
use super::super::tests::render;
use super::super::tests::text;
use crate::thread::Event as ThreadEvent;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptEntry;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptSnapshot;
use ash_protocol::ItemId;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::TurnId;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;

#[test]
fn unknown_slash_command_is_visible_in_inline_conversation() {
    let mut app = app();
    app.insert_text("/confg");
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        None
    );

    let pending = app.visible_transcript_views();
    assert_eq!(pending.len(), 1);
    assert_eq!(
        pending[0].text(),
        "Unknown command: /confg. Did you mean /config?"
    );
    let mut buffer = Buffer::empty(Rect::new(0, 0, 80, 1));
    pending[0].render_rows(
        &mut buffer,
        0,
        app.render_context(),
        app.transcript_render_cache(),
    );
    crate::tui_assert_snapshot!("unknown_slash_command", text(&buffer));
}

fn entry(id: &str, text: &str, transient: bool) -> ThreadTranscriptEntry {
    let turn_id = TurnId::new(id).unwrap();
    ThreadTranscriptEntry::Item {
        entry_id: id.into(),
        turn_id: turn_id.clone(),
        item: ThreadItem::AgentMessage {
            item_id: ItemId::new(id).unwrap(),
            turn_id,
            text: text.into(),
        },
        transient,
    }
}

fn snapshot(entries: Vec<ThreadTranscriptEntry>) -> ThreadTranscriptSnapshot {
    ThreadTranscriptSnapshot {
        session_id: SessionId::new("session").unwrap(),
        thread_id: ThreadId::new("thread").unwrap(),
        durable_sequence: 1,
        revision: 1,
        entries,
    }
}

#[test]
fn inline_transcript_keeps_completed_and_active_turns_together() {
    let mut app = app();
    let old = entry("old", "Earlier completed answer", false);
    let current = entry("current", "当前回复\n\n- 第一项\n- 第二项", false);
    app.update(ThreadEvent::TranscriptSnapshotReceived(snapshot(vec![
        old.clone(),
        current.clone(),
    ])));
    app.set_active_turn(TurnId::new("current").unwrap());
    let rendered = text(&render(&app, 60, 24));
    let earlier_row = rendered
        .lines()
        .position(|line| line.contains("Earlier completed answer"))
        .unwrap();
    let current_row = rendered
        .lines()
        .position(|line| line.contains("当前回复"))
        .unwrap();
    assert!(current_row - earlier_row <= 4, "{rendered}");
    crate::tui_assert_snapshot!("current_reply", rendered);
    app.clear_active_turn();
    app.update(ThreadEvent::TranscriptSnapshotReceived(snapshot(vec![
        old, current,
    ])));
    let resynchronized = text(&render(&app, 60, 24));
    assert_eq!(
        resynchronized.matches("Earlier completed answer").count(),
        1
    );
    assert_eq!(resynchronized.matches("当前回复").count(), 1);
    app.update(ThreadEvent::TranscriptHistoryPageReceived(snapshot(vec![
        entry("older", "Older page", false),
    ])));
    assert!(text(&render(&app, 60, 24)).contains("Older page"));
}
