use super::App;
use super::AppCommand;
use super::frame::draw;
use crate::sessions::Command as SessionCommand;
use crate::sessions::Event as SessionEvent;
use crate::thread::Event as ThreadEvent;
use ash_protocol::Session;
use ash_protocol::SessionId;
use ash_protocol::SessionManagerInfo;
use ash_protocol::SessionManagerStatus;
use ash_protocol::SessionStatus;
use ash_protocol::SessionThread;
use ash_protocol::ThreadId;
use ash_protocol::ThreadStatus;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use ratatui::Terminal;
use ratatui::backend::TestBackend;

const WIDTH: u16 = 100;
const HEIGHT: u16 = 32;

#[test]
fn agents_manager_simulates_navigation_and_transient_details() {
    let mut app = active_session_app();

    assert_eq!(app.handle_key(key(KeyCode::Left)), None);
    assert!(app.session_manager_view().is_some());
    assert!(!app.session_manager_focused());
    crate::tui_assert_snapshot!("agents_manager_open_unfocused", render(&app));

    assert_eq!(app.handle_key(key(KeyCode::Up)), None);
    assert!(app.session_manager_focused());
    assert_eq!(
        app.session_manager_hint().text(),
        "Enter to open · Space to preview · Ctrl+X to archive · i to details · Esc to return"
    );

    assert_eq!(app.handle_key(key(KeyCode::Char('i'))), None);
    assert_eq!(app.overlay().unwrap().title(), "Session details");
    assert!(app.session_manager_view().is_some());
    let loading = render(&app);
    assert_eq!(loading.matches("Esc to close").count(), 1);
    assert!(!loading.contains("Enter to open"));
    crate::tui_assert_snapshot!("session_details_loading", loading);
    let (generation, session_id) = app.take_session_details_request().unwrap();
    assert_eq!(session_id, session().session_id);
    let root = &session().threads[0];
    let tree = serde_json::from_value(serde_json::json!({"roots":[{
        "threadId":root.thread_id, "threadSequence":1, "title":root.title,
        "executionStatus":"idle", "usage":ash_protocol::ModelUsageSummary::default()
    }]}))
    .unwrap();
    app.update(SessionEvent::DetailsReceived {
        generation,
        result: Ok(ash_app_server_protocol::protocol::session::SessionResult {
            session: session(),
            agent_tree: tree,
        }),
    });
    crate::tui_assert_snapshot!("agents_manager_transient_session_details", render(&app));

    let mut settings = crate::config::TerminalSettings::default();
    settings.set_screen_mode(crate::terminal::ScreenMode::Inline);
    app.update(crate::config::Event::SettingsReceived(settings));
    assert!(app.overlay().is_none());
    assert!(!app.session_manager_focused());
    assert!(app.session_manager_view().is_none());
    settings.set_screen_mode(crate::terminal::ScreenMode::Fullscreen);
    app.update(crate::config::Event::SettingsReceived(settings));
    assert!(app.overlay().is_some());
    assert!(app.session_manager_focused());
    assert_eq!(app.handle_key(key(KeyCode::Esc)), None);
    assert!(app.overlay().is_none());
    assert!(app.session_manager_focused());
    crate::tui_assert_snapshot!("agents_manager_after_preview_closed", render(&app));

    assert_eq!(app.handle_key(key(KeyCode::Esc)), None);
    assert!(app.session_manager_view().is_none());
    assert_eq!(app.screen_navigation_tip(), Some("← Dashboard"));
}

