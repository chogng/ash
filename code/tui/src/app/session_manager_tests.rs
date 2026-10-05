use super::App;
use super::AppCommand;
use super::frame::draw;
use crate::keymap::KeyEvent;
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
use crossterm::event::KeyModifiers;
use ratatui::Terminal;
use ratatui::backend::TestBackend;

const WIDTH: u16 = 100;
const HEIGHT: u16 = 32;

#[test]
fn dashboard_empty_input_entry_and_escape_restore_home_and_conversation_in_both_modes() {
    let mut snapshots = Vec::new();
    for mode in [
        crate::terminal::ScreenMode::Fullscreen,
        crate::terminal::ScreenMode::Inline,
    ] {
        for home in [false, true] {
            let mut app = active_session_app();
            let mut settings = crate::config::TerminalSettings::default();
            settings.set_screen_mode(mode);
            settings.set_language(crate::nls::Language::Chinese);
            app.update(crate::config::Event::SettingsReceived(settings));
            if home {
                app.open_home();
            }
            let starts_new_session = app.starts_new_session();
            assert_eq!(starts_new_session, home);
            assert!(app.chat_input_focused());
            assert!(app.can_open_dashboard_from_input());
            assert!(
                dashboard_hintline(&app)
                    .replace(' ', "")
                    .contains("←仪表盘")
            );
            let buffer = render_buffer(&app, WIDTH, HEIGHT);
            let hint_key = buffer
                .content
                .iter()
                .find(|cell| cell.symbol() == "←")
                .unwrap();
            assert_eq!(hint_key.fg, app.render_context().foreground());
            assert!(hint_key.modifier.contains(ratatui::style::Modifier::BOLD));
            // The entry remains available after transient tips expire.
            app.handle_tick(std::time::Instant::now() + std::time::Duration::from_secs(60));
            assert!(
                dashboard_hintline(&app)
                    .replace(' ', "")
                    .contains("←仪表盘")
            );
            let mut frames = vec![format!("Before entry\n{}", render(&app))];
            assert_eq!(app.handle_key(key(KeyCode::Left)), None);
            assert!(app.session_manager_view().is_some());
            assert!(app.session_manager_focused());
            assert!(!app.fullscreen_home_visible());
            frames.push(format!("Dashboard\n{}", render(&app)));
            assert_eq!(app.handle_key(key(KeyCode::Esc)), None);
            assert!(app.session_manager_view().is_none());
            assert!(app.chat_input_focused());
            assert_eq!(app.starts_new_session(), starts_new_session);
            app.handle_key(key(KeyCode::Char('x')));
            assert_eq!(app.input(), "x");
            assert!(!app.can_open_dashboard_from_input());
            assert!(
                !dashboard_hintline(&app)
                    .replace(' ', "")
                    .contains("←仪表盘")
            );
            frames.push(format!("Returned and typing\n{}", render(&app)));
            snapshots.push(format!("{mode:?} · home={home}\n{}", frames.join("\n\n")));
        }
    }
    crate::tui_assert_snapshot!(
        "dashboard_entry_and_return_in_both_modes",
        snapshots.join("\n\n")
    );
}

