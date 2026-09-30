use super::super::tests::app;
use super::super::tests::render;
use super::super::tests::text;
use super::Output;
use super::tail;
use crate::thread::Event as ThreadEvent;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptChange;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptEntry;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptSnapshot;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptUpdateEnvelope;
use ash_protocol::ItemId;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::TurnId;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
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

    let mut output = Output::default();
    output.select_thread(app.screen_thread_id());
    let pending = output.pending(&app);
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
fn inline_user_echo_committed_before_turn_start_is_not_drawn_again() {
    let mut app = app();
    app.insert_text("rebase");
    let Some(crate::app::AppCommand::Thread(crate::thread::Command::SubmitTurn { submission })) =
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
    else {
        panic!("expected one Turn submission");
    };
    assert_eq!(submission.display_text, "rebase");
    let mut output = Output::default();
    output.select_thread(app.screen_thread_id());
    assert!(output.pending(&app).is_empty());
    let turn_id = TurnId::new("turn").unwrap();
    let user = ThreadTranscriptEntry::Item {
        entry_id: "user".into(),
        turn_id: turn_id.clone(),
        item: ThreadItem::UserMessage {
            item_id: ItemId::new("user").unwrap(),
            turn_id: turn_id.clone(),
            text: "rebase".into(),
        },
        transient: false,
    };
    // Transcript notifications and the start-request completion use independent queues.
    app.update(ThreadEvent::TranscriptUpdateReceived(Box::new(
        ThreadTranscriptUpdateEnvelope {
            session_id: SessionId::new("session").unwrap(),
            thread_id: ThreadId::new("thread").unwrap(),
            durable_sequence: 1,
            revision: 1,
            stream_cursor: None,
            changes: vec![ThreadTranscriptChange::Upsert {
                entry: user.clone(),
            }],
        },
    )));
    let pending = output.pending(&app);
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].text(), "rebase");
    output.record(&pending[0]);
    app.set_active_turn(turn_id);
    assert_eq!(app.messages().len(), 1);
    assert_eq!(
        tail(&app).len(),
        1,
        "active-turn classification changed after the echo was printed"
    );
    assert!(
        output.tail(&app).is_empty(),
        "committed user echo reappeared in the live viewport"
    );
    // Stop the spinner for a deterministic frame while retaining the active Turn identity.
    app.update(ThreadEvent::TurnCompleted);
    let mut terminal = Terminal::new(TestBackend::new(60, 16)).unwrap();
    terminal
        .draw(|frame| output.draw_tail(frame, &app, &Default::default()))
        .unwrap();
    let rendered = text(terminal.backend().buffer());
    assert!(!rendered.contains("rebase"));
    crate::tui_assert_snapshot!("committed_user_echo_stays_out_of_live_viewport", rendered);
    app.update(ThreadEvent::TranscriptSnapshotReceived(snapshot(vec![
        user,
    ])));
    assert!(output.pending(&app).is_empty());
    assert!(output.tail(&app).is_empty());
    app.clear_active_turn();
    assert!(output.pending(&app).is_empty());
}

#[test]
fn inline_history_commits_final_blocks_once_and_keeps_the_active_turn_live() {
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
    let rendered = text(&render(&app, 60, 24));
    assert!(!rendered.contains("Earlier completed answer"));
    assert!(rendered.contains("当前回复"));
    crate::tui_assert_snapshot!("current_reply", rendered);
    app.clear_active_turn();
    app.update(ThreadEvent::TranscriptSnapshotReceived(snapshot(vec![
        old, current,
    ])));
    let pending = output.pending(&app);
    assert_eq!(pending.len(), 1);
    assert!(pending[0].text().starts_with("当前回复"));
    output.record(&pending[0]);
    app.update(ThreadEvent::TranscriptSnapshotReceived(snapshot(vec![
        entry("old", "Earlier completed answer", false),
        entry("current", "当前回复\n\n- 第一项\n- 第二项", false),
    ])));
    assert!(output.pending(&app).is_empty());
    app.update(ThreadEvent::TranscriptHistoryPageReceived(snapshot(vec![
        entry("older", "Older page", false),
    ])));
    assert!(output.pending(&app).is_empty());
}