#[test]
fn resuming_selected_session_restores_manager_navigation() {
    let mut app = active_session_app();
    assert_eq!(app.handle_key(key(KeyCode::Left)), None);
    assert_eq!(app.handle_key(key(KeyCode::Up)), None);

    assert_eq!(
        app.handle_key(key(KeyCode::Enter)),
        Some(AppCommand::Sessions(SessionCommand::Resume {
            session_id: "current".into(),
            preferred_thread_id: Some(ThreadId::new("current").unwrap()),
        }))
    );
    app.update(ThreadEvent::ContextChanged {
        session_id: SessionId::new("current").unwrap(),
        thread_id: ThreadId::new("current").unwrap(),
    });

    app.show_conversation();
    assert!(!app.session_manager_focused());
    assert_eq!(app.screen_navigation_tip(), Some("← Dashboard"));
    crate::tui_assert_snapshot!(
        "agents_session_after_resume_restores_manager_tip",
        render(&app)
    );

    assert_eq!(app.handle_key(key(KeyCode::Left)), None);
    assert!(app.session_manager_view().is_some());
}

#[test]
fn dashboard_command_opens_the_manager() {
    let mut app = active_session_app();
    app.insert_text("/dashboard");

    assert!(app.completion().is_some());
    crate::tui_assert_snapshot!("dashboard_command_completion", render(&app));

    assert_eq!(app.handle_key(key(KeyCode::Enter)), None);
    assert!(app.session_manager_view().is_some());
    crate::tui_assert_snapshot!("dashboard_command_opened_manager", render(&app));

    assert_eq!(app.handle_key(key(KeyCode::Esc)), None);
    assert!(app.session_manager_view().is_none());
    assert_eq!(app.screen_navigation_tip(), Some("← Dashboard"));
}

#[test]
fn dashboard_escape_exits_from_focused_list_and_right_does_not_exit() {
    let mut app = active_session_app();
    assert_eq!(app.handle_key(key(KeyCode::Left)), None);
    assert!(app.session_manager_view().is_some());
    assert_eq!(app.session_manager_hint().text(), "Esc to return");
    assert_eq!(app.handle_key(key(KeyCode::Right)), None);
    assert!(app.session_manager_view().is_some());

    assert_eq!(app.handle_key(key(KeyCode::Up)), None);
    assert!(app.session_manager_focused());
    app.fullscreen.focus_page();
    assert!(!app.fullscreen.input_focused());
    assert!(app.session_manager_hint().text().ends_with("Esc to return"));
    assert_eq!(app.handle_key(key(KeyCode::Right)), None);
    assert!(app.session_manager_view().is_some());
    crate::tui_assert_snapshot!("dashboard_list_focused_before_escape", render(&app));

    assert_eq!(app.handle_key(key(KeyCode::Esc)), None);
    assert!(app.session_manager_view().is_none());
    assert!(!app.session_manager_focused());
    assert!(app.chat_input_focused());
    crate::tui_assert_snapshot!("dashboard_after_escape", render(&app));
}