#[test]
fn dashboard_entry_keeps_text_attachments_and_home_menu_keys_with_their_owner() {
    let mut snapshots = Vec::new();
    for mode in [
        crate::terminal::ScreenMode::Fullscreen,
        crate::terminal::ScreenMode::Inline,
    ] {
        for home in [false, true] {
            let mut app = active_session_app();
            let mut settings = crate::config::TerminalSettings::default();
            settings.set_screen_mode(mode);
            app.update(crate::config::Event::SettingsReceived(settings));
            if home {
                app.open_home();
            }
            app.insert_text("draft");
            app.handle_key(key(KeyCode::Home));
            app.handle_key(key(KeyCode::Left));
            assert!(app.session_manager_view().is_none());
            assert_eq!(app.input(), "draft");
            assert!(!app.can_open_dashboard_from_input());
            app.handle_key(key(KeyCode::End));
            for _ in 0..5 {
                app.handle_key(key(KeyCode::Backspace));
            }
            assert_eq!(app.input(), "");
            app.update(crate::host::Event::ClipboardImageRead {
                target: app.draft_target(),
                result: Ok(crate::host::clipboard::ClipboardImage {
                    png: b"\x89PNG\r\n\x1a\npayload".to_vec(),
                    fingerprint: crate::host::clipboard::ClipboardImageFingerprint(1),
                    width: 1,
                    height: 1,
                }),
            });
            assert!(!app.input_state().is_empty());
            assert!(!app.can_open_dashboard_from_input());
            assert_eq!(app.handle_key(key(KeyCode::Left)), None);
            assert!(app.session_manager_view().is_none());
            assert!(render(&app).contains("[Image #1]"));
            snapshots.push(format!("{mode:?} · home={home}\n{}", render(&app)));
        }
    }
    let mut app = active_session_app();
    app.open_home();
    app.handle_key(key(KeyCode::Tab));
    assert!(!app.chat_input_focused());
    assert!(!app.can_open_dashboard_from_input());
    app.handle_key(key(KeyCode::Left));
    assert!(app.session_manager_view().is_none());
    assert!(!app.chat_input_focused());
    assert!(
        render(&app)
            .lines()
            .last()
            .unwrap()
            .contains("Enter select")
    );
    crate::tui_assert_snapshot!(
        "dashboard_attachments_keep_input_in_both_modes",
        snapshots.join("\n\n")
    );
}

#[test]
fn dashboard_startup_entry_returns_to_the_empty_new_task_input() {
    let mut frames = Vec::new();
    for mode in [
        crate::terminal::ScreenMode::Fullscreen,
        crate::terminal::ScreenMode::Inline,
    ] {
        let mut app = App::for_dir_with_input_catalog_and_startup_context(
            std::path::Path::new("."),
            crate::thread::composer::ChatInputCatalog::default(),
            crate::TuiStartupContext::new("."),
        );
        let mut settings = crate::config::TerminalSettings::default();
        settings.set_screen_mode(mode);
        app.update(crate::config::Event::SettingsReceived(settings));
        app.open_home();
        assert!(app.sessions.active_session_id().is_none());
        assert!(app.can_open_dashboard_from_input());
        frames.push(format!("{mode:?} initial page\n{}", render(&app)));
        assert_eq!(app.handle_key(key(KeyCode::Left)), None);
        assert!(app.session_manager_view().is_some());
        assert!(app.session_manager_focused());
        assert_eq!(app.handle_key(key(KeyCode::Esc)), None);
        assert!(app.session_manager_view().is_none());
        assert!(app.starts_new_session());
        assert!(app.chat_input_focused());
        assert!(app.can_open_dashboard_from_input());
        frames.push(format!("{mode:?} after Escape\n{}", render(&app)));
    }
    crate::tui_assert_snapshot!("dashboard_startup_entry_and_return", frames.join("\n\n"));
}

#[test]
fn dashboard_simulates_navigation_and_transient_details() {
    let mut app = active_session_app();

    assert_eq!(app.handle_key(key(KeyCode::Left)), None);
    assert!(app.session_manager_view().is_some());
    assert!(app.session_manager_focused());
    crate::tui_assert_snapshot!(app = &app; "dashboard_open_focused", render(&app));
    assert!(app.session_manager_focused());
    assert_eq!(
        app.session_manager_hint().text(),
        "Enter/→ to open · Space to preview · Ctrl+X to archive · i to details · g to group · Esc to return"
    );

    assert_eq!(app.handle_key(key(KeyCode::Char('i'))), None);
    assert_eq!(app.overlay().unwrap().title(), "Session details");
    assert!(app.session_manager_view().is_some());
    let loading = render(&app);
    assert_eq!(loading.matches("Esc to close").count(), 1);
    assert!(!loading.contains("Enter/→ to open"));
    crate::tui_assert_snapshot!(app = &app; "session_details_loading", loading);
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
    crate::tui_assert_snapshot!(app = &app; "agents_manager_transient_session_details", render(&app));

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
    crate::tui_assert_snapshot!(app = &app; "agents_manager_after_preview_closed", render(&app));

    assert_eq!(app.handle_key(key(KeyCode::Esc)), None);
    assert!(app.session_manager_view().is_none());
    assert!(app.can_open_dashboard_from_input());
}

