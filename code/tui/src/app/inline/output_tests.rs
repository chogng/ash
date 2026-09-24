use super::super::browsing;
use super::super::tests::app;
use super::super::tests::render;
use super::super::tests::text;
use super::Output;
use super::tail;
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
use ratatui::layout::Rect;

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
fn transcript_retains_active_turn_until_completion_and_emits_once() {
    let mut app = app();
    let old = entry("old", "Earlier completed answer", false);
    let current = entry("current", "当前回复\n\n- 第一项\n- 第二项", false);
    app.update(ThreadEvent::TranscriptSnapshotReceived(snapshot(vec![
        old.clone(),
        current.clone(),
    ])));
    app.set_active_turn(TurnId::new("current").unwrap());
    let mut output = Output::default();
    output.select_thread(app.screen_thread_id());
    let pending = output.pending(&app);
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].text(), "Earlier completed answer");
    output.record(&pending[0]);
    assert!(output.pending(&app).is_empty());
    assert_eq!(tail(&app).len(), 1);
    crate::tui_assert_snapshot!("current_reply", text(&render(&app, 60, 24)));
    app.clear_active_turn();
    let pending = output.pending(&app);
    assert_eq!(pending.len(), 1);
    assert!(pending[0].text().starts_with("当前回复"));
    output.record(&pending[0]);
    app.update(ThreadEvent::TranscriptSnapshotReceived(snapshot(vec![
        old, current,
    ])));
    assert!(
        output.pending(&app).is_empty(),
        "resynchronization must not duplicate history"
    );
    assert!(tail(&app).is_empty());
    app.update(ThreadEvent::TranscriptHistoryPageReceived(snapshot(vec![
        entry("older", "Older page", false),
    ])));
    assert!(
        output.pending(&app).is_empty(),
        "older pages must not be appended out of order"
    );
    assert!(tail(&app).is_empty());
    app.handle_key_in_area(
        KeyEvent::new(KeyCode::Home, KeyModifiers::CONTROL),
        Rect::new(0, 0, 60, 24),
    );
    assert!(browsing(&app));
    assert!(text(&render(&app, 60, 24)).contains("Older page"));
    app.handle_key_in_area(
        KeyEvent::new(KeyCode::End, KeyModifiers::CONTROL),
        Rect::new(0, 0, 60, 24),
    );
    assert!(!browsing(&app));
}