#[test]
fn session_manager_preview_reads_conversation_and_restores_focus_without_editing() {
    let mut app = active_session_app();
    app.handle_key(key(KeyCode::Left));
    app.handle_key(key(KeyCode::Up));
    let draft = app.input().to_owned();
    let Some(AppCommand::Sessions(SessionCommand::Preview { generation, params })) =
        app.handle_key(key(KeyCode::Char(' ')))
    else {
        panic!("preview read expected")
    };
    assert_eq!(params.session_id.as_str(), "current");
    assert_eq!(params.thread_id.as_str(), "current");
    assert!(!app.accepts_input());
    crate::tui_assert_snapshot!("session_manager_preview_loading", render(&app));
    app.finish_session_preview(
        app.screen_mode(),
        generation,
        Ok(preview_result(0..35, false)),
    );
    crate::tui_assert_snapshot!("session_manager_preview_conversation", render(&app));
    for code in [
        KeyCode::Char('x'),
        KeyCode::Char('/'),
        KeyCode::Enter,
        KeyCode::Tab,
    ] {
        assert_eq!(app.handle_key(key(code)), None);
    }
    app.handle_paste("must not enter the draft".into());
    assert_eq!(app.input(), draft);
    assert_eq!(
        app.handle_key_in_area(
            key(KeyCode::PageUp),
            ratatui::layout::Rect::new(0, 0, WIDTH, HEIGHT)
        ),
        None
    );
    assert!(app.fullscreen.preview.scroll.anchor().is_some());
    crate::tui_assert_snapshot!("session_manager_preview_scrolled", render(&app));
    let preview_anchor = app.fullscreen.preview.scroll.anchor().cloned();
    let mut settings = crate::config::TerminalSettings::default();
    settings.set_screen_mode(crate::terminal::ScreenMode::Inline);
    app.update(crate::config::Event::SettingsReceived(settings));
    assert!(app.session_preview().is_none());
    assert!(app.inline.preview.scroll.anchor().is_none());
    app.handle_key(KeyEvent::new(KeyCode::Home, KeyModifiers::CONTROL));
    assert!(app.inline.preview.scroll.anchor().is_none());
    settings.set_screen_mode(crate::terminal::ScreenMode::Fullscreen);
    app.update(crate::config::Event::SettingsReceived(settings));
    assert_eq!(
        app.fullscreen.preview.scroll.anchor(),
        preview_anchor.as_ref()
    );
    assert_eq!(app.input(), draft);
    let background_anchor = app.transcript_scroll().anchor().cloned();
    app.handle_key(KeyEvent::new(KeyCode::End, KeyModifiers::CONTROL));
    assert!(app.fullscreen.preview.scroll.anchor().is_none());
    assert_eq!(app.transcript_scroll().anchor(), background_anchor.as_ref());
    app.handle_key(key(KeyCode::Esc));
    assert!(app.session_preview().is_none());
    assert!(app.session_manager_focused());
    assert_eq!(app.input(), draft);
    app.finish_session_preview(
        app.screen_mode(),
        generation,
        Ok(preview_result(0..1, false)),
    );
    assert!(app.session_preview().is_none());
    let Some(AppCommand::Sessions(SessionCommand::Preview {
        generation: next, ..
    })) = app.handle_key(key(KeyCode::Char(' ')))
    else {
        panic!("new preview expected")
    };
    assert_ne!(next, generation);
    app.finish_session_preview(app.screen_mode(), generation, Err("stale error".into()));
    assert_eq!(
        app.session_preview().unwrap().notice(),
        Some("Loading conversation…")
    );
    assert!(app.transcript_views().is_empty());
}

#[test]
fn session_manager_preview_loads_older_history_without_switching_the_active_thread() {
    let mut app = active_session_app();
    app.handle_key(key(KeyCode::Left));
    app.handle_key(key(KeyCode::Up));
    let Some(AppCommand::Sessions(SessionCommand::Preview { generation, .. })) =
        app.handle_key(key(KeyCode::Char(' ')))
    else {
        panic!("preview expected")
    };
    app.finish_session_preview(
        app.screen_mode(),
        generation,
        Ok(preview_result(10..15, true)),
    );
    let Some(AppCommand::Sessions(SessionCommand::Preview { params, .. })) =
        app.handle_key(key(KeyCode::Home))
    else {
        panic!("older history expected")
    };
    assert!(
        matches!(params.history, Some(ash_app_server_protocol::protocol::session::ThreadSnapshotHistory::Before { turn_id, .. }) if turn_id.as_str() == "turn-10")
    );
    assert_eq!(app.handle_key(key(KeyCode::Home)), None);
    app.finish_session_preview(
        app.screen_mode(),
        generation,
        Ok(preview_result(0..10, false)),
    );
    assert_eq!(app.session_preview().unwrap().messages().len(), 15);
    assert!(app.transcript_views().is_empty());
}

