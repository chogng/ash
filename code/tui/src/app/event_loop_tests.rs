use crate::app::App;
use crate::app::AppCommand;
use crate::app::AppEvent;
use crate::app::fullscreen::pointer::handle_mouse;
use crate::thread::Event as ThreadEvent;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionModel;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use crossterm::event::MouseButton;
use crossterm::event::MouseEvent;
use crossterm::event::MouseEventKind;

// Run under a PTY so TerminalSession emits the actual mouse-mode protocol.
#[test]
#[ignore = "requires a PTY with a nonzero window size"]
fn real_terminal_mouse_handoff() {
    let mut output = crate::app::inline::Output::default();
    let mut terminal =
        crate::terminal::TerminalSession::open(crate::terminal::ScreenMode::Fullscreen).unwrap();
    let area = terminal.area().unwrap();
    assert!(area.width >= 40 && area.height >= 12);
    let mut app = App::new();
    app.update(AppEvent::HelpOpened(ListSelectionModel::new(
        "Help",
        vec![ListSelectionGroup::new(
            "Commands",
            vec![ListSelectionItem::new("Help")],
        )],
    )));
    super::draw_terminal(&mut terminal, &mut app, &mut output).unwrap();
    assert_eq!(app.mouse_mode(), crate::terminal::MouseMode::TuiCapture);
    assert!(app.command_panel().is_some());
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    app.insert_text("/q");
    super::draw_terminal(&mut terminal, &mut app, &mut output).unwrap();
    let area = terminal.area().unwrap();
    let (column, row) = (area.y..area.bottom())
        .flat_map(|row| (0..area.width).map(move |column| (column, row)))
        .find(|(column, row)| {
            matches!(
                crate::app::fullscreen::pointer::target_at(&app, area, *column, *row),
                Some(crate::app::fullscreen::pointer::PointerTarget::Composer(
                    crate::thread::composer::ChatComposerPointerTarget::CompletionItem(0)
                ))
            )
        })
        .unwrap();
    let event = |kind| MouseEvent {
        kind,
        column,
        row,
        modifiers: KeyModifiers::NONE,
    };
    handle_mouse(
        &mut app,
        area,
        event(MouseEventKind::Down(MouseButton::Left)),
    );
    let super::MouseAction::Selection(outcome) =
        handle_mouse(&mut app, area, event(MouseEventKind::Up(MouseButton::Left)))
    else {
        panic!("pointer release must finish screen selection")
    };
    assert_eq!(
        super::finish_pointer_gesture(&mut app, &terminal, outcome).unwrap(),
        Some(AppCommand::Quit)
    );
    super::draw_terminal(&mut terminal, &mut app, &mut output).unwrap();
    app.insert_text("/q");
    super::draw_terminal(&mut terminal, &mut app, &mut output).unwrap();
    let mut settings = crate::config::TerminalSettings::default();
    settings.set_screen_mode(crate::terminal::ScreenMode::Inline);
    app.update(crate::config::Event::SettingsReceived(settings));
    super::draw_terminal(&mut terminal, &mut app, &mut output).unwrap();
    assert_eq!(app.mouse_mode(), crate::terminal::MouseMode::TuiCapture);
    assert!(app.fullscreen.pointer.hovered().is_none());
    assert!(app.fullscreen.pointer.pressed().is_none());
    assert!(app.fullscreen.selection.range().is_none());
    assert_eq!(app.input(), "/q");
    let inline_area = terminal.area().unwrap();
    let inline_input = crate::app::inline::layout(&app, inline_area).input;
    let row = inline_input.y + 1;
    let pointer = |kind, column| MouseEvent {
        kind,
        column,
        row,
        modifiers: KeyModifiers::NONE,
    };
    crate::app::inline::pointer::handle_mouse(
        &mut app,
        inline_area,
        pointer(MouseEventKind::Down(MouseButton::Left), inline_input.x + 3),
    );
    let outcome = crate::app::inline::pointer::handle_mouse(
        &mut app,
        inline_area,
        pointer(MouseEventKind::Up(MouseButton::Left), inline_input.x + 4),
    );
    assert!(matches!(
        outcome,
        super::MouseAction::InputSelection(ref text) if text == "q"
    ));
    assert_eq!(app.input_state().selection_range(), Some(1..2));
}

#[test]
fn streaming_commit_deadlines_are_serviced_during_continuous_input_and_completion() {
    use super::RedrawPriority;
    use super::RedrawScheduler;
    use super::advance_stream;
    use super::next_wait;
    use ash_app_server_protocol::protocol::transcript::ThreadTranscriptChange;
    use ash_app_server_protocol::protocol::transcript::ThreadTranscriptEntry;
    use ash_app_server_protocol::protocol::transcript::ThreadTranscriptUpdateEnvelope;
    use ash_protocol::ItemId;
    use ash_protocol::ThreadItem;
    use ash_protocol::TurnId;
    use std::time::Duration;

    let mut app = App::new();
    let turn_id = TurnId::new("stream").unwrap();
    app.set_active_turn(turn_id.clone());
    app.update(ThreadEvent::TranscriptUpdateReceived(Box::new(
        ThreadTranscriptUpdateEnvelope {
            session_id: SessionId::new("session").unwrap(),
            thread_id: ThreadId::new("thread").unwrap(),
            durable_sequence: 1,
            revision: 1,
            stream_cursor: None,
            changes: vec![ThreadTranscriptChange::Upsert {
                entry: ThreadTranscriptEntry::Item {
                    entry_id: "stream-item".into(),
                    turn_id: turn_id.clone(),
                    transient: true,
                    item: ThreadItem::AgentMessage {
                        item_id: ItemId::new("item").unwrap(),
                        turn_id,
                        text: "one\ntwo\nthree\nfour".into(),
                    },
                },
            }],
        },
    )));
    let mut redraw = RedrawScheduler::default();
    let start = app.stream_deadline().unwrap();
    assert_eq!(next_wait(&app, &redraw, start), Some(Duration::ZERO));
    advance_stream(&mut app, &mut redraw, start);
    assert_eq!(app.visible_transcript_views()[0].text(), "one\n");
    assert!(redraw.take_due(start));
    assert_eq!(
        next_wait(&app, &redraw, start),
        Some(Duration::from_millis(40))
    );
    for elapsed in 1..=40 {
        let now = start + Duration::from_millis(elapsed);
        app.insert_text("x");
        redraw.request(now, RedrawPriority::Immediate);
        advance_stream(&mut app, &mut redraw, now);
        assert!(redraw.take_due(now));
    }
    assert_eq!(app.visible_transcript_views()[0].text(), "one\ntwo\n");
    assert_eq!(app.latest_agent_response(), Some("one\ntwo\nthree\nfour"));
    app.update(ThreadEvent::TurnCompleted);
    assert!(matches!(app.status(), crate::app::Status::Ready));
    assert!(app.stream_deadline().is_none());
    assert_eq!(
        app.visible_transcript_views()[0].text(),
        "one\ntwo\nthree\nfour"
    );
}