#[test]
fn resuming_selected_session_restores_manager_navigation() {
    let mut app = active_session_app();
    assert_eq!(app.handle_key(key(KeyCode::Left)), None);

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
    assert!(app.can_open_dashboard_from_input());
    crate::tui_assert_snapshot!(
        app = &app;
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
    crate::tui_assert_snapshot!(app = &app; "dashboard_command_completion", render(&app));

    assert_eq!(app.handle_key(key(KeyCode::Enter)), None);
    assert!(app.session_manager_view().is_some());
    crate::tui_assert_snapshot!(app = &app; "dashboard_command_opened_manager", render(&app));

    assert_eq!(app.handle_key(key(KeyCode::Esc)), None);
    assert!(app.session_manager_view().is_none());
    assert!(app.can_open_dashboard_from_input());
}

#[test]
fn dashboard_escape_exits_from_focused_list() {
    let mut app = active_session_app();
    assert_eq!(app.handle_key(key(KeyCode::Left)), None);
    assert!(app.session_manager_view().is_some());
    assert!(app.session_manager_hint().text().ends_with("Esc to return"));

    assert!(app.session_manager_focused());
    app.handle_key(key(KeyCode::F(6)));
    assert!(app.fullscreen.header_focused());
    let footer = render(&app).lines().last().unwrap().to_owned();
    assert!(footer.contains("←→ select"));
    assert!(!footer.contains("g to group"));
    app.handle_key(key(KeyCode::Tab));
    assert!(app.session_manager_focused());
    assert!(!app.fullscreen.input_focused());
    assert!(app.session_manager_hint().text().ends_with("Esc to return"));
    crate::tui_assert_snapshot!(app = &app; "dashboard_list_focused_before_escape", render(&app));

    assert_eq!(app.handle_key(key(KeyCode::Esc)), None);
    assert!(app.session_manager_view().is_none());
    assert!(!app.session_manager_focused());
    assert!(app.chat_input_focused());
    crate::tui_assert_snapshot!(app = &app; "dashboard_after_escape", render(&app));
}

#[test]
fn dashboard_enter_and_right_open_the_selected_session_in_both_modes() {
    for mode in [
        crate::terminal::ScreenMode::Fullscreen,
        crate::terminal::ScreenMode::Inline,
    ] {
        for home in [false, true] {
            for open_key in [KeyCode::Right, KeyCode::Enter] {
                let mut app = active_session_app();
                let mut selected = session();
                selected.session_id = SessionId::new("selected").unwrap();
                selected.title = "Selected conversation".into();
                selected.threads[0].thread_id = ThreadId::new("selected-child").unwrap();
                app.update(SessionEvent::CatalogReceived(vec![session(), selected]));
                app.update(ThreadEvent::ContextChanged {
                    session_id: SessionId::new("selected").unwrap(),
                    thread_id: ThreadId::new("selected-child").unwrap(),
                });
                app.update(ThreadEvent::ContextChanged {
                    session_id: SessionId::new("current").unwrap(),
                    thread_id: ThreadId::new("current").unwrap(),
                });
                let mut settings = crate::config::TerminalSettings::default();
                settings.set_screen_mode(mode);
                settings.set_language(crate::nls::Language::Chinese);
                app.update(crate::config::Event::SettingsReceived(settings));
                if home {
                    app.open_home();
                }
                assert_eq!(app.handle_key(key(KeyCode::Left)), None);
                assert_eq!(app.handle_key(key(KeyCode::Down)), None);
                assert!(app.session_manager_focused());
                assert_eq!(
                    app.handle_key(key(open_key)),
                    Some(AppCommand::Sessions(SessionCommand::Resume {
                        session_id: "selected".into(),
                        preferred_thread_id: Some(ThreadId::new("selected-child").unwrap()),
                    }))
                );
                let before = render(&app);
                assert!(before.replace(' ', "").contains("Enter/→打开"));
                app.update(ThreadEvent::ContextChanged {
                    session_id: SessionId::new("selected").unwrap(),
                    thread_id: ThreadId::new("selected-child").unwrap(),
                });
                app.show_conversation();
                assert!(app.session_manager_view().is_none());
                assert!(!app.session_manager_focused());
                assert!(app.chat_input_focused());
                assert!(!app.starts_new_session());
                assert_eq!(
                    app.sessions.active_session_id().unwrap().as_str(),
                    "selected"
                );
                assert_eq!(app.screen_thread_id().as_str(), "selected-child");
                assert!(app.can_open_dashboard_from_input());
                crate::tui_assert_snapshot!(
                    app = &app;
                    "dashboard_open_selected_session",
                    format!("Dashboard\n{before}\n\nOpened selected conversation\n{}", render(&app))
                );
                assert_eq!(app.handle_key(key(KeyCode::Left)), None);
                assert!(app.session_manager_focused());
                assert_eq!(app.handle_key(key(KeyCode::Esc)), None);
                assert!(app.session_manager_view().is_none());
                assert!(app.chat_input_focused());
            }
        }
    }
}

#[test]
fn inline_dashboard_arrows_keep_group_preview_and_detail_interactions() {
    let mut app = active_session_app();
    let mut settings = crate::config::TerminalSettings::default();
    settings.set_screen_mode(crate::terminal::ScreenMode::Inline);
    app.update(crate::config::Event::SettingsReceived(settings));
    app.handle_key(key(KeyCode::Left));
    app.handle_key(key(KeyCode::Up));
    assert!(
        app.session_manager_hint()
            .text()
            .contains("Enter/← to collapse")
    );
    assert!(!app.session_manager_hint().text().contains("→/Esc"));
    app.handle_key(key(KeyCode::Left));
    assert!(!render(&app).contains("Snapshot session"));
    for _ in 0..2 {
        assert_eq!(app.handle_key(key(KeyCode::Right)), None);
        assert!(app.session_manager_view().is_some());
        assert!(render(&app).contains("Snapshot session"));
    }
    app.handle_key(key(KeyCode::Down));
    assert!(matches!(
        app.handle_key(key(KeyCode::Char(' '))),
        Some(AppCommand::Sessions(SessionCommand::Preview { .. }))
    ));
    assert_eq!(app.handle_key(key(KeyCode::Right)), None);
    assert!(app.session_preview().is_some());
    app.handle_key(key(KeyCode::Esc));
    assert!(app.session_manager_focused());
    app.handle_key(key(KeyCode::Char('i')));
    assert!(app.overlay().is_some());
    assert_eq!(app.handle_key(key(KeyCode::Right)), None);
    assert!(app.overlay().is_some());
    app.handle_key(key(KeyCode::Esc));
    assert!(app.session_manager_focused());
    assert_eq!(
        app.handle_key(key(KeyCode::Right)),
        Some(AppCommand::Sessions(SessionCommand::Resume {
            session_id: "current".into(),
            preferred_thread_id: Some(ThreadId::new("current").unwrap()),
        }))
    );
}

#[test]
fn dashboard_preserves_the_conversation_draft_and_blocks_background_input() {
    for mode in [
        crate::terminal::ScreenMode::Fullscreen,
        crate::terminal::ScreenMode::Inline,
    ] {
        let mut app = active_session_app();
        let mut settings = crate::config::TerminalSettings::default();
        settings.set_screen_mode(mode);
        app.update(crate::config::Event::SettingsReceived(settings));
        app.insert_text("draft");
        app.show_session_manager();
        assert!(app.session_manager_focused());
        assert!(!app.accepts_input());
        app.handle_key(key(KeyCode::Char('X')));
        app.handle_paste("paste".into());
        assert_eq!(app.input(), "draft");
        assert!(!render(&app).contains("draft"));
        crate::tui_assert_snapshot!(app = &app; "dashboard_preserves_hidden_draft", render(&app));
        app.handle_key(key(KeyCode::Esc));
        assert!(app.chat_input_focused());
        app.handle_key(key(KeyCode::Home));
        app.handle_key(key(KeyCode::Right));
        app.insert_text("X");
        assert_eq!(app.input(), "dXraft");
    }
}

#[test]
fn dashboard_open_is_discoverable_in_localized_help() {
    let mut app = active_session_app();
    let mut settings = crate::config::TerminalSettings::default();
    settings.set_screen_mode(crate::terminal::ScreenMode::Inline);
    settings.set_language(crate::nls::Language::Chinese);
    app.update(crate::config::Event::SettingsReceived(settings));
    app.insert_text("/help");
    app.handle_key(key(KeyCode::Enter));
    app.handle_key(key(KeyCode::Char('/')));
    app.handle_paste("仪表盘".into());
    let output = render(&app);
    assert!(output.contains("Enter/→"));
    assert!(output.replace(' ', "").contains("打开仪表盘中选中的会话"));
    crate::tui_assert_snapshot!(app = &app; "dashboard_open_help_chinese", output);
}

#[test]
fn session_manager_preview_reads_conversation_and_restores_focus_without_editing() {
    let mut app = active_session_app();
    app.handle_key(key(KeyCode::Left));
    let draft = app.input().to_owned();
    let Some(AppCommand::Sessions(SessionCommand::Preview { generation, params })) =
        app.handle_key(key(KeyCode::Char(' ')))
    else {
        panic!("preview read expected")
    };
    assert_eq!(params.session_id.as_str(), "current");
    assert_eq!(params.thread_id.as_str(), "current");
    assert!(!app.accepts_input());
    crate::tui_assert_snapshot!(app = &app; "session_manager_preview_loading", render(&app));
    app.finish_session_preview(
        app.screen_mode(),
        generation,
        Ok(preview_result(0..35, false)),
    );
    crate::tui_assert_snapshot!(app = &app; "session_manager_preview_conversation", render(&app));
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
    crate::tui_assert_snapshot!(app = &app; "session_manager_preview_scrolled", render(&app));
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
    app.handle_key(key(KeyCode::Down));
    assert!(
        app.session_manager_hint()
            .text()
            .contains("Enter/→ to expand")
    );
    app.handle_key(key(KeyCode::Enter));
    app.handle_key(key(KeyCode::Down));
    crate::tui_assert_snapshot!(app = &app; "session_manager_archived_expanded", render(&app));
    for open_key in [KeyCode::Enter, KeyCode::Right] {
        assert_eq!(
            app.handle_key(key(open_key)),
            Some(
                SessionCommand::Restore {
                    session_id: archived.session_id.clone()
                }
                .into()
            )
        );
    }
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
    for mode in [
        crate::terminal::ScreenMode::Fullscreen,
        crate::terminal::ScreenMode::Inline,
    ] {
        let mut app = active_session_app();
        let mut settings = crate::config::TerminalSettings::default();
        settings.set_screen_mode(mode);
        app.update(crate::config::Event::SettingsReceived(settings));
        app.handle_key(key(KeyCode::Left));
        app.handle_key(key(KeyCode::Up));
        assert!(
            app.session_manager_hint()
                .text()
                .contains("Enter/← to collapse")
        );
        assert!(render(&app).contains("> Idle (1)"));
        assert_eq!(app.handle_key(key(KeyCode::Enter)), None);
        assert!(
            app.session_manager_hint()
                .text()
                .contains("Enter/→ to expand")
        );
        assert!(!render(&app).contains("Snapshot session"));
        assert!(app.session_preview().is_none());
        crate::tui_assert_snapshot!(app = &app; "session_manager_idle_collapsed", render(&app));

        app.update(SessionEvent::CatalogReceived(vec![session()]));
        assert!(
            app.session_manager_hint()
                .text()
                .contains("Enter/→ to expand")
        );
        app.handle_key(key(KeyCode::Down));
        assert!(render(&app).contains("> Archived (0)"));
        app.handle_key(key(KeyCode::Up));
        assert_eq!(app.handle_key(key(KeyCode::Char(' '))), None);
        assert!(app.session_preview().is_none());
        assert!(render(&app).contains("Snapshot session"));
        crate::tui_assert_snapshot!(app = &app; "session_manager_idle_expanded", render(&app));

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
}

#[test]
fn dashboard_group_arrow_hints_follow_expansion_in_chinese_in_both_modes() {
    for mode in [
        crate::terminal::ScreenMode::Fullscreen,
        crate::terminal::ScreenMode::Inline,
    ] {
        let mut app = active_session_app();
        let mut settings = crate::config::TerminalSettings::default();
        settings.set_screen_mode(mode);
        settings.set_language(crate::nls::Language::Chinese);
        app.update(crate::config::Event::SettingsReceived(settings));
        app.handle_key(key(KeyCode::Left));
        app.handle_key(key(KeyCode::Up));
        let expanded = render(&app);
        assert!(expanded.replace(' ', "").contains("Enter/←折叠"));
        assert_eq!(app.handle_key(key(KeyCode::Left)), None);
        assert!(app.session_manager_focused());
        let collapsed = render(&app);
        assert!(!collapsed.contains("Snapshot session"));
        assert!(collapsed.replace(' ', "").contains("Enter/→展开"));
        assert_eq!(app.handle_key(key(KeyCode::Right)), None);
        assert_eq!(render(&app), expanded);
        crate::tui_assert_snapshot!(
            app = &app;
            "dashboard_group_arrow_hints_chinese",
            format!("Expanded\n{expanded}\n\nCollapsed\n{collapsed}")
        );
    }
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
        advisor: Default::default(),
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
        model: None,
        session_id: SessionId::new("current").unwrap(),
        title: "Snapshot session".into(),
        status: SessionStatus::Active,
        execution_target: None,
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
    render_at(app, WIDTH, HEIGHT)
}

fn dashboard_hintline(app: &App) -> String {
    let area = ratatui::layout::Rect::new(0, 0, WIDTH, HEIGHT);
    let row = match app.screen_mode() {
        crate::terminal::ScreenMode::Fullscreen => {
            super::fullscreen::layout(app, area)
                .session
                .footer
                .hintline
                .y
        }
        crate::terminal::ScreenMode::Inline => {
            super::inline::layout(app, area).session.footer.hintline.y
        }
    };
    render(app)
        .split('\n')
        .nth(usize::from(row))
        .unwrap()
        .to_owned()
}

fn render_at(app: &App, width: u16, height: u16) -> String {
    let buffer = render_buffer(app, width, height);
    (0..height)
        .map(|row| {
            (0..width)
                .map(|column| buffer[(column, row)].symbol())
                .collect::<String>()
                .trim_end()
                .to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn render_buffer(app: &App, width: u16, height: u16) -> ratatui::buffer::Buffer {
    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|frame| draw(frame, app)).unwrap();
    terminal.backend().buffer().clone()
}

#[test]
fn manager_navigation_stays_focused_and_repeated_keys_cannot_open_or_modify_sessions() {
    let mut app = active_session_app();
    app.handle_key(key(KeyCode::Left));
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

#[test]
fn dashboard_grouping_cycles_in_both_modes_preserves_selection_and_localizes_chinese() {
    use crate::sessions::SessionGrouping;
    for mode in [
        crate::terminal::ScreenMode::Fullscreen,
        crate::terminal::ScreenMode::Inline,
    ] {
        let mut app = active_session_app();
        let mut settings = crate::config::TerminalSettings::default();
        settings.set_screen_mode(mode);
        settings.set_language(crate::nls::Language::Chinese);
        app.update(crate::config::Event::SettingsReceived(settings));
        let mut session = session();
        session.execution_target = Some(ash_protocol::SessionExecutionTarget::Local {
            root: "/workspace/project".into(),
        });
        session.model = Some(ash_protocol::ModelRef::new(
            ash_protocol::ProviderId::new("openai").unwrap(),
            ash_protocol::ModelId::new("test-model").unwrap(),
        ));
        app.update(SessionEvent::CatalogReceived(vec![session]));
        app.show_session_manager();
        app.session_navigation_mut().manager_mut().focus();
        let mut screens = Vec::new();
        for grouping in [
            SessionGrouping::Model,
            SessionGrouping::Project,
            SessionGrouping::Status,
        ] {
            assert_eq!(
                app.handle_key(key(KeyCode::Char('g'))),
                Some(AppCommand::SaveSessionGrouping(grouping))
            );
            assert_eq!(app.fullscreen.sessions.manager().grouping(), grouping);
            assert_eq!(app.inline.sessions.manager().grouping(), grouping);
            assert_eq!(
                app.session_navigation().manager().selected_session(),
                Some(&SessionId::new("current").unwrap())
            );
            let output = render(&app);
            assert!(output.replace(' ', "").contains("分组"));
            screens.push(output);
        }
        app.update(SessionEvent::GroupingSaveFailed("read-only profile".into()));
        assert_eq!(
            app.session_navigation().manager().grouping(),
            SessionGrouping::Status
        );
        let output = render(&app);
        assert!(output.replace(' ', "").contains("无法保存仪表盘分组方式"));
        screens.push(output);
        crate::tui_assert_snapshot!(app = &app; "dashboard_grouping_modes_chinese", screens.join("\n\n"));
    }
}

#[test]
fn dashboard_uses_the_page_and_updates_the_right_column_with_selection() {
    for mode in [
        crate::terminal::ScreenMode::Fullscreen,
        crate::terminal::ScreenMode::Inline,
    ] {
        let mut app = active_session_app();
        let mut settings = crate::config::TerminalSettings::default();
        settings.set_screen_mode(mode);
        settings.set_language(crate::nls::Language::Chinese);
        app.update(crate::config::Event::SettingsReceived(settings));
        let mut first = session();
        first.title = "Review parser".into();
        first.manager.summary = Some("Parser review is complete.".into());
        first.execution_target = Some(ash_protocol::SessionExecutionTarget::Local {
            root: "/projects/parser".into(),
        });
        first.model = Some(ash_protocol::ModelRef::new(
            ash_protocol::ProviderId::new("openai").unwrap(),
            ash_protocol::ModelId::new("root-model").unwrap(),
        ));
        let mut second = first.clone();
        second.session_id = SessionId::new("second").unwrap();
        second.title = "Fix compiler".into();
        second.manager.summary = Some("Compiler tests are running.".into());
        second.execution_target = Some(ash_protocol::SessionExecutionTarget::Ssh {
            host: "build-host".into(),
            root: "/projects/compiler".into(),
        });
        app.update(SessionEvent::CatalogReceived(vec![first, second]));
        app.show_session_manager();
        assert!(app.session_manager_focused());
        assert!(!app.accepts_input());
        let area = ratatui::layout::Rect::new(0, 0, WIDTH, HEIGHT);
        let (input, session) = match mode {
            crate::terminal::ScreenMode::Fullscreen => {
                let layout = super::fullscreen::layout(&app, area);
                (layout.input, layout.session)
            }
            crate::terminal::ScreenMode::Inline => {
                let layout = super::inline::layout(&app, area);
                (layout.input, layout.session)
            }
        };
        assert!(input.is_empty());
        assert!(session.composer.is_empty());
        assert!(session.transcript.height >= HEIGHT - 4);
        assert_eq!(session.footer.hintline.bottom(), area.bottom());
        let output = render(&app);
        assert!(output.contains("Parser review is complete."));
        assert!(output.contains("root-model"));
        assert!(!output.contains("Compiler tests are running."));
        crate::tui_assert_snapshot!(app = &app; "dashboard_two_columns_chinese", output);
        app.handle_key(key(KeyCode::Down));
        assert_eq!(
            app.session_navigation()
                .manager()
                .selected_session()
                .unwrap()
                .as_str(),
            "second"
        );
        let output = render(&app);
        assert!(output.contains("Compiler tests are running."));
        assert!(output.contains("build-host:/projects/compiler"));
        assert!(!output.contains("Parser review is complete."));
        crate::tui_assert_snapshot!(app = &app; "dashboard_two_columns_second_selection", output);
        let narrow = render_at(&app, 60, 12);
        assert!(narrow.contains("Fix compiler"));
        assert!(!narrow.contains('│'));
        assert!(!narrow.contains("Build anything"));
        crate::tui_assert_snapshot!(app = &app; "dashboard_narrow_single_column", narrow);
    }
}