#[test]
fn session_manager_archived_group_restores_deletes_and_previews() {
    let mut app = active_session_app();
    let mut archived = session();
    archived.session_id = SessionId::new("archived").unwrap();
    archived.title = "Archived chat".into();
    archived.status = SessionStatus::Archived;
    archived.threads[0].thread_id = ThreadId::new("archived").unwrap();
    archived.threads[0].status = ThreadStatus::Archived;
    app.update(SessionEvent::CatalogReceived(vec![
        session(),
        archived.clone(),
    ]));
    app.handle_key(key(KeyCode::Left));
    assert!(!render(&app).contains("Archived chat"));
    app.handle_key(key(KeyCode::Up));
    app.handle_key(key(KeyCode::Down));
    assert!(
        app.session_manager_hint()
            .text()
            .contains("Enter to expand")
    );
    app.handle_key(key(KeyCode::Enter));
    app.handle_key(key(KeyCode::Down));
    crate::tui_assert_snapshot!("session_manager_archived_expanded", render(&app));
    assert_eq!(
        app.handle_key(key(KeyCode::Enter)),
        Some(
            SessionCommand::Restore {
                session_id: archived.session_id.clone()
            }
            .into()
        )
    );
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::CONTROL)),
        Some(
            SessionCommand::Delete {
                session_id: archived.session_id.clone()
            }
            .into()
        )
    );
    assert!(
        matches!(app.handle_key(key(KeyCode::Char(' '))), Some(AppCommand::Sessions(SessionCommand::Preview { params, .. })) if params.session_id == archived.session_id)
    );
    app.handle_key(key(KeyCode::Esc));
    archived.status = SessionStatus::Active;
    archived.threads[0].status = ThreadStatus::Active;
    app.update(SessionEvent::CatalogReceived(vec![session(), archived]));
    assert!(
        app.session_manager_hint()
            .text()
            .contains("Ctrl+X to archive")
    );
    assert!(render(&app).contains("Archived (0)"));
}

#[test]
fn session_manager_group_keys_collapse_expand_and_skip_hidden_sessions() {
    let mut app = active_session_app();
    app.handle_key(key(KeyCode::Left));
    app.handle_key(key(KeyCode::Up));
    app.handle_key(key(KeyCode::Up));
    assert!(
        app.session_manager_hint()
            .text()
            .contains("Enter to collapse")
    );
    assert!(render(&app).contains("> Idle (1)"));
    assert_eq!(app.handle_key(key(KeyCode::Enter)), None);
    assert!(
        app.session_manager_hint()
            .text()
            .contains("Enter to expand")
    );
    assert!(!render(&app).contains("Snapshot session"));
    assert!(app.session_preview().is_none());
    crate::tui_assert_snapshot!("session_manager_idle_collapsed", render(&app));

    app.update(SessionEvent::CatalogReceived(vec![session()]));
    assert!(
        app.session_manager_hint()
            .text()
            .contains("Enter to expand")
    );
    app.handle_key(key(KeyCode::Down));
    assert!(render(&app).contains("> Archived (0)"));
    app.handle_key(key(KeyCode::Up));
    assert_eq!(app.handle_key(key(KeyCode::Char(' '))), None);
    assert!(app.session_preview().is_none());
    assert!(render(&app).contains("Snapshot session"));
    crate::tui_assert_snapshot!("session_manager_idle_expanded", render(&app));

    for code in [KeyCode::Left, KeyCode::Left] {
        assert_eq!(app.handle_key(key(code)), None);
        assert!(!render(&app).contains("Snapshot session"));
    }
    for code in [KeyCode::Right, KeyCode::Right] {
        assert_eq!(app.handle_key(key(code)), None);
        assert!(render(&app).contains("Snapshot session"));
    }
    assert!(app.session_manager_focused());
    app.handle_key(key(KeyCode::Down));
    assert!(matches!(app.handle_key(key(KeyCode::Enter)),
        Some(AppCommand::Sessions(SessionCommand::Resume { session_id, .. })) if session_id == "current"));
}

fn preview_result(
    range: std::ops::Range<usize>,
    has_older_turns: bool,
) -> ash_app_server_protocol::protocol::session::SessionThreadReadResult {
    use ash_app_server_protocol::protocol::session::SessionThreadReadResult;
    use ash_app_server_protocol::protocol::session::ThreadHistoryBoundary;
    use ash_app_server_protocol::protocol::transcript::ThreadTranscriptEntry;
    use ash_app_server_protocol::protocol::transcript::ThreadTranscriptSnapshot;
    let thread = ash_protocol::Thread {
        agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
        origin: Default::default(),
        session_id: SessionId::new("current").unwrap(),
        thread_id: ThreadId::new("current").unwrap(),
        title: "Snapshot session".into(),
        status: ThreadStatus::Active,
        sequence: 42,
        parent_thread_id: None,
        forked_from_id: None,
        usage: Default::default(),
        reference_cost: Default::default(),
        goal: None,
        turns: vec![],
    };
    let boundary = ThreadHistoryBoundary {
        has_older_turns,
        oldest_turn_id: Some(ash_protocol::TurnId::new(format!("turn-{}", range.start)).unwrap()),
    };
    let entries = range
        .map(|index| {
            let turn_id = ash_protocol::TurnId::new(format!("turn-{index}")).unwrap();
            ThreadTranscriptEntry::Item {
                entry_id: format!("message-{index}"),
                turn_id: turn_id.clone(),
                transient: false,
                item: ash_protocol::ThreadItem::AgentMessage {
                    item_id: ash_protocol::ItemId::new(format!("item-{index}")).unwrap(),
                    turn_id,
                    text: format!(
                        "Conversation message {index:02}: content stays readable in preview."
                    ),
                },
            }
        })
        .collect();
    let transcript = ThreadTranscriptSnapshot {
        session_id: thread.session_id.clone(),
        thread_id: thread.thread_id.clone(),
        durable_sequence: 42,
        revision: 1,
        entries,
    };
    SessionThreadReadResult {
        thread,
        transcript,
        history: Some(boundary),
    }
}

#[test]
fn mode_switch_releases_thread_switcher_focus_before_restoring_transcript_focus() {
    for (target, other) in [
        (
            crate::terminal::ScreenMode::Fullscreen,
            crate::terminal::ScreenMode::Inline,
        ),
        (
            crate::terminal::ScreenMode::Inline,
            crate::terminal::ScreenMode::Fullscreen,
        ),
    ] {
        let mut app = active_session_app();
        let mut catalog = session();
        let mut child = catalog.threads[0].clone();
        child.thread_id = ThreadId::new("child").unwrap();
        child.parent_thread_id = Some(ThreadId::new("current").unwrap());
        child.title = "worker".into();
        catalog.threads.push(child);
        app.update(SessionEvent::CatalogReceived(vec![catalog]));
        app.update(ThreadEvent::FailureReported("selectable message".into()));
        let mut settings = crate::config::TerminalSettings::default();
        settings.set_screen_mode(target);
        app.update(crate::config::Event::SettingsReceived(settings));
        app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::CONTROL));
        assert!(app.transcript_selection_active());

        settings.set_screen_mode(other);
        app.update(crate::config::Event::SettingsReceived(settings));
        app.handle_key(key(KeyCode::Down));
        assert!(app.agent_thread_switcher_focused());

        settings.set_screen_mode(target);
        app.update(crate::config::Event::SettingsReceived(settings));
        assert!(!app.agent_thread_switcher_focused());
        assert!(app.transcript_selection_active());
    }
}

fn active_session_app() -> App {
    let mut app = App::new();
    app.update(ThreadEvent::ContextChanged {
        session_id: SessionId::new("current").unwrap(),
        thread_id: ThreadId::new("current").unwrap(),
    });
    app.update(SessionEvent::CatalogReceived(vec![session()]));
    app
}

fn session() -> Session {
    Session {
        session_id: SessionId::new("current").unwrap(),
        title: "Snapshot session".into(),
        status: SessionStatus::Active,
        manager: SessionManagerInfo {
            status: SessionManagerStatus::Idle,
            status_changed_at_unix_ms: 0,
            activity: None,
            summary: None,
        },
        threads: vec![SessionThread {
            thread_id: ThreadId::new("current").unwrap(),
            title: "main".into(),
            created_at_unix_ms: 0,
            completed_turn_duration_ms: 0,
            active_turn_started_at_unix_ms: None,
            usage: Default::default(),
            parent_thread_id: None,
            forked_from_id: None,
            status: ThreadStatus::Active,
        }],
    }
}

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

fn render(app: &App) -> String {
    let backend = TestBackend::new(WIDTH, HEIGHT);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|frame| draw(frame, app)).unwrap();
    let buffer = terminal.backend().buffer();
    (0..HEIGHT)
        .map(|row| {
            (0..WIDTH)
                .map(|column| buffer[(column, row)].symbol())
                .collect::<String>()
                .trim_end()
                .to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn manager_navigation_stays_focused_and_repeated_keys_cannot_open_or_modify_sessions() {
    let mut app = active_session_app();
    app.handle_key(key(KeyCode::Left));
    app.handle_key(key(KeyCode::Up));
    app.handle_key(key(KeyCode::Char('j')));
    assert!(app.session_manager_hint().text().contains("expand"));
    for _ in 0..3 {
        app.handle_key(key(KeyCode::Char('j')));
    }
    assert!(app.session_manager_focused());
    app.handle_key(key(KeyCode::Home));
    for code in [
        KeyCode::Enter,
        KeyCode::Char(' '),
        KeyCode::Char('p'),
        KeyCode::Char('i'),
        KeyCode::Esc,
    ] {
        assert_eq!(
            app.handle_key(KeyEvent::new_with_kind(
                code,
                KeyModifiers::NONE,
                crossterm::event::KeyEventKind::Repeat
            )),
            None
        );
    }
    assert_eq!(
        app.handle_key(KeyEvent::new_with_kind(
            KeyCode::Char('x'),
            KeyModifiers::CONTROL,
            crossterm::event::KeyEventKind::Repeat
        )),
        None
    );
    assert!(app.session_preview().is_none());
    assert!(app.overlay().is_none());
    assert!(app.session_manager_focused());
    assert_eq!(app.input(), "");
}

#[test]
fn empty_input_opens_agents_on_the_left_and_issues_on_the_right() {
    let mut app = active_session_app();
    app.handle_key(key(KeyCode::Left));
    assert!(app.session_manager_view().is_some());
    app.handle_key(key(KeyCode::Right));
    assert!(app.session_manager_view().is_some());
    app.handle_key(key(KeyCode::Esc));
    assert!(app.session_manager_view().is_none());
    super::fullscreen::navigation::activate_header_target(
        &mut app,
        super::fullscreen::header::Target::Dashboard,
    );
    assert!(app.session_manager_view().is_some());
    super::fullscreen::navigation::activate_header_target(
        &mut app,
        super::fullscreen::header::Target::Dashboard,
    );
    assert!(app.session_manager_view().is_none());
    let mut transcript = preview_result(0..1, false).transcript;
    if let ash_app_server_protocol::protocol::transcript::ThreadTranscriptEntry::Item {
        transient,
        ..
    } = &mut transcript.entries[0]
    {
        *transient = true;
    }
    app.update(ThreadEvent::TranscriptSnapshotReceived(transcript));
    assert!(!app.visible_transcript_views().is_empty());
    assert!(matches!(
        app.handle_key(key(KeyCode::Right)),
        Some(AppCommand::Issues(crate::issues::Command::List { .. }))
    ));
    assert!(app.issue_manager().is_some());
    app.handle_key(key(KeyCode::Esc));
    assert!(app.issue_manager().is_none());
    app.handle_key(key(KeyCode::Char('x')));
    app.handle_key(key(KeyCode::Right));
    assert!(app.issue_manager().is_none());
}
