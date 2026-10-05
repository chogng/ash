use super::pointer::PointerTarget;
use super::pointer::target_at;
use crate::app::App;
use crate::app::frame::draw;
use crate::app::frame::process_resource_demand;
use crate::app::fullscreen::layout;

use crate::app::AppCommand;
use crate::app::AppEvent;
use crate::app::CommandPanel;
use crate::host::Event as HostEvent;
use crate::host::clipboard::ClipboardImage;
use crate::host::clipboard::ClipboardImageAvailability;
use crate::host::clipboard::ClipboardImageFingerprint;
use crate::keymap::KeyEvent;
use crate::models::Event as ModelEvent;
use crate::models::ModelSummary;
use crate::render::test_context;
use crate::sessions::Event as SessionEvent;
use crate::status::Event as StatusEvent;
use crate::status::StatusLineItem;
use crate::status::StatusLineSettings;
use crate::status::StatusViewData;
use crate::status::status_panel;
use crate::thread::Command as ThreadCommand;
use crate::thread::Event as ThreadEvent;
use crate::thread::TurnActivity;
use crate::thread::composer::ChatComposerPointerTarget;
use crate::thread::composer::ChatInputCatalog;
use crate::thread::composer::CompletionView;
use crate::thread::composer::SkillCompletionItem;
use crate::thread::composer::SlashCommandCatalog;
use crate::thread::composer::built_in_slash_command_definitions;
use crate::thread::composer::file_search::FileSearchManager;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::search_box::SearchBoxModel;
use ash_app_server_protocol::protocol::config::ModelRefDto;
use ash_memory_diagnostics::ProcessResourceDemand;
use ash_memory_diagnostics::ProcessResourceMetrics;
use ash_protocol::ContentDigest;
use ash_protocol::ReasoningEffort;
use ash_protocol::Session;
use ash_protocol::SessionId;
use ash_protocol::SessionManagerActivity;
use ash_protocol::SessionManagerInfo;
use ash_protocol::SessionManagerStatus;
use ash_protocol::SessionStatus;
use ash_protocol::SessionThread;
use ash_protocol::SkillId;
use ash_protocol::SkillName;
use ash_protocol::SkillRef;
use ash_protocol::SkillSourceId;
use ash_protocol::ThreadId;
use ash_protocol::ThreadStatus;
use ash_slash_commands::SlashCommandArgumentMode;
use ash_slash_commands::SlashCommandDefinition;
use crossterm::event::KeyCode;
use crossterm::event::KeyModifiers;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Color;
use ratatui::style::Modifier;
use std::fs;
use std::path::Path;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;
use unicode_width::UnicodeWidthStr;

#[test]
fn input_history_search_and_cancel_preserve_the_composer() {
    use message_history::MessageHistory;
    use message_history::MessageHistoryKind as InputKind;
    use message_history::MessageHistoryRetention as Retention;
    use message_history::MessageHistoryStore;
    use message_history::MessageHistorySubmission as Submission;
    use std::sync::Arc;
    use std::sync::mpsc;

    let root = tempfile::tempdir().unwrap();
    let store = Arc::new(
        state::SqliteMessageHistory::open(&root.path().join("state.sqlite3"), Retention::default())
            .unwrap(),
    );
    store
        .append(Submission {
            text: "find the input history owner".into(),
            kind: InputKind::Agent,
            thread_id: None,
        })
        .unwrap();
    let (notify, wake) = mpsc::channel();
    let client = MessageHistory::with_waker(store, move || {
        let _ = notify.send(());
    })
    .unwrap();
    let mut app = App::new();
    app.connect_input_history(client);
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Char('r'), KeyModifiers::CONTROL)),
        None
    );
    for ch in "find".chars() {
        assert_eq!(
            app.handle_key(KeyEvent::new(KeyCode::Char(ch), KeyModifiers::NONE)),
            None
        );
    }
    while app.input() != "find the input history owner" {
        wake.recv_timeout(Duration::from_secs(5)).unwrap();
        app.poll_input_history();
    }
    let area = layout(&app, Rect::new(0, 0, 100, 20)).session.composer;
    let content = crate::thread::composer::content_area(area);
    let buffer = render_buffer(&app, 100, 20);
    assert_eq!(buffer[(content.x + 2, area.y)].symbol(), "H");
    assert_eq!(
        buffer[(content.x + 2, area.y)].fg,
        app.render_context().foreground()
    );
    assert_eq!(buffer[(area.x + 2, area.y + 1)].symbol(), ">");
    crate::tui_assert_snapshot!(app = &app; "input_history_search", render(&app, 100, 20));
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
        None
    );
    assert_eq!(app.input(), "");
    crate::tui_assert_snapshot!(app = &app; "input_history_search_cancelled", render(&app, 100, 20));
}

#[test]
fn pull_request_command_submits_an_ordinary_agent_task() {
    let mut app = App::new();
    app.update(ThreadEvent::ContextChanged {
        session_id: SessionId::new("pr-session").unwrap(),
        thread_id: ThreadId::new("pr-thread").unwrap(),
    });
    app.insert_text("/pr");
    let Some(AppCommand::Thread(ThreadCommand::SubmitTurn { submission })) =
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
    else {
        panic!("PR command must use the normal Agent submission path");
    };
    assert_eq!(
        submission.input,
        vec![crate::thread::composer::ChatInputItem::Text(
            submission.display_text.clone()
        )]
    );
    assert!(submission.display_text.contains("pull request"));
    assert!(app.input().is_empty());
    crate::tui_assert_snapshot!(app = &app; "pull_request_agent_task", render(&app, 100, 20));
}

#[test]
fn conversation_chrome_keeps_home_and_input_visible_without_a_welcome_message() {
    let rendered = render(&App::new(), 80, 20);
    assert!(rendered.lines().next().unwrap().contains("."));
    assert!(!rendered.contains("Ash Code v"));
    assert!(rendered.contains("Automatic model"));
    assert!(
        rendered
            .lines()
            .nth(usize::from(
                layout(&App::new(), Rect::new(0, 0, 80, 20))
                    .session
                    .footer
                    .hintline
                    .y
            ))
            .unwrap()
            .contains("Manual")
    );
    assert_eq!(
        rendered.lines().last().unwrap().trim(),
        "⏸ Manual · ← Dashboard · ? for shortcuts"
    );
}

#[test]
fn top_tip_notice_uses_the_fixed_row_above_chat_input_without_changing_layout() {
    let mut app = App::new();
    let terminal_area = Rect::new(0, 0, 80, 20);
    let areas_before = layout(&app, terminal_area).session;

    app.update(HostEvent::TopTipNoticeShown(
        "Copied 246 chars to clipboard".into(),
    ));

    let areas_after = layout(&app, terminal_area).session;
    let rendered = render(&app, terminal_area.width, terminal_area.height);
    let rows = rendered.lines().collect::<Vec<_>>();
    let notice_row = usize::from(areas_after.tipline.y);

    assert_eq!(areas_after, areas_before);
    assert_eq!(areas_after.tipline.height, 1);
    assert_eq!(areas_after.tipline.bottom(), areas_after.composer.y);
    assert!(
        rows[notice_row]
            .trim_end()
            .ends_with("Copied 246 chars to clipboard")
    );
    assert!(!rows[notice_row].contains("shift+tab"));
    assert!(!rows.last().unwrap().contains("Copied"));
}

#[test]
fn completed_update_uses_the_existing_top_tip_notice_row() {
    let mut app = App::new();
    app.update(HostEvent::TopTipNoticeShown(
        "Ash 1.2.3 is ready · restart to use the update".into(),
    ));

    crate::tui_assert_snapshot!(app = &app; "completed_update_notice", render(&app, 80, 20));
}

#[test]
fn clipboard_image_paste_moves_from_top_tip_into_chat_input() {
    let mut app = App::new();
    let terminal_area = Rect::new(0, 0, 80, 20);
    let areas_before = layout(&app, terminal_area).session;

    app.update(HostEvent::ClipboardImageAvailabilityChanged(
        ClipboardImageAvailability::Available(ClipboardImageFingerprint(1)),
    ));

    let areas_after = layout(&app, terminal_area).session;
    let rendered = render(&app, terminal_area.width, terminal_area.height);
    let rows = rendered.lines().collect::<Vec<_>>();
    let tip_row = usize::from(areas_after.tipline.y);

    assert_eq!(areas_after, areas_before);
    assert_eq!(areas_after.tipline.height, 1);
    assert!(
        rows[tip_row]
            .trim_end()
            .ends_with("image in clipboard · ctrl+v to paste")
    );
    crate::tui_assert_snapshot!(app = &app; "clipboard_image_top_tip", rendered);

    app.update(HostEvent::ClipboardImageRead {
        target: app.draft_target(),
        result: Ok(ClipboardImage {
            png: b"\x89PNG\r\n\x1a\npayload".to_vec(),
            fingerprint: ClipboardImageFingerprint(1),
            width: 1,
            height: 1,
        }),
    });
    let rendered_after_paste = render(&app, terminal_area.width, terminal_area.height);
    assert!(!rendered_after_paste.contains("image in clipboard"));
    assert!(rendered_after_paste.contains("[Image #1]"));
    crate::tui_assert_snapshot!(
        app = &app;
        "clipboard_image_pasted_into_chat_input",
        rendered_after_paste
    );
}

#[test]
fn clipboard_image_refresh_after_paste_stays_quiet_until_content_changes() {
    let mut app = App::new();
    // Pasting can finish before the first availability refresh.
    app.update(HostEvent::ClipboardImageRead {
        target: app.draft_target(),
        result: Ok(ClipboardImage {
            png: b"\x89PNG\r\n\x1a\npayload".to_vec(),
            fingerprint: ClipboardImageFingerprint(1),
            width: 1,
            height: 1,
        }),
    });
    app.update(HostEvent::ClipboardImageAvailabilityChanged(
        ClipboardImageAvailability::Available(ClipboardImageFingerprint(1)),
    ));
    assert!(!render(&app, 80, 20).contains("image in clipboard"));
    assert_eq!(app.input(), "[Image #1] ");

    app.update(HostEvent::ClipboardImageAvailabilityChanged(
        ClipboardImageAvailability::Available(ClipboardImageFingerprint(2)),
    ));
    assert!(render(&app, 80, 20).contains("image in clipboard"));

    app.update(HostEvent::ClipboardImageAvailabilityChanged(
        ClipboardImageAvailability::Unavailable,
    ));
    assert!(!render(&app, 80, 20).contains("image in clipboard"));
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Char('v'), KeyModifiers::CONTROL)),
        Some(AppCommand::Host(crate::host::Command::ReadClipboardImage {
            target: app.draft_target()
        }))
    );
}

#[test]
fn failed_clipboard_image_paste_keeps_the_tip_visible() {
    let mut app = App::new();
    app.update(HostEvent::ClipboardImageAvailabilityChanged(
        ClipboardImageAvailability::Available(ClipboardImageFingerprint(1)),
    ));
    app.update(HostEvent::ClipboardImageRead {
        target: app.draft_target(),
        result: Ok(ClipboardImage {
            png: b"invalid image".to_vec(),
            fingerprint: ClipboardImageFingerprint(1),
            width: 1,
            height: 1,
        }),
    });

    assert!(render(&app, 80, 20).contains("image in clipboard"));
    assert_eq!(app.input(), "");
}

#[test]
fn status_command_panel_uses_the_shared_title_and_close_hint() {
    let usage = ash_protocol::ModelUsageSummary::default();
    let reference_cost = ash_protocol::ModelReferenceCostSummary::default();
    let panel = CommandPanel::status(status_panel(StatusViewData {
        model: "openai/gpt",
        usage: &usage,
        reference_cost: &reference_cost,
        session_id: "session-1",
        thread_id: "thread-1",
    }));
    let mut app = App::new();
    app.open_command_panel(panel);
    let area = Rect::new(0, 0, 80, 20);
    let modal = super::modal::layout_for(&app, area);
    let buffer = render_buffer(&app, 80, 20);
    assert_eq!(buffer[(modal.surface.x, modal.surface.y)].symbol(), "┌");
    assert_eq!(buffer[(modal.title.x + 1, modal.title.y)].symbol(), "S");
    assert_eq!(
        buffer[(modal.title.x + 1, modal.title.y)].fg,
        test_context().foreground()
    );
    assert!(
        buffer[(modal.title.x + 1, modal.title.y)]
            .modifier
            .contains(Modifier::BOLD)
    );
    let text = render(&app, 80, 20);
    assert!(text.contains("Session"));
    assert!(text.contains("Diagnostics"));
    assert!(text.contains("Esc close"));
    assert!(text.contains("[✗]"));
}

#[test]
fn modal_keeps_wrapped_tabs_between_title_and_body() {
    let panel = CommandPanel::help(ListSelectionModel::new(
        "Panel",
        vec![
            ListSelectionGroup::new("First tab", vec![ListSelectionItem::new("First item")]),
            ListSelectionGroup::new("Second tab", vec![ListSelectionItem::new("Second item")]),
        ],
    ));
    let area = Rect::new(0, 0, 20, 12);
    let modal = super::modal::layout(area);
    let body = super::modal::body_area(&panel, modal.content);
    let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
    terminal
        .draw(|frame| {
            super::modal::draw_panel(
                frame,
                &panel,
                modal,
                None,
                None,
                crate::render::InteractionState::default(),
                false,
                test_context(),
            )
        })
        .unwrap();
    let buffer = terminal.backend().buffer();
    assert_eq!(body.y, modal.content.y + 3);
    assert_eq!(buffer[(body.x - 2, body.y)].symbol(), ">");
    assert_eq!(buffer[(body.x, body.y)].symbol(), "F");
    let text = terminal.backend().to_string();
    assert!(text.contains("First tab"));
    assert!(text.contains("Second tab"));
    assert!(text.contains("First item"));
    crate::tui_assert_snapshot!(mode = crate::terminal::ScreenMode::Fullscreen; "modal_wrapped_tabs", text);
}

#[test]
fn modal_lists_scroll_within_their_bounds_without_moving_the_composer() {
    let mut app = App::new();
    let area = Rect::new(0, 0, 80, 20);
    let before = layout(&app, area).session.composer;
    app.update(AppEvent::HelpOpened(
        ListSelectionModel::new(
            "Items",
            vec![ListSelectionGroup::new(
                "All",
                (0..30)
                    .map(|index| ListSelectionItem::new(format!("Item {index}")))
                    .collect(),
            )],
        )
        .without_tab_bar(),
    ));
    assert_eq!(layout(&app, area).session.composer, before);
    for height in [20, 40] {
        app.handle_key(KeyEvent::new(KeyCode::Home, KeyModifiers::NONE));
        let first = render(&app, 80, height);
        assert!(first.contains("Item 0"));
        assert!(first.contains("more below"));
        app.handle_key(KeyEvent::new(KeyCode::End, KeyModifiers::NONE));
        let last = render(&app, 80, height);
        assert!(last.contains("Item 29"));
        assert!(last.contains("more above"));
        assert!(!last.contains("more below"));
    }
}

#[test]
fn process_resource_demand_follows_the_content_that_is_actually_visible() {
    let mut app = App::new();
    let area = Rect::new(0, 0, 80, 20);
    assert_eq!(
        process_resource_demand(&app, area),
        ProcessResourceDemand::Disabled
    );

    let mut settings = StatusLineSettings::default();
    for item in StatusLineItem::ALL {
        settings.set(item, matches!(item, StatusLineItem::Memory));
    }
    app.update(StatusEvent::LineSettingsReceived(settings));
    assert_eq!(
        process_resource_demand(&app, area),
        ProcessResourceDemand::Summary(ProcessResourceMetrics::Memory)
    );
    assert_eq!(
        process_resource_demand(&app, Rect::new(0, 0, 1, 20)),
        ProcessResourceDemand::Disabled
    );
    assert_eq!(
        process_resource_demand(&app, Rect::new(0, 0, 80, 1)),
        ProcessResourceDemand::Disabled
    );

    let usage = ash_protocol::ModelUsageSummary::default();
    let reference_cost = ash_protocol::ModelReferenceCostSummary::default();
    app.update(StatusEvent::PanelOpened(status_panel(StatusViewData {
        model: "openai/gpt",
        usage: &usage,
        reference_cost: &reference_cost,
        session_id: "session-1",
        thread_id: "thread-1",
    })));
    assert_eq!(
        process_resource_demand(&app, area),
        ProcessResourceDemand::Disabled
    );

    app.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
    assert_eq!(
        process_resource_demand(&app, area),
        ProcessResourceDemand::Detailed
    );
    assert_eq!(
        process_resource_demand(&app, Rect::new(0, 0, 80, 1)),
        ProcessResourceDemand::Disabled
    );
    app.handle_key(KeyEvent::new(KeyCode::BackTab, KeyModifiers::SHIFT));
    assert_eq!(
        process_resource_demand(&app, area),
        ProcessResourceDemand::Disabled
    );
}

#[test]
fn status_line_items_control_process_resource_metrics_independently() {
    let mut app = App::new();
    let area = Rect::new(0, 0, 80, 20);
    let mut settings = StatusLineSettings::default();
    for item in StatusLineItem::ALL {
        settings.set(
            item,
            matches!(item, StatusLineItem::Memory | StatusLineItem::Cpu),
        );
    }
    app.update(StatusEvent::LineSettingsReceived(settings.clone()));
    assert_eq!(
        process_resource_demand(&app, area),
        ProcessResourceDemand::Summary(ProcessResourceMetrics::MemoryAndCpu)
    );

    settings.set(StatusLineItem::Memory, false);
    app.update(StatusEvent::LineSettingsReceived(settings.clone()));
    assert_eq!(
        process_resource_demand(&app, area),
        ProcessResourceDemand::Summary(ProcessResourceMetrics::Cpu)
    );

    settings.set(StatusLineItem::Memory, true);
    settings.set(StatusLineItem::Cpu, false);
    app.update(StatusEvent::LineSettingsReceived(settings.clone()));
    assert_eq!(
        process_resource_demand(&app, area),
        ProcessResourceDemand::Summary(ProcessResourceMetrics::Memory)
    );

    settings.set(StatusLineItem::Memory, false);
    app.update(StatusEvent::LineSettingsReceived(settings));
    assert_eq!(
        process_resource_demand(&app, area),
        ProcessResourceDemand::Disabled
    );
}

#[test]
fn status_panel_expands_or_scrolls_with_available_height_and_escape_restores_chat_input() {
    let mut app = App::new();
    let terminal_area = Rect::new(0, 0, 80, 20);
    app.insert_text("/");
    assert!(app.completion().is_some());
    let before = layout(&app, terminal_area).session;

    let usage = ash_protocol::ModelUsageSummary::default();
    let reference_cost = ash_protocol::ModelReferenceCostSummary::default();
    app.update(StatusEvent::PanelOpened(status_panel(StatusViewData {
        model: "openai/gpt",
        usage: &usage,
        reference_cost: &reference_cost,
        session_id: "session-1",
        thread_id: "thread-1",
    })));

    assert_eq!(layout(&app, terminal_area).session, before);
    assert!(app.command_panel().is_some());
    assert!(app.overlay().is_none());
    assert!(app.completion().is_none());
    app.handle_key(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE));
    assert_eq!(app.input(), "/");
    let rendered = render(&app, 80, 20);
    assert!(rendered.contains("Session status"));
    assert!(rendered.contains("Session"));
    assert!(rendered.contains("Diagnostics"));
    assert!(rendered.contains("Tab tabs · ↑/↓ scroll · Esc close"));
    crate::tui_assert_snapshot!(app = &app; "status_panel_adaptive_height", rendered);

    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(app.command_panel().is_none());
    assert_eq!(layout(&app, terminal_area).session, before);
    assert_eq!(app.input(), "/");
}

#[test]
fn manager_keeps_overflow_text_out_of_the_fixed_top_tip_row() {
    let mut app = App::new();
    app.update(SessionEvent::CatalogReceived(
        (0..24)
            .map(|index| {
                manager_session(
                    &format!("session-{index}"),
                    SessionManagerStatus::Idle,
                    None,
                )
            })
            .collect(),
    ));
    app.insert_text("/dashboard");
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    app.update(HostEvent::TopTipNoticeShown(
        "Copied 246 chars to clipboard".into(),
    ));

    let terminal_area = Rect::new(0, 0, 100, 20);
    let areas = layout(&app, terminal_area).session;
    let rendered = render(&app, terminal_area.width, terminal_area.height);
    let rows = rendered.lines().collect::<Vec<_>>();
    let notice_row = rows[usize::from(areas.tipline.y)];
    let manager_last_row = rows[usize::from(areas.tipline.y.saturating_sub(1))];

    assert!(manager_last_row.contains("more below"));
    assert!(!notice_row.contains("more below"));
    assert!(
        notice_row
            .trim_end()
            .ends_with("Copied 246 chars to clipboard")
    );
}

#[test]
fn empty_session_input_offers_manager_navigation() {
    let mut app = App::new();
    enter_session(
        &mut app,
        "current",
        vec![manager_session("current", SessionManagerStatus::Idle, None)],
    );

    let terminal_area = Rect::new(0, 0, 80, 20);
    let top_tip_row = usize::from(layout(&app, terminal_area).session.tipline.y);
    let rendered = render(&app, terminal_area.width, terminal_area.height);
    let rows = rendered.lines().collect::<Vec<_>>();

    assert!(rows[19].contains("← Dashboard"));
    assert!(!rows[top_tip_row].contains("← Dashboard"));
    assert!(!rows[top_tip_row].contains("shift+tab"));
    assert!(!rows[19].contains("permissions on"));
    assert!(
        rows[usize::from(
            layout(&app, Rect::new(0, 0, 80, 20))
                .session
                .footer
                .hintline
                .y
        )]
        .contains("⏸ Manual")
    );

    assert!(app.handle_tick(Instant::now() + Duration::from_secs(10)));
    let rendered = render(&app, terminal_area.width, terminal_area.height);
    let rows = rendered.lines().collect::<Vec<_>>();
    assert!(rows[top_tip_row].trim().is_empty());
    assert!(rows[19].contains("← Dashboard"));
    assert!(!rows[top_tip_row].contains("shift+tab"));

    app.insert_text("draft");
    let rendered = render(&app, terminal_area.width, terminal_area.height);
    let rows = rendered.lines().collect::<Vec<_>>();
    let status_line = rendered.lines().last().unwrap();

    assert!(!rows[top_tip_row].contains("← Dashboard"));
    assert!(!rows[top_tip_row].contains("shift+tab"));
    assert!(!status_line.contains("permissions on"));
    assert!(!status_line.contains("← Dashboard"));
}

#[test]
fn narrow_session_keeps_permission_in_the_final_row() {
    let mut app = App::new();
    enter_session(
        &mut app,
        "current",
        vec![manager_session("current", SessionManagerStatus::Idle, None)],
    );

    let terminal_area = Rect::new(0, 0, 24, 20);
    let top_tip_row = usize::from(layout(&app, terminal_area).session.tipline.y);
    let rendered = render(&app, terminal_area.width, terminal_area.height);
    let rows = rendered.lines().collect::<Vec<_>>();

    assert!(!rows[top_tip_row].contains("Manual"));
    assert!(!rows[top_tip_row].contains("shift+tab"));
    assert!(!rows[18].contains("Manual"));
    assert!(rows[19].trim_start().starts_with("⏸"));
    assert!(rows[19].contains("← Dashboard"));
}

#[test]
fn left_from_a_session_opens_the_manager() {
    let mut app = App::new();
    enter_session(
        &mut app,
        "current",
        vec![manager_session("current", SessionManagerStatus::Idle, None)],
    );

    assert!(render(&app, 80, 20).contains("← Dashboard"));
    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE))
            .is_none()
    );
    assert!(app.session_manager_view().is_some());
    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Right, KeyModifiers::NONE))
            .is_none()
    );
    assert!(app.session_manager_view().is_some());
    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE))
            .is_none()
    );
    assert!(app.session_manager_view().is_none());
}

#[test]
fn manager_uses_the_page_body_for_grouped_three_column_status_rows() {
    let mut app = App::new();
    app.update(SessionEvent::CatalogReceived(vec![
        manager_session(
            "needs-input",
            SessionManagerStatus::NeedsInput,
            Some(SessionManagerActivity::Question {
                text: "Which API should I use?".into(),
            }),
        ),
        manager_session(
            "working",
            SessionManagerStatus::Working,
            Some(SessionManagerActivity::Operation {
                text: "Running targeted tests".into(),
            }),
        ),
        manager_session("done", SessionManagerStatus::Completed, None),
    ]));
    app.show_session_manager();
    assert!(app.session_manager_focused());
    let rendered = render(&app, 120, 28);
    let needs_input = rendered
        .lines()
        .find(|line| line.contains("needs-input"))
        .unwrap();
    let working = rendered
        .lines()
        .find(|line| line.contains("working"))
        .unwrap();
    assert!(!rendered.lines().any(|line| line.contains("done")));
    assert!(rendered.lines().next().unwrap().contains("."));
    assert!(rendered.contains("Needs input"));
    assert!(rendered.contains("Working"));
    assert!(rendered.contains("Archived (1)"));
    assert!(needs_input.starts_with("> ? needs-input"));
    assert!(rendered.contains("Which API should I use?"));
    assert!(working.starts_with("  ⠋ working"));
    assert!(rendered.lines().last().unwrap().contains("Esc"));
    assert!(layout(&app, Rect::new(0, 0, 120, 28)).input.is_empty());
}

#[test]
fn pending_steer_is_shown_once_in_chat_history() {
    let mut app = App::new();
    app.insert_text("start");
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    app.update(ThreadEvent::TurnActivityChanged(TurnActivity::Working));
    app.insert_text("check the tests first");
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::CONTROL));

    app.handle_key_in_area(
        KeyEvent::new(KeyCode::Home, KeyModifiers::CONTROL),
        Rect::new(0, 0, 80, 20),
    );
    let rendered = render(&app, 80, 20);

    assert!(!rendered.contains("Steer  1 sending"));
    assert_eq!(rendered.matches("check the tests first").count(), 1);
}

#[test]
fn permission_modes_share_the_final_row_with_dashboard() {
    let mut app = App::new();
    for (mode, label) in [
        (ash_protocol::ApprovalMode::Manual, "⏸ Manual"),
        (ash_protocol::ApprovalMode::Auto, "⏩  Auto"),
        (
            ash_protocol::ApprovalMode::BypassPermissions,
            "▶ Bypass permissions",
        ),
    ] {
        app.set_next_approval_mode(mode);
        let screen = render(&app, 100, 20);
        let hints = screen.lines().last().unwrap().trim_end();
        assert!(hints.contains("← Dashboard"));
        assert!(hints.contains(label));
        let top_tip = layout(&app, Rect::new(0, 0, 100, 20)).session.tipline;
        assert!(
            !screen
                .lines()
                .nth(usize::from(top_tip.y))
                .unwrap()
                .contains(label)
        );
        assert!(!screen.lines().nth(18).unwrap().contains(label));
    }
}

#[test]
fn key_hint_style_applies_to_fullscreen_without_changing_hint_text() {
    let mut app = App::new();
    let contrast = render_buffer(&app, 100, 20);
    let row = 19;
    let x = (0..100)
        .find(|x| contrast[(*x, row)].symbol() == "←")
        .unwrap();
    assert_eq!(contrast[(x, row)].symbol(), "←");
    assert_eq!(contrast[(x, row)].fg, test_context().foreground());
    assert!(contrast[(x, row)].modifier.contains(Modifier::BOLD));
    assert_eq!(contrast[(x + 5, row)].fg, test_context().muted());
    assert!(!contrast[(x + 5, row)].modifier.contains(Modifier::BOLD));

    let mut settings = crate::config::TerminalSettings::default();
    settings.set_key_hint_style(crate::config::KeyHintStyle::Muted);
    app.update(crate::config::Event::SettingsReceived(settings));
    let muted = render_buffer(&app, 100, 20);
    assert_eq!(muted[(x, row)].symbol(), "←");
    assert_eq!(muted[(x, row)].fg, test_context().muted());
    assert!(muted[(x, row)].modifier.contains(Modifier::ITALIC));
    assert_eq!(muted[(x + 5, row)].fg, test_context().muted());
    assert!(muted[(x + 5, row)].modifier.contains(Modifier::ITALIC));
}

#[test]
fn turn_activity_does_not_enter_status_line() {
    let mut app = App::new();
    app.insert_text("start");
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    app.update(ThreadEvent::TurnActivityChanged(TurnActivity::Working));
    app.insert_text("change direction");

    let rendered = render(&app, 80, 20);

    let areas = layout(&app, Rect::new(0, 0, 80, 20)).session;
    let rows = rendered.lines().collect::<Vec<_>>();
    let progress_row = rows
        .iter()
        .position(|row| row.contains("Starting"))
        .unwrap() as u16;
    assert!(
        areas
            .progress
            .contains(ratatui::layout::Position::new(0, progress_row))
    );
    assert!(rows[usize::from(areas.footer.hintline.y)].contains("Manual"));
}

#[test]
fn queued_message_is_visible_only_in_the_queue_region() {
    let mut app = App::new();
    app.update(ThreadEvent::TurnActivityChanged(TurnActivity::Working));
    app.insert_text("edit this later");
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    let rendered = render(&app, 80, 20);

    assert!(rendered.contains("Queue 1: edit this later"));
    assert!(!rendered.lines().any(|line| line.contains("queue 1 ·")));
}

#[test]
fn queue_focus_and_pointer_target_share_the_visible_row_identity() {
    let mut app = App::new();
    app.update(ThreadEvent::TurnActivityChanged(TurnActivity::Working));
    app.insert_text("edit this later");
    let action = app
        .handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
        .unwrap();
    let message = crate::test_support::queued_message(action);
    app.update(ThreadEvent::QueueReceived {
        messages: vec![message],
        restore: None,
    });
    let terminal_area = Rect::new(0, 0, 120, 20);
    let queue_area = layout(&app, terminal_area).session.queue;

    let Some(PointerTarget::Queue(pointer_id)) =
        target_at(&app, terminal_area, queue_area.x + 2, queue_area.y)
    else {
        panic!("the queue row must expose its stable pointer identity")
    };
    assert_eq!(pointer_id, app.queue_view().items[0].id);
    app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::ALT));
    let rendered = render(&app, 120, 20);

    assert!(rendered.contains("> Queue 1: edit this later · next"));
    assert!(rendered.contains("Enter to edit"));
}

#[test]
fn permission_uses_a_distinct_color_for_each_approval_mode() {
    let mut app = App::new();
    for (mode, icon, color) in [
        (
            ash_protocol::ApprovalMode::Manual,
            "⏸",
            test_context().warning(),
        ),
        (
            ash_protocol::ApprovalMode::Auto,
            "⏩",
            test_context().accent(),
        ),
        (
            ash_protocol::ApprovalMode::BypassPermissions,
            "▶",
            test_context().danger(),
        ),
    ] {
        app.set_next_approval_mode(mode);
        let buffer = render_buffer(&app, 100, 20);
        let row = layout(&app, buffer.area).session.footer.hintline.y;
        let column = (0..100)
            .find(|x| buffer[(*x, row)].symbol() == icon)
            .unwrap();
        assert_eq!(buffer[(column, row)].fg, color);
        assert_eq!(buffer[(column + icon.width() as u16, row)].fg, color);
    }
}

#[test]
fn workspace_header_stays_fixed_while_scrolling_conversation_history() {
    let mut app = App::for_dir(Path::new("/work/ash"));

    let empty = render(&app, 80, 20);
    assert!(empty.contains("/work/ash"));
    assert!(!empty.lines().last().unwrap().contains("/work/ash"));

    app.update(ThreadEvent::ProductNotice("Conversation started.".into()));
    assert!(render(&app, 80, 20).contains("/work/ash"));

    for index in 0..12 {
        app.update(ThreadEvent::FailureReported(format!(
            "Model invocation failed {index}"
        )));
    }
    assert!(render(&app, 80, 20).contains("/work/ash"));

    app.handle_key_in_area(
        KeyEvent::new(KeyCode::Home, KeyModifiers::CONTROL),
        Rect::new(0, 0, 80, 20),
    );
    let scrolled_to_start = render(&app, 80, 20);
    assert!(!scrolled_to_start.contains("Ash Code v"));
    assert!(scrolled_to_start.contains("/work/ash"));
    assert!(scrolled_to_start.contains("Conversation started."));
    crate::tui_assert_snapshot!(app = &app; "transcript_scrolled_to_first_message", scrolled_to_start);
}

#[test]
fn composer_shows_the_configured_model_once_at_wide_and_narrow_widths() {
    let mut app = App::new();
    app.update(ModelEvent::SummaryReceived(configured_model_summary()));
    let wide = render(&app, 80, 20);
    let wide_input = layout(&app, Rect::new(0, 0, 80, 20)).input;
    assert_eq!(wide.matches("Claude Sonnet (high)").count(), 1);
    assert!(
        wide.lines()
            .nth(usize::from(wide_input.bottom() - 1))
            .unwrap()
            .contains(" Claude Sonnet (high) ")
    );
    assert!(!wide.contains("anthropic"));
    assert!(wide.lines().nth(19).unwrap().contains("Manual"));

    let narrow = render(&app, 24, 20);
    let narrow_input = layout(&app, Rect::new(0, 0, 24, 20)).input;
    assert!(
        narrow
            .lines()
            .nth(usize::from(narrow_input.bottom() - 1))
            .unwrap()
            .contains(" Claude Sonnet… ")
    );
    assert!(!narrow.contains("anthropic"));
    assert!(
        narrow
            .lines()
            .nth(19)
            .unwrap()
            .trim_start()
            .starts_with("⏸")
    );
    assert!(narrow.lines().nth(19).unwrap().contains("← Dashboard"));
}

#[test]
fn ruled_input_aligns_with_the_transcript_and_renders_the_prompt() {
    let app = App::new();
    let input = layout(&app, Rect::new(0, 0, 80, 20)).input;
    let buffer = render_buffer(&app, 80, 20);
    assert_eq!(buffer[(0, input.y)].symbol(), " ");
    assert_eq!(buffer[(2, input.y)].symbol(), "─");
    assert_eq!(buffer[(77, input.y)].symbol(), "─");
    assert_eq!(buffer[(2, input.y)].fg, test_context().foreground());
    assert_eq!(buffer[(0, input.y + 1)].symbol(), " ");
    assert_eq!(buffer[(2, input.y + 1)].symbol(), ">");
    assert_eq!(buffer[(2, input.y + 1)].fg, test_context().foreground());
    assert_eq!(buffer[(77, input.y + 1)].symbol(), " ");
}

#[test]
fn policy_tip_appears_after_first_submission_and_each_policy_change() {
    let mut app = App::new();
    enter_session(
        &mut app,
        "current",
        vec![manager_session("current", SessionManagerStatus::Idle, None)],
    );
    app.update(ModelEvent::SummaryReceived(ModelSummary::from_catalog(
        Some(ModelRefDto {
            provider: "anthropic".into(),
            model: "claude-sonnet".into(),
        }),
        None,
        None,
    )));
    let terminal_area = Rect::new(0, 0, 80, 20);
    let areas = layout(&app, terminal_area).session;
    let composer = areas.composer;
    let top_tip_row = areas.tipline.y;

    let before = render(&app, 80, 20);
    assert!(before.lines().last().unwrap().contains("← Dashboard"));

    app.insert_text("hello");
    assert!(matches!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        Some(AppCommand::Thread(ThreadCommand::SubmitTurn { .. }))
    ));

    let buffer = render_buffer(&app, 80, 20);
    let bottom_row = layout(&app, terminal_area).session.footer.hintline.y;
    let hint_column = 78 - "/permission to change permissions".width() as u16;
    let hint = &buffer[(hint_column, top_tip_row)];

    assert_eq!(hint.symbol(), "/");
    assert_eq!(hint.fg, test_context().muted());
    assert!(hint.modifier.contains(Modifier::ITALIC));
    assert_eq!(buffer[(2, bottom_row)].symbol(), "⏸");
    assert_eq!(buffer[(2, bottom_row)].fg, test_context().warning());
    assert!(
        !(0..80)
            .map(|x| buffer[(x, bottom_row)].symbol())
            .collect::<String>()
            .contains("permissions on")
    );
    assert_eq!(buffer[(2, composer.y)].symbol(), "─");
    assert_eq!(buffer[(77, composer.y)].symbol(), "─");

    let first_tip_expired = Instant::now() + Duration::from_secs(6);
    assert!(app.handle_tick(first_tip_expired));
    let after = render(&app, 80, 20);
    let after_tip = after.lines().nth(usize::from(top_tip_row)).unwrap();
    assert!(!after_tip.contains("← Dashboard"));
    assert!(!after_tip.contains("/permission"));

    let policy_changed = first_tip_expired + Duration::from_secs(1);
    app.cycle_next_approval_mode(policy_changed);
    assert_eq!(app.approval_mode(), ash_protocol::ApprovalMode::Auto);
    let after_change = render(&app, 80, 20);
    assert!(
        after_change
            .lines()
            .nth(usize::from(top_tip_row))
            .unwrap()
            .contains("/permission to change permissions")
    );

    assert!(app.handle_tick(policy_changed + Duration::from_secs(4))); // Active status animates.
    app.cycle_next_approval_mode(policy_changed + Duration::from_secs(4));
    assert!(app.handle_tick(policy_changed + Duration::from_secs(5)));
    assert!(app.handle_tick(policy_changed + Duration::from_secs(9)));
    let after_refreshed_tip = render(&app, 80, 20);
    assert!(
        !after_refreshed_tip
            .lines()
            .nth(usize::from(top_tip_row))
            .unwrap()
            .contains("shift+tab")
    );
}

#[test]
fn entire_top_tip_holds_then_fades_without_moving_the_composer() {
    use crate::render::RenderTheme;
    use crate::render::ThemePalette;
    use ash_terminal_detection::ColorLevel;

    let started = Instant::now();
    for palette in [ThemePalette::dark(), ThemePalette::light()] {
        let mut app = App::new();
        app.update(crate::theme::Event::RenderChanged(
            RenderTheme::from_palette(palette, ColorLevel::TrueColor),
        ));
        app.show_policy_tip(started);
        let area = Rect::new(0, 0, 80, 20);
        let areas = layout(&app, area).session;
        let before = render_buffer(&app, 80, 20);
        let hint_x = 78 - "/permission to change permissions".width() as u16;
        assert_eq!(before[(hint_x, areas.tipline.y)].symbol(), "/");
        assert_eq!(
            before[(hint_x, areas.tipline.y)].fg,
            app.render_context().muted()
        );
        assert!(!app.handle_tick(started + Duration::from_secs(3)));
        assert_eq!(before, render_buffer(&app, 80, 20));
        assert!(app.handle_tick(started + Duration::from_secs(4)));
        let fading = render_buffer(&app, 80, 20);
        assert_eq!(fading, render_buffer(&app, 80, 20));
        let Color::Rgb(br, bg, bb) = app.render_context().background() else {
            unreachable!()
        };
        for (full, faded) in before.content.iter().zip(&fading.content) {
            assert_eq!(full.symbol(), faded.symbol());
        }
        // Only the transient hint fades; permission remains in the final row.
        for x in [hint_x, hint_x + 1, hint_x + 12] {
            let full = &before[(x, areas.tipline.y)];
            let faded = &fading[(x, areas.tipline.y)];
            let Color::Rgb(r, g, b) = full.fg else {
                unreachable!()
            };
            let Color::Rgb(fr, fg, fb) = faded.fg else {
                unreachable!()
            };
            assert_ne!(full.fg, faded.fg);
            assert_ne!(faded.fg, app.render_context().background());
            for (original, intermediate, background) in [(r, fr, br), (g, fg, bg), (b, fb, bb)] {
                assert!(intermediate.abs_diff(background) < original.abs_diff(background));
            }
        }
        for y in 0..20 {
            if y != areas.tipline.y {
                for x in 0..80 {
                    assert_eq!(before[(x, y)], fading[(x, y)]);
                }
            }
        }
        assert!(app.handle_tick(started + Duration::from_secs(5)));
        let hidden = render_buffer(&app, 80, 20);
        assert!(!(0..80).any(|x| hidden[(x, areas.tipline.y)].symbol() != " "));
        assert_eq!(layout(&app, area).session, areas);
        assert!(!app.handle_tick(started + Duration::from_secs(6)));
    }
}

#[test]
fn policy_changes_restart_the_fade_without_repeating_the_next_permission() {
    let mut app = App::new();
    let started = Instant::now();
    app.set_current_approval_mode(Some(ash_protocol::ApprovalMode::Manual));
    app.cycle_next_approval_mode(started);
    assert_eq!(app.approval_mode(), ash_protocol::ApprovalMode::Auto);
    let visible = render(&app, 120, 20);
    assert!(visible.contains("⏸ Manual"));
    assert!(!visible.contains("current:"));
    assert!(!visible.contains("next:"));
    assert!(!visible.lines().last().unwrap().contains("Auto"));
    crate::tui_assert_snapshot!(app = &app; "policy_top_tip_running_permission", visible);
    assert!(app.handle_tick(started + Duration::from_secs(4)));
    app.cycle_next_approval_mode(started + Duration::from_secs(4));
    assert_eq!(
        app.approval_mode(),
        ash_protocol::ApprovalMode::BypassPermissions
    );
    let restarted = render_buffer(&app, 120, 20);
    let row = layout(&app, Rect::new(0, 0, 120, 20))
        .session
        .footer
        .hintline
        .y;
    assert_eq!(restarted[(2, row)].fg, test_context().warning());
    assert!(!render(&app, 120, 20).contains("Bypass permissions"));
    assert!(!app.handle_tick(started + Duration::from_secs(7)));
    assert!(app.handle_tick(started + Duration::from_secs(9)));
    crate::tui_assert_snapshot!(app = &app; "policy_top_tip_expired", render(&app, 120, 20));
}

#[test]
fn notices_and_clipboard_tips_share_the_fullscreen_fade_and_refresh() {
    let started = Instant::now();
    for text in ["Copied", "image in clipboard · ctrl+v to paste"] {
        let mut app = App::new();
        if text == "Copied" {
            app.chat_panel.show_notice(text.into(), started);
        } else {
            app.chat_panel
                .show_clipboard_image(ClipboardImageFingerprint(1), started);
        }
        let area = Rect::new(0, 0, 80, 20);
        let row = layout(&app, area).session.tipline.y;
        let x = 78 - text.width() as u16;
        assert_eq!(
            render_buffer(&app, 80, 20)[(x, row)].fg,
            test_context().muted()
        );
        assert!(app.handle_tick(started + Duration::from_secs(4)));
        assert_ne!(
            render_buffer(&app, 80, 20)[(x, row)].fg,
            test_context().muted()
        );
        if text == "Copied" {
            app.chat_panel
                .show_notice(text.into(), started + Duration::from_secs(4));
        } else {
            app.chat_panel.show_clipboard_image(
                ClipboardImageFingerprint(2),
                started + Duration::from_secs(4),
            );
        }
        assert_eq!(
            render_buffer(&app, 80, 20)[(x, row)].fg,
            test_context().muted()
        );
        assert!(app.handle_tick(started + Duration::from_secs(9)));
        assert!(
            render(&app, 80, 20)
                .lines()
                .nth(usize::from(row))
                .unwrap()
                .trim()
                .is_empty()
        );
    }
}

#[test]
fn auto_theme_fades_to_the_reported_terminal_background_without_painting_it() {
    use crate::render::RenderTheme;
    use crate::render::ThemePalette;
    use ash_terminal_detection::ColorLevel;
    let mut app = App::new();
    app.update(crate::theme::Event::RenderChanged(
        RenderTheme::from_palette(ThemePalette::dark(), ColorLevel::TrueColor)
            .with_terminal_defaults()
            .with_terminal_background([0, 0, 0]),
    ));
    let started = Instant::now();
    app.show_policy_tip(started);
    assert!(app.handle_tick(started + Duration::from_secs(4)));
    let buffer = render_buffer(&app, 80, 20);
    let x = 78 - "/permission to change permissions".width() as u16;
    let cell = &buffer[(x, layout(&app, buffer.area).session.tipline.y)];
    let expected = app.render_context().fade_style(
        ratatui::style::Style::default().fg(app.render_context().muted()),
        0.5,
    );
    assert_eq!(cell.fg, expected.fg.unwrap());
    assert_eq!(cell.bg, Color::Reset);
    assert!(!cell.modifier.contains(Modifier::DIM));
}

#[test]
fn fullscreen_tip_respects_terminal_color_capabilities() {
    use crate::render::RenderTheme;
    use crate::render::ThemePalette;
    use ash_terminal_detection::ColorLevel;
    let started = Instant::now();
    for capability in [
        ColorLevel::Ansi256,
        ColorLevel::Ansi16,
        ColorLevel::Monochrome,
    ] {
        let mut app = App::new();
        app.update(crate::theme::Event::RenderChanged(
            RenderTheme::from_palette(ThemePalette::dark(), capability),
        ));
        app.show_policy_tip(started);
        app.handle_tick(started + Duration::from_millis(4500));
        let buffer = render_buffer(&app, 80, 20);
        let row = layout(&app, buffer.area).session.tipline.y;
        let x = 78 - "/permission to change permissions".width() as u16;
        let cell = &buffer[(x, row)];
        if capability == ColorLevel::Ansi256 {
            assert!(matches!(cell.fg, Color::Indexed(_)));
            assert_ne!(cell.fg, app.render_context().warning());
        } else {
            assert_eq!(cell.fg, app.render_context().muted());
            assert!(cell.modifier.contains(Modifier::DIM));
        }
    }
}

#[test]
fn policy_change_shows_the_new_mode_before_the_first_submission() {
    let mut app = App::new();
    enter_session(
        &mut app,
        "current",
        vec![manager_session("current", SessionManagerStatus::Idle, None)],
    );

    app.cycle_next_approval_mode(Instant::now());

    let rendered = render(&app, 80, 20);
    assert!(rendered.lines().last().unwrap().contains("← Dashboard"));
    assert!(rendered.contains("Auto"));
    assert!(rendered.contains("/permission to change permissions"));
}

#[test]
fn agent_thread_switcher_starts_at_the_empty_input_cursor_column() {
    let mut app = App::new();
    let session_id = SessionId::new("root").unwrap();
    let root_id = ThreadId::new("root").unwrap();
    app.update(ThreadEvent::ContextChanged {
        session_id: session_id.clone(),
        thread_id: root_id.clone(),
    });
    app.update(SessionEvent::CatalogReceived(vec![Session {
        session_id,
        title: "Session".into(),
        status: SessionStatus::Active,
        execution_target: None,
        model: None,
        manager: Default::default(),
        threads: vec![
            SessionThread {
                thread_id: root_id.clone(),
                title: "Main".into(),
                created_at_unix_ms: 1,
                completed_turn_duration_ms: 1_000,
                active_turn_started_at_unix_ms: None,
                usage: Default::default(),
                parent_thread_id: None,
                forked_from_id: None,
                status: ThreadStatus::Active,
            },
            SessionThread {
                thread_id: ThreadId::new("child").unwrap(),
                title: "Child".into(),
                created_at_unix_ms: 2,
                completed_turn_duration_ms: 2_000,
                active_turn_started_at_unix_ms: None,
                usage: Default::default(),
                parent_thread_id: Some(root_id),
                forked_from_id: None,
                status: ThreadStatus::Active,
            },
        ],
    }]));

    let rendered = render(&app, 40, 20);
    let main = rendered.lines().find(|line| line.contains("main")).unwrap();

    assert!(main.starts_with("  ● main"));
}

#[test]
fn multiline_chat_input_grows_upward_and_keeps_all_lines_visible() {
    let mut app = App::new();
    app.insert_text("first\nsecond\nthird");

    let terminal_area = Rect::new(0, 0, 80, 20);
    let input = layout(&app, terminal_area).input;
    let rendered = render(&app, terminal_area.width, terminal_area.height);
    let rows = rendered.lines().collect::<Vec<_>>();

    assert!(rows[usize::from(input.y + 1)].contains("first"));
    assert!(rows[usize::from(input.y + 2)].contains("second"));
    assert!(rows[usize::from(input.y + 3)].contains("third"));
    assert!(!rows[19].contains("permissions on"));
    assert!(
        rows[usize::from(
            layout(&app, Rect::new(0, 0, 80, 20))
                .session
                .footer
                .hintline
                .y
        )]
        .contains("⏸ Manual")
    );
}

#[test]
fn turn_activity_does_not_replace_the_permission_mode_in_the_final_row() {
    let mut app = App::new();
    app.update(ThreadEvent::TurnActivityChanged(TurnActivity::Working));
    let rendered = render(&app, 80, 20);
    let rows = rendered.lines().collect::<Vec<_>>();
    let areas = layout(&app, Rect::new(0, 0, 80, 20)).session;
    let statusline = rows[usize::from(areas.footer.statusline.y)];
    assert!(!statusline.contains("Manual"));
    assert!(!statusline.contains("Working"));
    assert_eq!(
        rows[usize::from(areas.footer.hintline.y)].trim(),
        "⏸ Manual · ← Dashboard · ? for shortcuts"
    );
}

#[test]
fn chat_input_soft_wraps_long_lines_instead_of_clipping_them() {
    let mut app = App::new();
    app.insert_text("abcdefghij");

    let terminal_area = Rect::new(0, 0, 12, 20);
    let input = layout(&app, terminal_area).input;
    let rendered = render(&app, terminal_area.width, terminal_area.height);
    let rows = rendered.lines().collect::<Vec<_>>();

    assert!(rows[usize::from(input.y + 1)].contains("> abcdef"));
    assert!(rows[usize::from(input.y + 2)].contains("  ghij"));
}

#[test]
fn modal_covers_the_page_and_restores_its_transcript_and_draft() {
    let mut app = App::new();
    app.update(ThreadEvent::ProductNotice(
        "Conversation remains visible.".into(),
    ));
    app.insert_text("draft");
    let area = Rect::new(0, 0, 80, 24);
    let before = render(&app, 80, 24);
    let composer = layout(&app, area).input;
    app.update(AppEvent::HelpOpened(help_view()));
    let rendered = render(&app, 80, 24);
    assert!(rendered.contains("Help"));
    assert!(rendered.contains("Search commands and shortcuts"));
    assert!(!rendered.contains("Conversation remains visible."));
    assert_eq!(layout(&app, area).input, composer);
    assert_eq!(app.input(), "draft");
    crate::tui_assert_snapshot!(app = &app; "help_modal", rendered);
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert_eq!(render(&app, 80, 24), before);
}

#[test]
fn command_panel_supports_keyboard_tab_switching_and_search() {
    let mut app = App::new();
    app.update(AppEvent::HelpOpened(help_view()));

    app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Char('e'), KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Char('s'), KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::NONE));

    let rendered = render(&app, 80, 24);
    assert!(rendered.contains("Esc"));
    assert!(rendered.find("Esc") < rendered.find("move selection"));

    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(app.list_selection().is_some());
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(app.list_selection().is_none());
}

#[test]
fn theme_candidate_focus_changes_content_without_repainting_modal_chrome() {
    let mut app = App::new();
    app.update(AppEvent::HelpOpened(ListSelectionModel::new(
        "Theme",
        vec![ListSelectionGroup::new(
            "Themes",
            vec![
                ListSelectionItem::new("First")
                    .with_selection_foreground(Color::LightRed)
                    .with_presentation_focus(Color::Red),
                ListSelectionItem::new("Second")
                    .with_selection_foreground(Color::LightGreen)
                    .with_presentation_focus(Color::Green),
            ],
        )],
    )));

    let area = Rect::new(0, 0, 80, 24);
    let modal = super::modal::layout_for(&app, area);
    let body = super::modal::body_area(app.command_panel().unwrap(), modal.content);
    let first = render_buffer(&app, 80, 24);
    assert_eq!(first[(body.x, body.y)].fg, Color::LightRed);
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    let second = render_buffer(&app, 80, 24);
    assert_eq!(second[(body.x, body.y + 1)].fg, Color::LightGreen);
    assert_eq!(
        first[(modal.surface.x, modal.surface.y)],
        second[(modal.surface.x, modal.surface.y)]
    );
    for y in 0..area.height {
        for x in 0..area.width {
            if !modal.surface.contains(ratatui::layout::Position::new(x, y)) {
                assert_eq!(second[(x, y)], first[(x, y)]);
            }
        }
    }
}

#[test]
fn completed_error_remains_visible_in_the_scrollable_transcript() {
    let mut app = App::new();
    app.update(ThreadEvent::FailureReported(
        "The configured model is unavailable.".into(),
    ));

    let rendered = render(&app, 80, 20);
    let rows = rendered.lines().collect::<Vec<_>>();

    assert!(rendered.contains("The configured model is unavailable."));
    assert!(rendered.contains("Manual"));
    assert!(!rows.iter().any(|line| line.trim() == "error"));
    assert!(!rows[19].contains("permissions on"));
    assert!(
        rows[usize::from(
            layout(&app, Rect::new(0, 0, 80, 20))
                .session
                .footer
                .hintline
                .y
        )]
        .contains("⏸ Manual")
    );
    assert!(!rendered.contains("ready to retry"));
    assert!(!rendered.contains("esc esc rewind"));
    assert!(!rendered.contains("StableTurnError"));
}

#[test]
fn submitted_slash_command_remains_in_the_scrollable_transcript() {
    let mut app = App::new();
    app.insert_text("/status");

    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    let rendered = render(&app, 80, 20);
    assert!(rendered.lines().any(|line| line.contains("> /status")));
}

#[test]
fn queued_local_command_updates_the_same_visible_transcript_cell() {
    let mut app = App::new();
    app.insert_text("/theme ash-code-light");
    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
            .is_some()
    );
    let pending = render(&app, 80, 20);
    assert_eq!(pending.matches("/theme ash-code-light").count(), 1);
    assert!(!pending.contains("Theme set to Light"));
    app.update(ThreadEvent::CommandStarted("/theme ash-code-light".into()));
    app.update(ThreadEvent::CommandCompleted {
        command: "/theme ash-code-light".into(),
        result: "Theme set to Light".into(),
    });
    let completed = render(&app, 80, 20);
    assert_eq!(completed.matches("/theme ash-code-light").count(), 1);
    assert_eq!(completed.matches("Theme set to Light").count(), 1);
}

#[test]
fn scrolled_transcript_shows_jump_control_at_the_bottom_of_the_content_area() {
    let mut app = App::new();
    for index in 0..8 {
        app.update(ThreadEvent::FailureReported(format!(
            "Model invocation failed {index}"
        )));
    }
    app.handle_key_in_area(
        KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE),
        Rect::new(0, 0, 50, 16),
    );

    crate::tui_assert_snapshot!(app = &app; "transcript_jump_to_bottom", render(&app, 50, 16));
    assert!(!app.transcript_selection_active());
    let mut settings = crate::config::TerminalSettings::default();
    settings.set_screen_mode(crate::terminal::ScreenMode::Inline);
    app.update(crate::config::Event::SettingsReceived(settings));
    assert!(app.transcript_scroll().anchor().is_none());
    app.handle_key_in_area(
        KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE),
        Rect::new(0, 0, 50, 16),
    );
    let screen = render(&app, 50, 16);
    assert!(screen.contains("Ctrl+End to jump to bottom ↓"));
    assert!(!screen.contains("(click)"));
}

#[test]
fn command_completion_renders_an_adjacent_result_line() {
    let mut app = App::new();
    app.update(ThreadEvent::CommandCompleted {
        command: "/theme ash-code-light".into(),
        result: "Theme set to Ash Code Light".into(),
    });

    app.handle_key_in_area(
        KeyEvent::new(KeyCode::Home, KeyModifiers::CONTROL),
        Rect::new(0, 0, 80, 20),
    );
    let rendered = render(&app, 80, 20);
    let rows = rendered.lines().collect::<Vec<_>>();
    let command_row = rows
        .iter()
        .position(|row| row.contains("> /theme ash-code-light"))
        .unwrap();

    assert!(rows[command_row + 1].contains("└─ Theme set to Ash Code Light"));
    assert!(rows[command_row + 2].trim().is_empty());
}

#[test]
fn transcript_content_aligns_with_the_composer_rule_and_prompt() {
    let mut app = App::new();
    app.update(ThreadEvent::CommandCompleted {
        command: "/theme ash-code-light".into(),
        result: "Theme set to Ash Code Light".into(),
    });
    app.insert_text("draft");

    let terminal_area = Rect::new(0, 0, 80, 20);
    app.handle_key_in_area(
        KeyEvent::new(KeyCode::Home, KeyModifiers::CONTROL),
        terminal_area,
    );
    let input = layout(&app, terminal_area).input;
    let buffer = render_buffer(&app, terminal_area.width, terminal_area.height);
    let transcript_row = (0..input.y)
        .find(|row| buffer[(2, *row)].symbol() == "/")
        .unwrap();

    assert_eq!(buffer[(2, transcript_row)].symbol(), "/");
    assert_eq!(buffer[(2, input.y + 1)].symbol(), ">");
    assert_eq!(buffer[(4, input.y + 1)].symbol(), "d");
}

#[test]
fn bare_slash_renders_the_first_command_window() {
    let mut app = App::new();
    app.insert_text("/");

    let rendered = render(&app, 80, 20);

    assert!(rendered.contains("/status"));
    assert!(rendered.contains("/statusline"));
    assert!(rendered.contains("/skills"));
    assert!(rendered.contains("/memories"));
    assert!(rendered.contains("/context"));
    assert!(!rendered.contains("/mcp"));
    assert!(rendered.contains("/usage"));
    assert!(!rendered.contains("/resume"));
    assert!(!rendered.contains("/archive-thread"));
    assert!(!rendered.contains("/archive-session"));
    assert!(!rendered.contains("/thread "));
    assert!(!rendered.contains("/login"));
    assert!(!rendered.contains("/plugins"));
}

#[test]
fn hooks_slash_completion_is_visible() {
    let mut app = App::new();
    app.insert_text("/hooks");
    let rendered = render(&app, 80, 20);
    assert!(rendered.contains("/hooks"));
    crate::tui_assert_snapshot!(app = &app; "hooks_slash_completion", rendered);
}

#[test]
fn hooks_panel_opens_fullscreen_and_restores_input_after_close() {
    let mut app = App::new();
    app.insert_text("keep this draft");
    app.update(crate::hooks::Event::Opened(
        crate::test_support::hook_catalog(vec![]),
    ));
    assert_eq!(app.list_selection().unwrap().title(), "Extensions");
    crate::tui_assert_snapshot!(app = &app; "hooks_fullscreen", render(&app, 80, 20));
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(app.command_panel().is_none());
    assert!(app.input().contains("keep this draft"));
}

#[test]
fn hooks_event_details_and_configuration_render_fullscreen() {
    use ash_app_server_protocol::protocol::config::HookActionDto;
    use ash_app_server_protocol::protocol::config::HookConfigDto;
    use ash_app_server_protocol::protocol::config::HookEnablementDto;
    use ash_app_server_protocol::protocol::config::HookEventDto;
    use ash_app_server_protocol::protocol::config::HookMatcherDto;
    let hook = HookConfigDto {
        id: "user:hook:review".into(),
        event: HookEventDto::PreToolUse,
        matcher: HookMatcherDto {
            tool_names: vec!["exec_command".into()],
        },
        action: HookActionDto::Process {
            program: "review-hook".into(),
            args: vec!["--check".into()],
        },
        enablement: HookEnablementDto::Disabled,
    };
    let mut app = App::new();
    app.update(crate::hooks::Event::Opened(
        crate::test_support::hook_catalog(vec![hook]),
    ));
    assert_eq!(
        app.list_selection().unwrap().visible_items()[0].label(),
        "PreToolUse (1)"
    );
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    assert_eq!(app.list_selection().unwrap().title(), "PreToolUse");
    crate::tui_assert_snapshot!(app = &app; "hooks_event_picker", render(&app, 80, 20));
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    assert_eq!(app.list_selection().unwrap().title(), "user:hook:review");
    crate::tui_assert_snapshot!(app = &app; "hooks_detail", render(&app, 80, 20));
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    app.panels_mut()
        .command_mut()
        .unwrap()
        .list_selection_mut()
        .unwrap()
        .focus_pointer(&crate::widgets::list_selection::ListSelectionPointerTarget::Action);
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    assert_eq!(app.list_selection().unwrap().title(), "Configure Hooks");
    crate::tui_assert_snapshot!(app = &app; "hooks_editor", render(&app, 80, 20));
}

#[test]
fn slash_popup_clears_covered_transcript_rows_edge_to_edge() {
    let mut app = App::new();
    app.update(ModelEvent::SummaryReceived(configured_model_summary()));
    for index in 0..12 {
        app.update(ThreadEvent::FailureReported(format!(
            "Model invocation failed {index} {}",
            "underlying transcript content ".repeat(4)
        )));
    }
    app.insert_text("/");

    let terminal_area = Rect::new(0, 0, 80, 20);
    let popup_bottom = layout(&app, terminal_area).input.y;
    let popup_top = popup_bottom - 6;
    let popup_border = popup_top - 1;
    let buffer = render_buffer(&app, terminal_area.width, terminal_area.height);
    let (selected, command_count) = match app.completion().unwrap() {
        CompletionView::Slash(view) => (view.selected, view.commands.len()),
        _ => panic!("expected Slash Commands completion"),
    };
    let position = format!(" {}/{} ", selected.unwrap() + 1, command_count);
    let position_start = terminal_area.width - 2 - position.len() as u16;

    for column in 2..position_start {
        assert_eq!(buffer[(column, popup_border)].symbol(), "─");
        assert_eq!(buffer[(column, popup_border)].fg, test_context().border());
        assert_eq!(
            buffer[(column, popup_border)].bg,
            test_context().background()
        );
    }
    for (offset, character) in position.chars().enumerate() {
        let cell = &buffer[(position_start + offset as u16, popup_border)];
        assert_eq!(cell.symbol(), character.to_string());
        assert_eq!(cell.fg, test_context().muted());
        assert_eq!(cell.bg, test_context().background());
    }
    for column in [0, 1, terminal_area.width - 2, terminal_area.width - 1] {
        assert_eq!(buffer[(column, popup_border)].symbol(), " ");
        assert_eq!(
            buffer[(column, popup_border)].bg,
            test_context().background()
        );
    }
    for row in popup_top..popup_bottom {
        assert_eq!(buffer[(0, row)].symbol(), " ");
        assert_eq!(buffer[(0, row)].bg, test_context().background());
        assert_eq!(buffer[(79, row)].bg, test_context().background());
    }
    assert_eq!(buffer[(79, popup_top)].symbol(), "┃");
    assert_eq!(buffer[(79, popup_top)].fg, test_context().muted());
    assert_eq!(buffer[(79, popup_bottom - 1)].symbol(), "│");
    assert_eq!(buffer[(79, popup_bottom - 1)].fg, test_context().border());
    crate::tui_assert_snapshot!(
        app = &app;
        "slash_popup_clears_covered_transcript_rows_edge_to_edge",
        render(&app, terminal_area.width, terminal_area.height)
    );
}

#[test]
fn slash_popup_uses_focus_colored_text_without_a_selection_surface() {
    let mut app = App::new();
    app.insert_text("/");

    let terminal_area = Rect::new(0, 0, 80, 20);
    let popup_top = layout(&app, terminal_area).input.y - 6;
    let buffer = render_buffer(&app, terminal_area.width, terminal_area.height);
    let selected = &buffer[(2, popup_top)];
    let unselected = &buffer[(2, popup_top + 1)];
    let surface_background = test_context().background();

    assert_eq!(selected.fg, test_context().focus());
    assert_eq!(selected.bg, surface_background);
    assert_eq!(selected.symbol(), "/");
    assert!(!selected.modifier.contains(Modifier::BOLD));
    assert_eq!(unselected.fg, test_context().muted());
    assert_eq!(unselected.bg, surface_background);
    assert_eq!(unselected.symbol(), "/");
    assert!(!unselected.modifier.contains(Modifier::BOLD));

    app.fullscreen
        .pointer
        .update_hover(Some(PointerTarget::Composer(
            ChatComposerPointerTarget::CompletionItem(2),
        )));
    let hovered_buffer = render_buffer(&app, terminal_area.width, terminal_area.height);
    let hovered = &hovered_buffer[(2, popup_top + 2)];
    assert_eq!(hovered.fg, test_context().focus());
    assert_eq!(hovered.bg, surface_background);
    assert!(!hovered.modifier.contains(Modifier::BOLD));

    let mut prefix_app = App::new();
    prefix_app.insert_text("/confi");
    let command_row = render(&prefix_app, 80, 20)
        .lines()
        .position(|line| line.contains("/config"))
        .unwrap() as u16;
    let prefix_buffer = render_buffer(&prefix_app, 80, 20);
    assert_eq!(prefix_buffer[(3, command_row)].fg, test_context().focus());
    assert!(
        prefix_buffer[(3, command_row)]
            .modifier
            .contains(Modifier::BOLD)
    );
}

#[test]
fn slash_popup_hit_testing_maps_visible_rows_and_rejects_outside_clicks() {
    let mut app = App::new();
    app.insert_text("/");
    let terminal_area = Rect::new(0, 0, 80, 20);
    let popup_bottom = layout(&app, terminal_area).input.y;
    let popup_top = popup_bottom - 6;

    assert_eq!(
        input_overlay_index_at(&app, terminal_area, 2, popup_top),
        Some(0)
    );
    assert_eq!(
        input_overlay_index_at(&app, terminal_area, 77, popup_bottom - 1),
        Some(5)
    );
    assert_eq!(
        input_overlay_index_at(&app, terminal_area, 78, popup_bottom - 1),
        None
    );
    assert_eq!(
        input_overlay_index_at(&app, terminal_area, 79, popup_bottom - 1),
        None
    );
    assert_eq!(
        target_at(&app, terminal_area, 79, popup_bottom - 1),
        Some(PointerTarget::Composer(
            ChatComposerPointerTarget::CompletionSurface
        ))
    );
    assert_eq!(
        input_overlay_index_at(&app, terminal_area, 1, popup_top),
        None
    );
    assert_eq!(
        input_overlay_index_at(&app, terminal_area, 2, popup_bottom),
        None
    );

    for _ in 0..7 {
        app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    }
    assert_eq!(
        input_overlay_index_at(&app, terminal_area, 2, popup_top),
        Some(2)
    );
    assert_eq!(
        input_overlay_index_at(&app, terminal_area, 2, popup_bottom - 1),
        Some(7)
    );
}

#[test]
fn slash_popup_position_and_scrollbar_follow_keyboard_navigation() {
    let mut app = App::new();
    app.insert_text("/");
    app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));

    let terminal_area = Rect::new(0, 0, 80, 20);
    let popup_bottom = layout(&app, terminal_area).input.y;
    let (selected, command_count) = match app.completion().unwrap() {
        CompletionView::Slash(view) => (view.selected, view.commands.len()),
        _ => panic!("expected Slash Commands completion"),
    };
    assert_eq!(selected, Some(command_count - 1));

    let rendered = render(&app, terminal_area.width, terminal_area.height);
    assert!(rendered.contains(&format!(" {command_count}/{command_count} ")));
    let buffer = render_buffer(&app, terminal_area.width, terminal_area.height);
    assert_eq!(buffer[(79, popup_bottom - 1)].symbol(), "┃");
    assert_eq!(buffer[(79, popup_bottom - 1)].fg, test_context().muted());
    crate::tui_assert_snapshot!(app = &app; "slash_popup_scrolled_to_last_command", rendered);
}

#[test]
fn slash_popup_wraps_descriptions_to_two_clickable_lines_and_truncates_the_rest() {
    let slash_commands = SlashCommandCatalog::with_local_and_server(
        built_in_slash_command_definitions(),
        [SlashCommandDefinition {
            name: "diagnose".into(),
            description: "one two three four five six seven eight nine ten".into(),
            argument_mode: SlashCommandArgumentMode::Optional,
            argument_hint: None,
        }],
    )
    .unwrap();
    let mut app = App::for_dir_with_slash_commands(Path::new("."), slash_commands);
    app.insert_text("/diagnose");
    let terminal_area = Rect::new(0, 0, 50, 20);
    let popup_bottom = layout(&app, terminal_area).input.y;
    let popup_top = popup_bottom - 2;

    let rendered = render(&app, 50, 20);
    let rows = rendered.lines().collect::<Vec<_>>();

    assert!(rows[usize::from(popup_top)].contains("one two three four"));
    assert!(rows[usize::from(popup_top + 1)].contains("five six seven"));
    assert!(!rendered.contains("eight"));
    assert_eq!(
        input_overlay_index_at(&app, terminal_area, 29, popup_top),
        Some(0)
    );
    assert_eq!(
        input_overlay_index_at(&app, terminal_area, 29, popup_top + 1),
        Some(0)
    );
    assert_eq!(
        input_overlay_index_at(&app, terminal_area, 29, popup_top - 1),
        None
    );
}

#[test]
fn skill_popup_wraps_descriptions_to_two_clickable_lines_and_truncates_the_rest() {
    let slash_commands = SlashCommandCatalog::with_local_and_server(
        built_in_slash_command_definitions(),
        std::iter::empty(),
    )
    .unwrap();
    let skill = SkillRef::pinned(
        SkillId::new(
            SkillSourceId::new("user:skill-source:test").unwrap(),
            SkillName::new("diagnose").unwrap(),
        ),
        ContentDigest::sha256(b"diagnose skill"),
    );
    let mut app = App::for_dir_with_slash_commands(Path::new("."), slash_commands.clone());
    app.replace_chat_input_catalog(ChatInputCatalog::new(
        slash_commands,
        vec![SkillCompletionItem::new(
            "diagnose".into(),
            "one two three four five six seven eight nine ten".into(),
            skill,
        )],
        Vec::new(),
    ));
    app.insert_text("$diagnose");
    let terminal_area = Rect::new(0, 0, 36, 20);
    let popup_bottom = layout(&app, terminal_area).input.y;
    let popup_top = popup_bottom - 2;

    let rendered = render(&app, 36, 20);
    let rows = rendered.lines().collect::<Vec<_>>();

    assert!(rows[usize::from(popup_top)].contains("one two three four"));
    assert!(rows[usize::from(popup_top + 1)].contains("five six seven eight"));
    assert!(!rendered.contains("nine"));
    assert_eq!(
        input_overlay_index_at(&app, terminal_area, 2, popup_top),
        Some(0)
    );
    assert_eq!(
        input_overlay_index_at(&app, terminal_area, 2, popup_top + 1),
        Some(0)
    );
    assert_eq!(
        input_overlay_index_at(&app, terminal_area, 2, popup_top - 1),
        None
    );
}

#[test]
fn empty_slash_popup_has_no_clickable_command_rows() {
    let mut app = App::new();
    app.insert_text("/unknown");

    assert_eq!(
        input_overlay_index_at(&app, Rect::new(0, 0, 80, 20), 2, 15),
        None
    );
}

#[test]
fn slash_query_filters_the_rendered_commands() {
    let mut app = App::new();
    app.insert_text("/q");

    let rendered = render(&app, 80, 20);

    assert!(rendered.contains("/quit"));
    assert!(!rendered.contains("/exit"));
}

#[test]
fn slash_popup_suggests_a_command_when_the_query_omits_a_character() {
    let mut app = App::new();
    app.insert_text("/cofig");

    let CompletionView::Slash(view) = app.completion().unwrap() else {
        panic!("expected Slash Command completion");
    };
    assert_eq!(
        view.commands
            .iter()
            .map(|command| command.name.as_str())
            .collect::<Vec<_>>(),
        ["config", "mcp"]
    );
    assert_eq!(view.selected, None);
    let rendered = render(&app, 80, 20);
    assert!(rendered.contains("/config"));
    assert!(!rendered.contains("No matching commands"));
    let first_row = layout(&app, Rect::new(0, 0, 80, 20)).input.y - 2;
    let buffer = render_buffer(&app, 80, 20);
    assert_eq!(buffer[(2, first_row)].fg, test_context().muted());
    assert_eq!(buffer[(3, first_row)].symbol(), "c");
    assert_eq!(buffer[(3, first_row)].fg, test_context().foreground());
    assert!(buffer[(3, first_row)].modifier.contains(Modifier::BOLD));
    assert_eq!(buffer[(5, first_row)].symbol(), "n");
    assert!(!buffer[(5, first_row)].modifier.contains(Modifier::BOLD));
    assert_eq!(buffer[(34, first_row + 1)].symbol(), "c");
    assert!(
        buffer[(34, first_row + 1)]
            .modifier
            .contains(Modifier::BOLD)
    );
    crate::tui_assert_snapshot!(app = &app; "slash_popup_missing_character_match", rendered);

    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)),
        None
    );
    assert_eq!(app.input(), "/cofig");
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
    assert_eq!(app.input(), "/config ");
}

#[test]
fn unmatched_slash_query_keeps_a_visible_empty_popup() {
    let mut app = App::new();
    app.insert_text("/unknown");

    let rendered = render(&app, 80, 20);

    assert!(rendered.contains("No matching commands"));
}

#[test]
fn escape_dismisses_the_slash_popup_without_clearing_input() {
    let mut app = App::new();
    app.insert_text("/");

    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));

    let rendered = render(&app, 80, 20);
    assert!(!rendered.contains("/quit"));
    assert!(!rendered.contains("/exit"));
    assert_eq!(app.input(), "/");
}

#[test]
fn mention_popup_keeps_its_layout_and_highlights_fuzzy_matches() {
    let dir = std::env::temp_dir().join(format!(
        "ash-tui-render-mention-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(dir.join("docs")).unwrap();
    fs::create_dir_all(dir.join("src")).unwrap();
    fs::write(dir.join("docs/src-notes.md"), "notes").unwrap();
    fs::write(dir.join("src/lib.rs"), "lib").unwrap();
    let mut app = App::for_dir(&dir);
    app.insert_text("@src");
    wait_for_mention_results(&mut app, &dir);
    let terminal_area = Rect::new(0, 0, 80, 20);

    let buffer = render_buffer(&app, 80, 20);
    let Some(crate::thread::composer::CompletionView::Mention(popup)) = app.completion() else {
        panic!("expected mention suggestions");
    };
    let popup_top = layout(&app, terminal_area)
        .input
        .y
        .saturating_sub(popup.matches.len().min(2) as u16);
    for (row, matched) in popup.matches.iter().take(2).enumerate() {
        let screen_row = popup_top + row as u16;
        assert_eq!(buffer[(2, screen_row)].symbol(), "+");
        for (column, character) in matched.label.chars().enumerate() {
            assert_eq!(
                buffer[(column as u16 + 4, screen_row)].symbol(),
                character.to_string()
            );
        }
    }
    assert_eq!(
        buffer[(4, layout(&app, terminal_area).input.y + 1)].symbol(),
        "@"
    );
    let second = &popup.matches[1];
    let matched_index = second.indices[0];
    let unmatched_index = (0..second.label.chars().count())
        .find(|index| !second.indices.contains(index))
        .unwrap();
    assert!(
        buffer[(matched_index as u16 + 4, popup_top + 1)]
            .modifier
            .contains(Modifier::BOLD)
    );
    assert_eq!(
        buffer[(matched_index as u16 + 4, popup_top + 1)].fg,
        test_context().foreground()
    );
    assert!(
        !buffer[(unmatched_index as u16 + 4, popup_top + 1)]
            .modifier
            .contains(Modifier::BOLD)
    );
    assert_eq!(
        buffer[(unmatched_index as u16 + 4, popup_top + 1)].fg,
        test_context().muted()
    );
    assert_eq!(
        input_overlay_index_at(&app, terminal_area, 2, popup_top),
        Some(0)
    );
    assert_eq!(
        input_overlay_index_at(&app, terminal_area, 2, popup_top + 1),
        Some(1)
    );
    assert_eq!(
        input_overlay_index_at(&app, terminal_area, 1, popup_top + 1),
        None
    );
    let _ = fs::remove_dir_all(dir);
}

fn manager_session(
    id: &str,
    status: SessionManagerStatus,
    activity: Option<SessionManagerActivity>,
) -> Session {
    let session_id = SessionId::new(id).unwrap();
    Session {
        model: None,
        session_id: session_id.clone(),
        title: id.into(),
        status: if status == SessionManagerStatus::Completed {
            SessionStatus::Archived
        } else {
            SessionStatus::Active
        },
        execution_target: None,
        manager: SessionManagerInfo {
            status,
            status_changed_at_unix_ms: current_unix_millis().saturating_sub(5_000),
            activity,
            summary: None,
        },
        threads: vec![SessionThread {
            thread_id: ThreadId::new(id).unwrap(),
            title: "main".into(),
            created_at_unix_ms: 0,
            completed_turn_duration_ms: 0,
            active_turn_started_at_unix_ms: None,
            usage: Default::default(),
            parent_thread_id: None,
            forked_from_id: None,
            status: if status == SessionManagerStatus::Completed {
                ThreadStatus::Archived
            } else {
                ThreadStatus::Active
            },
        }],
    }
}

fn enter_session(app: &mut App, id: &str, catalog: Vec<Session>) {
    app.update(ThreadEvent::ContextChanged {
        session_id: SessionId::new(id).unwrap(),
        thread_id: ThreadId::new(id).unwrap(),
    });
    app.update(SessionEvent::CatalogReceived(catalog));
}

fn current_unix_millis() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap()
}

fn render(app: &App, width: u16, height: u16) -> String {
    let buffer = render_buffer(app, width, height);
    (0..height)
        .map(|y| {
            (0..width)
                .map(|x| buffer[(x, y)].symbol())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn render_visible_text(app: &App, width: u16, height: u16) -> String {
    let buffer = render_buffer(app, width, height);
    (0..height)
        .map(|y| {
            let mut line = String::new();
            let mut continuation = 0;
            for x in 0..width {
                if continuation > 0 {
                    continuation -= 1;
                    continue;
                }
                let symbol = buffer[(x, y)].symbol();
                line.push_str(symbol);
                continuation = UnicodeWidthStr::width(symbol).saturating_sub(1);
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn config_general_tab_uses_localized_label() {
    let mut app = App::new();
    let mut settings = crate::config::TerminalSettings::default();
    settings.set_language(crate::nls::Language::Chinese);
    app.update(crate::config::Event::EditorOpened(
        crate::config::config_choices(
            &crate::test_support::empty_config_snapshot(),
            &ash_app_server_protocol::protocol::provider::ProviderListResult {
                providers: Vec::new(),
            },
            settings,
            StatusLineSettings::default(),
        ),
    ));
    for _ in 0..6 {
        app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    }
    crate::tui_assert_snapshot!(app = &app; "config_general_tab", render(&app, 100, 21));
}

#[test]
fn config_providers_show_subscription_and_api_sections() {
    use ash_app_server_protocol::protocol::provider::ProviderApiKeyPolicyDto;
    use ash_app_server_protocol::protocol::provider::ProviderCatalogEntryDto;
    use ash_app_server_protocol::protocol::provider::ProviderListResult;

    let mut app = App::new();
    let mut settings = crate::config::TerminalSettings::default();
    settings.set_language(crate::nls::Language::Chinese);
    app.update(crate::config::Event::SettingsReceived(settings));
    app.update(crate::config::Event::EditorOpened(
        crate::config::config_choices(
            &crate::test_support::empty_config_snapshot(),
            &ProviderListResult {
                providers: vec![
                    ProviderCatalogEntryDto {
                        connection: "chatgpt-subscription".into(),
                        provider: "openai".into(),
                        display_name: "ChatGPT".into(),
                        access: ash_protocol::ModelAccess::Subscription,
                        active: false,
                        configured: false,
                        ready: false,
                        api_key_policy: ProviderApiKeyPolicyDto::Unsupported,
                        api_key_configured: false,
                    },
                    ProviderCatalogEntryDto {
                        connection: "openai".into(),
                        access: ash_protocol::ModelAccess::ApiKey,
                        active: false,
                        configured: false,
                        ready: false,
                        provider: "openai".into(),
                        display_name: "OpenAI".into(),
                        api_key_policy: ProviderApiKeyPolicyDto::Required,
                        api_key_configured: false,
                    },
                    ProviderCatalogEntryDto {
                        connection: "kimi-subscription".into(),
                        provider: "kimi".into(),
                        display_name: "Kimi".into(),
                        access: ash_protocol::ModelAccess::Subscription,
                        active: false,
                        configured: false,
                        ready: false,
                        api_key_policy: ProviderApiKeyPolicyDto::Unsupported,
                        api_key_configured: false,
                    },
                    ProviderCatalogEntryDto {
                        connection: "kimi".into(),
                        access: ash_protocol::ModelAccess::ApiKey,
                        active: false,
                        configured: false,
                        ready: false,
                        provider: "kimi".into(),
                        display_name: "Kimi".into(),
                        api_key_policy: ProviderApiKeyPolicyDto::Required,
                        api_key_configured: false,
                    },
                    ProviderCatalogEntryDto {
                        connection: "zai".into(),
                        access: ash_protocol::ModelAccess::ApiKey,
                        active: false,
                        configured: false,
                        ready: false,
                        provider: "glm".into(),
                        display_name: "Z.ai API".into(),
                        api_key_policy: ProviderApiKeyPolicyDto::Required,
                        api_key_configured: false,
                    },
                    ProviderCatalogEntryDto {
                        connection: "bigmodel".into(),
                        access: ash_protocol::ModelAccess::ApiKey,
                        active: false,
                        configured: false,
                        ready: false,
                        provider: "bigmodel".into(),
                        display_name: "BigModel API".into(),
                        api_key_policy: ProviderApiKeyPolicyDto::Required,
                        api_key_configured: false,
                    },
                    ProviderCatalogEntryDto {
                        connection: "bigmodel-coding-plan".into(),
                        access: ash_protocol::ModelAccess::Subscription,
                        active: true,
                        configured: true,
                        ready: true,
                        provider: "bigmodel-coding-plan".into(),
                        display_name: "BigModel Coding Plan".into(),
                        api_key_policy: ProviderApiKeyPolicyDto::Required,
                        api_key_configured: false,
                    },
                    ProviderCatalogEntryDto {
                        connection: "zai-coding-plan".into(),
                        access: ash_protocol::ModelAccess::Subscription,
                        active: false,
                        configured: false,
                        ready: false,
                        provider: "zai-coding-plan".into(),
                        display_name: "Z.ai Coding Plan".into(),
                        api_key_policy: ProviderApiKeyPolicyDto::Required,
                        api_key_configured: false,
                    },
                    ProviderCatalogEntryDto {
                        connection: "ollama".into(),
                        access: ash_protocol::ModelAccess::ApiKey,
                        active: false,
                        configured: false,
                        ready: false,
                        provider: "ollama".into(),
                        display_name: "Ollama".into(),
                        api_key_policy: ProviderApiKeyPolicyDto::Unsupported,
                        api_key_configured: false,
                    },
                    ProviderCatalogEntryDto {
                        connection: "xai-subscription".into(),
                        provider: "xai".into(),
                        display_name: "Super Grok".into(),
                        access: ash_protocol::ModelAccess::Subscription,
                        active: true,
                        configured: true,
                        ready: true,
                        api_key_policy: ProviderApiKeyPolicyDto::Unsupported,
                        api_key_configured: false,
                    },
                    ProviderCatalogEntryDto {
                        connection: "xai".into(),
                        access: ash_protocol::ModelAccess::ApiKey,
                        active: false,
                        configured: false,
                        ready: false,
                        provider: "xai".into(),
                        display_name: "xAI".into(),
                        api_key_policy: ProviderApiKeyPolicyDto::Required,
                        api_key_configured: false,
                    },
                    ProviderCatalogEntryDto {
                        connection: "google".into(),
                        access: ash_protocol::ModelAccess::ApiKey,
                        active: true,
                        configured: true,
                        ready: true,
                        provider: "google".into(),
                        display_name: "Google".into(),
                        api_key_policy: ProviderApiKeyPolicyDto::Required,
                        api_key_configured: true,
                    },
                ],
            },
            settings,
            StatusLineSettings::default(),
        ),
    ));
    app.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    assert_eq!(
        app.list_selection()
            .unwrap()
            .selected_item()
            .unwrap()
            .label(),
        "Kimi"
    );
    for label in ["BigModel", "Super Grok", "Google"] {
        let item = app
            .list_selection()
            .unwrap()
            .visible_items()
            .into_iter()
            .find(|item| item.label() == label)
            .unwrap();
        assert_eq!(item.description(), None);
    }
    crate::tui_assert_snapshot!(app = &app; "config_providers_sections", render(&app, 100, 34));
}

#[test]
fn config_issues_tab_shows_one_auto_refresh_value() {
    let mut app = App::new();
    let mut config = crate::test_support::empty_config_snapshot();
    config.issues.auto_refresh_minutes = 0;
    config.issues.auto_refresh_minutes = 0;
    app.update(crate::config::Event::EditorOpened(
        crate::config::config_choices(
            &config,
            &ash_app_server_protocol::protocol::provider::ProviderListResult {
                providers: Vec::new(),
            },
            crate::config::TerminalSettings::default(),
            StatusLineSettings::default(),
        ),
    ));
    app.handle_key(KeyEvent::new(KeyCode::BackTab, KeyModifiers::SHIFT));
    app.handle_key(KeyEvent::new(KeyCode::BackTab, KeyModifiers::SHIFT));
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));

    let selection = app.list_selection().unwrap();
    assert_eq!(selection.active_tab().label(), "Issues");
    assert_eq!(selection.selected_item().unwrap().label(), "Auto refresh");
    crate::tui_assert_snapshot!(
        app = &app;
        "config_issues_tab_shows_one_auto_refresh_value",
        render(&app, 100, 20)
    );
}

fn custom_provider_app() -> App {
    let mut app = App::new();
    app.update(crate::config::Event::EditorOpened(
        crate::config::config_choices(
            &crate::test_support::empty_config_snapshot(),
            &ash_app_server_protocol::protocol::provider::ProviderListResult {
                providers: Vec::new(),
            },
            crate::config::TerminalSettings::default(),
            StatusLineSettings::default(),
        ),
    ));
    for key in [
        KeyCode::Up,
        KeyCode::Up,
        KeyCode::Tab,
        KeyCode::Down,
        KeyCode::Down,
        KeyCode::Down,
        KeyCode::Down,
        KeyCode::Enter,
    ] {
        app.handle_key(KeyEvent::new(key, KeyModifiers::NONE));
    }
    app
}

#[test]
fn short_provider_modal_scrolls_to_each_focused_field() {
    let mut app = custom_provider_app();
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    let output = render(&app, 100, 17);
    let buffer = render_buffer(&app, 100, 17);
    let content = super::modal::layout_for(&app, Rect::new(0, 0, 100, 17)).content;
    let base_row = output
        .lines()
        .position(|line| line.contains("> Base URL"))
        .unwrap() as u16;
    assert_eq!(buffer[(content.x - 2, base_row)].symbol(), ">");
    assert_eq!(buffer[(content.x, base_row)].symbol(), "B");
    assert_eq!(buffer[(content.x - 2, base_row + 1)].symbol(), " ");
    assert_eq!(buffer[(content.x, base_row + 1)].symbol(), "╭");
    assert_eq!(buffer[(content.x, base_row + 2)].symbol(), "│");
    assert!(output.contains("> Base URL"));
    crate::tui_assert_snapshot!(app = &app; "short_provider_panel", output);
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    let next = render(&app, 100, 17);
    assert!(next.contains("> API key"));
    assert!(next.contains("API key (optional)"));
    crate::tui_assert_snapshot!(app = &app; "short_provider_modal_api_key", next);
}

#[test]
fn custom_provider_form_renders_fields_and_masks_the_key() {
    let mut app = custom_provider_app();
    for width in [60, 100] {
        let output = render(&app, width, 40);
        for label in [
            "Provider name",
            "Base URL",
            "API key",
            "API type",
            "Model ID",
            "Model context window",
        ] {
            assert!(
                output.contains(label),
                "missing {label} at width {width}: {output}"
            );
        }
    }
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    app.handle_paste("never-display-this-key".into());
    let output = render(&app, 100, 40);
    assert!(output.contains("API key"));
    assert!(!output.contains("never-display-this-key"));
}

fn help_view() -> ListSelectionModel {
    ListSelectionModel::new(
        "Help",
        vec![
            ListSelectionGroup::new(
                "Commands",
                vec![
                    ListSelectionItem::new("/status").with_description("show status"),
                    ListSelectionItem::new("/model").with_description("show model"),
                ],
            ),
            ListSelectionGroup::new(
                "Keys",
                vec![
                    ListSelectionItem::new("↑ / ↓").with_description("move selection"),
                    ListSelectionItem::new("Esc").with_description("return to chat_input"),
                ],
            ),
        ],
    )
    .with_search(SearchBoxModel::new("Search commands and shortcuts"))
}

fn wait_for_mention_results(app: &mut App, dir: &Path) {
    let mut file_search = FileSearchManager::new(dir.to_path_buf());
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(query) = app.mention_query() {
            file_search.update_query(query);
        } else {
            file_search.stop();
        }
        for snapshot in file_search.poll() {
            app.update(ThreadEvent::FileSearchSnapshotReceived(snapshot));
        }
        if matches!(
            app.completion(),
            Some(crate::thread::composer::CompletionView::Mention(popup))
                if popup.matches.len() >= 2
        ) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for mention render results"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn render_buffer(app: &App, width: u16, height: u16) -> Buffer {
    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|frame| draw(frame, app)).unwrap();
    terminal.backend().buffer().clone()
}

fn configured_model_summary() -> ModelSummary {
    let preferred = ModelRefDto {
        provider: "anthropic".into(),
        model: "claude-sonnet".into(),
    };
    let catalog = ash_app_server_protocol::protocol::model::ModelListResult {
        models: vec![
            ash_app_server_protocol::protocol::model::ModelCatalogEntry {
                discovered: None,
                model: ash_protocol::ModelRef::new(
                    ash_protocol::ProviderId::new("anthropic").unwrap(),
                    ash_protocol::ModelId::new("claude-sonnet").unwrap(),
                ),
                display_name: "Claude Sonnet".into(),

                context_window: Some(200_000),

                maximum_context_window: Some(200_000),
                default_context_window: Some(200_000),
                context_window_options: vec![200_000],
                fast_enabled: false,
                auto_compact_token_limit: None,
                available_context_window: Some(180_000),
                capabilities: ash_protocol::ModelCapabilities::UNKNOWN,
                supported_reasoning_efforts: vec![ReasoningEffort::Medium, ReasoningEffort::High],
                model_reasoning_effort: Some(ReasoningEffort::High),
                default_personality: None,
            },
        ],
    };
    ModelSummary::from_catalog(Some(preferred), None, Some(&catalog))
}

#[test]
fn detail_modal_keeps_scrolled_content_above_page_hintline() {
    use crate::widgets::detail_list::DetailList;
    use crate::widgets::detail_list::DetailListRow;
    for height in [2, 3, 4, 8, 24] {
        let mut app = App::new();
        app.show_overlay(DetailList::new(
            "Output",
            vec![DetailListRow::new(
                "stdout",
                (0..40)
                    .map(|i| format!("line {i}"))
                    .collect::<Vec<_>>()
                    .join("\n"),
            )],
        ));
        let area = Rect::new(0, 0, 80, height);
        let modal = super::modal::layout_for(&app, area);
        let hintline = layout(&app, area).session.footer.hintline;
        assert!(modal.content.bottom() <= hintline.y);
        app.handle_key_in_area(KeyEvent::new(KeyCode::End, KeyModifiers::NONE), area);
        let rendered = render(&app, 80, height);
        if !hintline.is_empty() {
            assert!(
                rendered
                    .lines()
                    .nth(usize::from(hintline.y))
                    .unwrap()
                    .contains("Esc to close")
            );
            assert_eq!(rendered.matches("Esc to close").count(), 1);
        }
        if height >= 8 {
            assert!(rendered.contains("line 39"));
        }
    }
}

#[test]
fn issue_manager_reserves_page_height_when_the_transcript_is_empty() {
    let mut app = App::new();
    app.insert_text("/issue");
    assert!(matches!(
        app.handle_key(crate::keymap::KeyEvent::new(
            crossterm::event::KeyCode::Enter,
            crossterm::event::KeyModifiers::NONE
        )),
        Some(crate::app::AppCommand::Issues(_))
    ));
    for (width, height) in [(100, 32), (60, 16)] {
        let screen = ratatui::layout::Rect::new(0, 0, width, height);
        assert_eq!(
            layout(&app, screen).session.footer.hintline.bottom(),
            height
        );
        assert!(layout(&app, screen).session.transcript.height >= 7);
    }
}

fn custom_model_choices(
    pins: Vec<ash_app_server_protocol::protocol::config::ModelRefDto>,
) -> crate::models::ModelChoices {
    use ash_app_server_protocol::protocol::config::CustomProviderConfigDto;
    use ash_app_server_protocol::protocol::config::CustomProviderProtocolDto;
    use ash_app_server_protocol::protocol::config::ProviderConfigDto;
    let mut config = crate::test_support::empty_config_snapshot();
    config
        .tui
        .0
        .insert("pinnedModels".into(), serde_json::to_value(pins).unwrap());
    config.providers.insert(
        "custom-gateway".into(),
        ProviderConfigDto {
            fast_models: Default::default(),
            connection: "custom-gateway".into(),
            provider: "custom-gateway".into(),
            base_url: Some("https://example.test/v1".into()),
            max_output_tokens: None,
            model_context: Default::default(),
            custom: Some(CustomProviderConfigDto {
                model_aliases: None,
                context_window: 272_000,
                order: 1,
                name: "My gateway".into(),
                model: Some("gateway-model".into()),
                protocol: CustomProviderProtocolDto::Responses,
            }),
        },
    );
    config.connections = config
        .providers
        .values()
        .map(|config| (config.connection.clone(), config.clone()))
        .collect();
    config.active_connections = config
        .providers
        .values()
        .map(|config| (config.provider.clone(), config.connection.clone()))
        .collect();
    let catalog = ash_app_server_protocol::protocol::model::ModelListResult {
        models: vec![
            ash_app_server_protocol::protocol::model::ModelCatalogEntry {
                discovered: None,
                model: ash_protocol::ModelRef::new(
                    ash_protocol::ProviderId::new("custom-gateway").unwrap(),
                    ash_protocol::ModelId::new("gateway-model").unwrap(),
                ),
                display_name: "gateway-model".into(),

                context_window: Some(272_000),

                maximum_context_window: Some(272_000),
                default_context_window: Some(272_000),
                context_window_options: vec![272_000],
                fast_enabled: false,
                auto_compact_token_limit: None,
                available_context_window: Some(240_000),
                capabilities: ash_protocol::ModelCapabilities::UNKNOWN,
                supported_reasoning_efforts: vec![],
                model_reasoning_effort: None,
                default_personality: None,
            },
            ash_app_server_protocol::protocol::model::ModelCatalogEntry::from_info(
                ash_protocol::ModelRef::new(
                    ash_protocol::ProviderId::new("openai").unwrap(),
                    ash_protocol::ModelId::new("gpt-unconfigured").unwrap(),
                ),
                &ash_protocol::ModelInfo::new(
                    ash_protocol::ModelId::new("gpt-unconfigured").unwrap(),
                    "Unconfigured model",
                ),
            ),
        ],
    };
    crate::models::model_choices(&catalog, &config).unwrap()
}

#[test]
fn model_list_shows_configured_models_without_pins() {
    let mut app = App::new();
    app.update(ModelEvent::PickerOpened(custom_model_choices(vec![])));
    let selection = app.list_selection().unwrap();
    assert!(!selection.show_tabs());
    assert_eq!(selection.tabs().len(), 1);
    assert_eq!(selection.visible_items()[0].label(), "gateway-model");
    assert_eq!(selection.visible_items()[0].description(), None);
    crate::tui_assert_snapshot!(app = &app; "model_list_unpinned", render(&app, 100, 18));
}

#[test]
fn model_picker_shows_signed_in_chatgpt_and_xai_in_one_chinese_list() {
    use ash_app_server_protocol::protocol::config::ProviderConfigDto;
    use ash_app_server_protocol::protocol::model::ModelCatalogEntry;
    use ash_app_server_protocol::protocol::model::ModelListResult;

    let mut app = App::new();
    let mut settings = crate::config::TerminalSettings::default();
    settings.set_language(crate::nls::Language::Chinese);
    app.update(crate::config::Event::SettingsReceived(settings));
    let mut config = crate::test_support::empty_config_snapshot();
    let mut models = Vec::new();
    for (provider, id, name) in [
        ("openai", "gpt-5.6-sol", "GPT-5.6-Sol"),
        ("xai", "grok-ash", "Grok Ash"),
    ] {
        config.providers.insert(
            provider.into(),
            ProviderConfigDto {
                fast_models: Default::default(),
                connection: provider.into(),
                provider: provider.into(),
                custom: None,
                base_url: None,
                max_output_tokens: None,
                model_context: Default::default(),
            },
        );
        config.connections = config
            .providers
            .values()
            .map(|config| (config.connection.clone(), config.clone()))
            .collect();
        config.active_connections = config
            .providers
            .values()
            .map(|config| (config.provider.clone(), config.connection.clone()))
            .collect();
        let model = ash_protocol::ModelRef::new(
            ash_protocol::ProviderId::new(provider).unwrap(),
            ash_protocol::ModelId::new(id).unwrap(),
        );
        let mut info = ash_protocol::ModelInfo::new(model.model.clone(), name);
        info.access = ash_protocol::ModelAccess::Subscription;
        models.push(ModelCatalogEntry::from_info(model, &info));
    }
    config.tui.0.insert(
        "pinnedModels".into(),
        serde_json::json!([{"provider":"xai","model":"grok-ash"}]),
    );
    let newest = ash_protocol::ModelRef::new(
        ash_protocol::ProviderId::new("openai").unwrap(),
        ash_protocol::ModelId::new("gpt-6-astra").unwrap(),
    );
    let mut info = ash_protocol::ModelInfo::new(newest.model.clone(), "GPT-6-Astra");
    info.access = ash_protocol::ModelAccess::Subscription;
    models.insert(0, ModelCatalogEntry::from_info(newest, &info));
    app.update(ModelEvent::PickerOpened(
        crate::models::model_choices(&ModelListResult { models }, &config).unwrap(),
    ));
    assert_eq!(
        app.list_selection().unwrap().visible_items()[0].label(),
        "已固定"
    );
    assert_eq!(
        app.list_selection().unwrap().visible_items()[1].label(),
        "Grok Ash"
    );
    assert_eq!(
        app.list_selection().unwrap().visible_items()[2].label(),
        "其他模型"
    );
    assert!(
        app.list_selection()
            .unwrap()
            .visible_items()
            .iter()
            .all(|item| item.description().is_none())
    );
    crate::tui_assert_snapshot!(app = &app; "model_subscription_list", render(&app, 100, 18));
}

#[test]
fn model_picker_without_configured_connections_shows_builtin_models() {
    let mut app = App::new();
    let model = ash_protocol::ModelRef::new(
        ash_protocol::ProviderId::new("openai").unwrap(),
        ash_protocol::ModelId::new("gpt-unconfigured").unwrap(),
    );
    let catalog = ash_app_server_protocol::protocol::model::ModelListResult {
        models: vec![
            ash_app_server_protocol::protocol::model::ModelCatalogEntry::from_info(
                model.clone(),
                &ash_protocol::ModelInfo::new(model.model, "Unconfigured model"),
            ),
        ],
    };
    app.update(ModelEvent::PickerOpened(
        crate::models::model_choices(&catalog, &crate::test_support::empty_config_snapshot())
            .unwrap(),
    ));

    assert_eq!(app.list_selection().unwrap().tabs().len(), 1);
    assert_eq!(
        app.list_selection().unwrap().visible_items()[0].label(),
        "Unconfigured model"
    );
    crate::tui_assert_snapshot!(app = &app; "model_no_configured_models", render(&app, 100, 18));
}

#[test]
fn model_list_pins_without_changing_the_selected_model() {
    let mut app = App::new();
    app.update(ModelEvent::PickerOpened(custom_model_choices(vec![])));
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Char('p'), KeyModifiers::NONE)),
        Some(AppCommand::Models(crate::models::Command::Pin {
            preference: "custom-gateway/gateway-model".into(),
            pinned: true
        }))
    );
    app.update(ModelEvent::PickerUpdated(custom_model_choices(vec![
        ModelRefDto {
            provider: "custom-gateway".into(),
            model: "gateway-model".into(),
        },
    ])));
    assert_eq!(
        app.list_selection().unwrap().visible_items()[0].label(),
        "Pinned"
    );
    assert_eq!(
        app.list_selection().unwrap().selected_visible_index(),
        Some(1)
    );
    assert_eq!(
        app.list_selection()
            .unwrap()
            .selected_item()
            .unwrap()
            .label(),
        "gateway-model"
    );
    let rendered = render(&app, 100, 18);
    let row = rendered
        .lines()
        .position(|line| line.contains("> gateway-model"))
        .unwrap() as u16;
    let buffer = render_buffer(&app, 100, 18);
    assert_eq!(buffer[(30, row)].bg, buffer[(30, row + 1)].bg);
    crate::tui_assert_snapshot!(app = &app; "model_list_pinned", rendered);
}

#[test]
fn model_pins_preserve_catalog_order_and_focus_in_both_screen_modes() {
    use crate::terminal::ScreenMode;
    use ash_app_server_protocol::protocol::model::ModelCatalogEntry;
    use ash_app_server_protocol::protocol::model::ModelListResult;

    let catalog = ModelListResult {
        models: ["first", "second", "third", "fourth"]
            .into_iter()
            .map(|id| {
                let model = ash_protocol::ModelRef::new(
                    ash_protocol::ProviderId::new("openai").unwrap(),
                    ash_protocol::ModelId::new(id).unwrap(),
                );
                ModelCatalogEntry::from_info(
                    model.clone(),
                    &ash_protocol::ModelInfo::new(model.model, format!("{id} model")),
                )
            })
            .collect(),
    };
    for mode in [ScreenMode::Fullscreen, ScreenMode::Inline] {
        let mut app = App::new();
        let mut settings = crate::config::TerminalSettings::default();
        settings.set_screen_mode(mode);
        app.update(crate::config::Event::SettingsReceived(settings));
        let mut config = crate::test_support::empty_config_snapshot();
        config.model = Some(ModelRefDto {
            provider: "openai".into(),
            model: "first".into(),
        });
        app.update(ModelEvent::PickerOpened(
            crate::models::model_choices(&catalog, &config).unwrap(),
        ));
        let mut pins: Vec<ModelRefDto> = Vec::new();
        let mut snapshots = Vec::new();
        // Pin in reverse catalog order, then remove pins in catalog order.
        for (id, pinned, key, steps, expected) in [
            (
                "fourth",
                true,
                KeyCode::Down,
                3,
                vec![
                    "Pinned",
                    "fourth model",
                    "Other models",
                    "first model",
                    "second model",
                    "third model",
                ],
            ),
            (
                "third",
                true,
                KeyCode::Down,
                3,
                vec![
                    "Pinned",
                    "third model",
                    "fourth model",
                    "Other models",
                    "first model",
                    "second model",
                ],
            ),
            (
                "third",
                false,
                KeyCode::Down,
                0,
                vec![
                    "Pinned",
                    "fourth model",
                    "Other models",
                    "first model",
                    "second model",
                    "third model",
                ],
            ),
            (
                "fourth",
                false,
                KeyCode::Up,
                3,
                vec!["first model", "second model", "third model", "fourth model"],
            ),
        ] {
            for _ in 0..steps {
                app.handle_key(KeyEvent::new(key, KeyModifiers::NONE));
            }
            assert_eq!(
                app.handle_key(KeyEvent::new(KeyCode::Char('p'), KeyModifiers::NONE)),
                Some(AppCommand::Models(crate::models::Command::Pin {
                    preference: format!("openai/{id}"),
                    pinned,
                }))
            );
            if pinned {
                pins.push(ModelRefDto {
                    provider: "openai".into(),
                    model: id.into(),
                });
            } else {
                pins.retain(|model| model.model != id);
            }
            config
                .tui
                .0
                .insert("pinnedModels".into(), serde_json::to_value(&pins).unwrap());
            app.update(ModelEvent::PickerUpdated(
                crate::models::model_choices(&catalog, &config).unwrap(),
            ));
            let selection = app.list_selection().unwrap();
            assert_eq!(
                selection
                    .visible_items()
                    .iter()
                    .map(|item| item.label())
                    .collect::<Vec<_>>(),
                expected
            );
            assert!(selection.items_focused());
            assert_eq!(
                selection.selected_item().unwrap().label(),
                format!("{id} model")
            );
            snapshots.push(format!("{id} pinned={pinned}\n{}", render(&app, 100, 18)));
        }
        app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert!(app.command_panel().is_none());
        assert!(app.chat_input_focused());
        crate::tui_assert_snapshot!(
            app = &app;
            match mode {
                ScreenMode::Fullscreen => "model_pin_catalog_order_fullscreen",
                ScreenMode::Inline => "model_pin_catalog_order_inline",
            },
            snapshots.join("\n\n")
        );
    }
}

#[test]
fn model_list_reopens_with_saved_pins_and_unpin_action() {
    let mut app = App::new();
    app.update(ModelEvent::PickerOpened(custom_model_choices(vec![
        ModelRefDto {
            provider: "custom-gateway".into(),
            model: "gateway-model".into(),
        },
    ])));
    assert_eq!(
        app.list_selection().unwrap().visible_items()[0].label(),
        "Pinned"
    );
    assert_eq!(
        app.list_selection().unwrap().selected_visible_index(),
        Some(1)
    );
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Char('p'), KeyModifiers::NONE)),
        Some(AppCommand::Models(crate::models::Command::Pin {
            preference: "custom-gateway/gateway-model".into(),
            pinned: false
        }))
    );
    app.update(ModelEvent::PickerUpdated(custom_model_choices(vec![])));
    assert_eq!(app.list_selection().unwrap().visible_items().len(), 2);
    assert_eq!(
        app.list_selection().unwrap().selected_visible_index(),
        Some(0)
    );
    assert_eq!(
        app.list_selection()
            .unwrap()
            .selected_item()
            .unwrap()
            .label(),
        "gateway-model"
    );
}

#[test]
fn model_list_search_filters_models_and_escape_returns_to_list() {
    let mut app = App::new();
    app.update(ModelEvent::PickerOpened(custom_model_choices(vec![])));
    assert!(app.list_selection().unwrap().items_focused());
    app.handle_key(KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE));
    for code in [KeyCode::Char('g'), KeyCode::Char('a'), KeyCode::Char('t')] {
        app.handle_key(KeyEvent::new(code, KeyModifiers::NONE));
    }
    assert_eq!(app.list_selection().unwrap().query(), "gat");
    assert_eq!(app.list_selection().unwrap().visible_items().len(), 1);
    crate::tui_assert_snapshot!(app = &app; "model_list_search", render(&app, 100, 18));
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(app.list_selection().unwrap().items_focused());
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        Some(AppCommand::Models(crate::models::Command::SetModel {
            preference: "custom-gateway/gateway-model".into(),
        }))
    );
}

#[test]
fn model_picker_cycles_supported_effort_in_place_and_commits_on_enter() {
    let model = ash_protocol::ModelRef::new(
        ash_protocol::ProviderId::new("openai").unwrap(),
        ash_protocol::ModelId::new("gpt-effort").unwrap(),
    );
    let mut info = ash_protocol::ModelInfo::new(model.model.clone(), "GPT Effort");
    info.supported_reasoning_efforts = vec![
        ReasoningEffort::None,
        ReasoningEffort::Low,
        ReasoningEffort::Medium,
        ReasoningEffort::High,
    ];
    info.model_reasoning_effort = Some(ReasoningEffort::Medium);
    let catalog = ash_app_server_protocol::protocol::model::ModelListResult {
        models: vec![
            ash_app_server_protocol::protocol::model::ModelCatalogEntry::from_info(model, &info),
            ash_app_server_protocol::protocol::model::ModelCatalogEntry::from_info(
                ash_protocol::ModelRef::new(
                    ash_protocol::ProviderId::new("openai").unwrap(),
                    ash_protocol::ModelId::new("gpt-other").unwrap(),
                ),
                &{
                    let mut other = ash_protocol::ModelInfo::new(
                        ash_protocol::ModelId::new("gpt-other").unwrap(),
                        "GPT Other",
                    );
                    other.supported_reasoning_efforts = vec![
                        ReasoningEffort::Low,
                        ReasoningEffort::Medium,
                        ReasoningEffort::High,
                    ];
                    other.model_reasoning_effort = Some(ReasoningEffort::Low);
                    other
                },
            ),
        ],
    };
    let choices = || {
        crate::models::model_choices(&catalog, &crate::test_support::empty_config_snapshot())
            .unwrap()
    };
    let mut app = App::new();
    app.update(ModelEvent::PickerOpened(choices()));
    let buffer = render_buffer(&app, 100, 18);
    let blocks = buffer
        .content
        .iter()
        .filter(|cell| cell.symbol() == "█")
        .collect::<Vec<_>>();
    let context = app.render_context();
    assert_eq!(
        blocks.iter().map(|cell| cell.fg).collect::<Vec<_>>(),
        [
            context.focus(),
            context.focus(),
            context.focus(),
            context.focus(),
            context.segmented_inactive(),
            context.segmented_inactive(),
            context.segmented_active(),
            context.segmented_active(),
            context.segmented_inactive(),
            context.segmented_inactive(),
            context.segmented_inactive(),
            context.segmented_inactive(),
        ]
    );
    let selected_row = (0..buffer.area.height)
        .find(|&y| (0..buffer.area.width).any(|x| buffer[(x, y)].symbol() == "G"))
        .unwrap();
    for symbol in [">", "G", "M", "←", "→"] {
        let cell = (0..buffer.area.width)
            .map(|x| &buffer[(x, selected_row)])
            .find(|cell| cell.symbol() == symbol)
            .unwrap();
        assert_eq!(cell.fg, context.focus(), "{symbol}");
    }
    assert!(render(&app, 100, 18).contains("██ ██ ██"));
    let narrow = render(&app, 60, 18);
    assert!(narrow.contains("██ ██ ██ → Medium"), "{narrow}");

    let mut light = App::new();
    light.update(crate::theme::Event::RenderChanged(
        crate::render::RenderTheme::from_palette(
            crate::render::ThemePalette::light(),
            ash_terminal_detection::ColorLevel::TrueColor,
        ),
    ));
    light.update(ModelEvent::PickerOpened(choices()));
    let light_buffer = render_buffer(&light, 100, 18);
    let light_context = light.render_context();
    assert_eq!(
        light_buffer
            .content
            .iter()
            .filter(|cell| cell.symbol() == "█")
            .map(|cell| cell.fg)
            .collect::<Vec<_>>(),
        [
            light_context.focus(),
            light_context.focus(),
            light_context.focus(),
            light_context.focus(),
            light_context.segmented_inactive(),
            light_context.segmented_inactive(),
            light_context.segmented_active(),
            light_context.segmented_active(),
            light_context.segmented_inactive(),
            light_context.segmented_inactive(),
            light_context.segmented_inactive(),
            light_context.segmented_inactive(),
        ]
    );
    let selected_row = (0..light_buffer.area.height)
        .find(|&y| (0..light_buffer.area.width).any(|x| light_buffer[(x, y)].symbol() == "G"))
        .unwrap();
    for symbol in [">", "G", "M", "←", "→"] {
        let cell = (0..light_buffer.area.width)
            .map(|x| &light_buffer[(x, selected_row)])
            .find(|cell| cell.symbol() == symbol)
            .unwrap();
        assert_eq!(cell.fg, light_context.focus(), "{symbol}");
    }

    let mut chinese = App::new();
    let mut settings = crate::config::TerminalSettings::default();
    settings.set_language(crate::nls::Language::Chinese);
    chinese.update(crate::config::Event::SettingsReceived(settings));
    chinese.update(ModelEvent::PickerOpened(choices()));
    assert!(render(&chinese, 100, 18).contains("←→ 调 整"));

    app.handle_key(KeyEvent::new(KeyCode::Right, KeyModifiers::NONE));
    assert!(render(&app, 100, 18).contains("██ ██ ██"));
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    let selected_other = render(&app, 100, 18);
    assert!(
        selected_other
            .lines()
            .any(|line| line.contains("GPT Other") && line.contains("←") && line.contains("→"))
    );
    assert!(
        selected_other
            .lines()
            .any(|line| line.contains("GPT Effort") && !line.contains("←"))
    );
    app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE));
    assert!(
        render(&app, 100, 18)
            .lines()
            .any(|line| line.contains("GPT Effort") && line.contains("Medium")),
        "{}",
        render(&app, 100, 18)
    );
    app.handle_key(KeyEvent::new(KeyCode::Right, KeyModifiers::NONE));
    crate::tui_assert_snapshot!(app = &app; "model_effort_selected", render(&app, 100, 18));

    app.update(ModelEvent::PickerUpdated(choices()));
    assert!(render(&app, 100, 18).contains("██ ██ ██"));
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        Some(AppCommand::Models(crate::models::Command::SetModel {
            preference: "openai/gpt-effort high".into(),
        }))
    );

    app.update(ModelEvent::PickerOpened(choices()));
    assert!(
        render(&app, 100, 18)
            .lines()
            .any(|line| line.contains("GPT Effort") && line.contains("Medium"))
    );
    app.handle_key(KeyEvent::new(KeyCode::Right, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    app.update(ModelEvent::PickerOpened(choices()));
    assert!(
        render(&app, 100, 18)
            .lines()
            .any(|line| line.contains("GPT Effort") && line.contains("Medium"))
    );
}

#[test]
fn model_pointer_single_click_previews_and_double_click_confirms() {
    let mut app = App::new();
    app.update(ModelEvent::PickerOpened(custom_model_choices(vec![])));
    let target =
        super::modal::Target::Panel(crate::app::command_panel::CommandPanelPointerTarget::List(
            crate::widgets::list_selection::ListSelectionPointerTarget::Item(
                crate::widgets::list_selection::ListSelectionItemId::new("openai/gpt-unconfigured"),
            ),
        ));
    let area = Rect::new(0, 0, 100, 18);
    assert_eq!(
        super::modal::activate(
            &mut app,
            area,
            target.clone(),
            crate::widgets::list_selection::ListSelectionClick::Single,
        ),
        None
    );
    assert_eq!(
        app.list_selection()
            .unwrap()
            .selected_item()
            .unwrap()
            .label(),
        "Unconfigured model"
    );
    crate::tui_assert_snapshot!(app = &app; "model_pointer_preview", render(&app, 100, 18));
    assert_eq!(
        super::modal::activate(
            &mut app,
            area,
            target,
            crate::widgets::list_selection::ListSelectionClick::Double,
        ),
        Some(AppCommand::Models(crate::models::Command::SetModel {
            preference: "openai/gpt-unconfigured".into(),
        }))
    );
}

#[test]
fn chat_progress_stays_above_input_without_hiding_top_tip() {
    let mut app = App::new();
    app.set_active_turn(ash_protocol::TurnId::new("status-test").unwrap());
    app.update(ThreadEvent::TurnActivityChanged(TurnActivity::Working));
    app.update(HostEvent::TopTipNoticeShown("Copied 42 chars".into()));
    let areas = layout(&app, Rect::new(0, 0, 80, 20)).session;
    assert_eq!(areas.footer.hintline.height, 1);
    assert_eq!(areas.footer.statusline.y, areas.composer.bottom());
    assert_eq!(areas.footer.statusline.bottom(), areas.footer.hintline.y);
    assert_eq!(areas.footer.hintline.height, 1);
    let working = render(&app, 80, 20);
    let rows = working.lines().collect::<Vec<_>>();
    let progress_row = rows.iter().position(|row| row.contains("Working")).unwrap() as u16;
    assert!(
        areas
            .progress
            .contains(ratatui::layout::Position::new(0, progress_row))
    );
    assert!(rows[usize::from(areas.footer.hintline.y)].contains("Manual"));
    assert!(working.contains("Working..."));
    assert!(working.contains("esc to interrupt"));
    assert!(working.contains("Copied 42 chars"));
    crate::tui_assert_snapshot!(app = &app; "chat_progress_with_notice", working);
    app.update(ThreadEvent::TurnActivityChanged(
        TurnActivity::WaitingForUserInput,
    ));
    assert!(render(&app, 80, 20).contains("Waiting for input"));
    let command = app.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));
    assert!(matches!(
        command,
        Some(AppCommand::Thread(ThreadCommand::Interrupt))
    ));
    let cancelling = render(&app, 80, 20);
    assert!(cancelling.contains("Cancelling"));
    assert!(!cancelling.contains("to interrupt"));
    app.update(ThreadEvent::TurnCompleted);
    assert!(app.turn_progress().is_none());
    assert_eq!(
        layout(&app, Rect::new(0, 0, 80, 20))
            .session
            .footer
            .hintline
            .height,
        1
    );
}

#[test]
fn running_tip_follows_chat_progress() {
    let mut app = App::new();
    app.set_active_turn(ash_protocol::TurnId::new("tip-test").unwrap());
    app.update(ThreadEvent::TurnActivityChanged(TurnActivity::Working));
    app.handle_tick(Instant::now() + Duration::from_secs(9));

    let areas = layout(&app, Rect::new(0, 0, 80, 20)).session;
    assert_eq!(areas.footer.hintline.height, 1);
    let rendered = render(&app, 80, 20);
    assert!(rendered.contains("Working"));
    assert!(rendered.contains("Tip: Ask Ash to list steps for complex tasks"));
    let buffer = render_buffer(&app, 80, 20);
    for (column, symbol) in [(0, " "), (1, "└"), (2, "─"), (3, " "), (4, "T")] {
        let position = (areas.progress.x + column, areas.progress.y + 1);
        assert_eq!(buffer[position].symbol(), symbol);
        assert_eq!(buffer[position].fg, app.render_context().muted());
    }
    assert_eq!(areas.footer.statusline.y, areas.composer.bottom());
    assert_eq!(areas.footer.statusline.bottom(), areas.footer.hintline.y);
    assert_eq!(areas.footer.hintline.height, 1);

    let mut settings = crate::config::TerminalSettings::default();
    settings.set_language(crate::nls::Language::Chinese);
    app.update(crate::config::Event::SettingsReceived(settings));
    let localized = render_visible_text(&app, 80, 20);
    assert!(localized.contains("正在处理"));
    assert!(localized.contains("技巧：复杂任务可以请 Ash 先列出步骤"));
    assert!(!localized.contains("Working"));
    crate::tui_assert_snapshot!(app = &app; "running_tip_after_language_change", localized);

    app.update(ThreadEvent::TurnActivityChanged(
        TurnActivity::WaitingForApproval,
    ));
    assert_eq!(
        layout(&app, Rect::new(0, 0, 80, 20))
            .session
            .footer
            .hintline
            .height,
        1
    );
    assert!(!render(&app, 80, 20).contains("Tip: Ask Ash"));
}

fn input_overlay_index_at(app: &App, area: Rect, column: u16, row: u16) -> Option<usize> {
    match target_at(app, area, column, row) {
        Some(PointerTarget::Composer(ChatComposerPointerTarget::CompletionItem(index))) => {
            Some(index)
        }
        _ => None,
    }
}

#[test]
fn persistent_queue_snapshot_distinguishes_pending_and_paused_messages() {
    let mut app = App::new();
    app.update(ThreadEvent::TurnActivityChanged(TurnActivity::Working));
    let mut messages = Vec::new();
    for text in ["Run the focused tests", "Review the result"] {
        app.insert_text(text);
        let command = app
            .handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
            .unwrap();
        messages.push(crate::test_support::queued_message(command));
    }
    messages[1].status = ::queue::QueueStatus::Paused;
    app.update(ThreadEvent::QueueReceived {
        messages,
        restore: None,
    });
    crate::tui_assert_snapshot!(app = &app; "persistent_queue", render(&app, 80, 20));
}

#[test]
fn dictation_model_preparation_shows_real_download_bytes_in_chinese() {
    let mut app = App::new();
    let mut settings = crate::config::TerminalSettings::default();
    settings.set_language(crate::nls::Language::Chinese);
    app.update(crate::config::Event::SettingsReceived(settings));
    app.insert_text("/voice");
    let Some(AppCommand::DictationStart { resource_id }) =
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
    else {
        panic!("expected dictation start");
    };
    app.dictation_model_progress(
        &resource_id,
        ash_app_server_protocol::protocol::dictation::DictationModelStage::Downloading {
            file: "encoder.onnx".into(),
            downloaded_bytes: 2 * 1024 * 1024,
        },
    );
    assert_eq!(
        app.dictation_status().unwrap(),
        "听写 · 正在下载 encoder.onnx：2.0 MiB"
    );
    let rendered = render_visible_text(&app, 80, 20);
    let areas = layout(&app, Rect::new(0, 0, 80, 20));
    let status_row = rendered
        .lines()
        .position(|line| line.contains("听写 · 正在下载"))
        .expect("download status is visible");
    assert_eq!(status_row as u16, areas.session.tipline.y);
    assert_eq!(status_row as u16 + 1, areas.input.y);
    assert!(
        rendered
            .lines()
            .nth(usize::from(areas.session.tipline.y))
            .unwrap()
            .contains("ctrl+c 停止听写")
    );
    assert_eq!(
        render_buffer(&app, 80, 20)[(2, status_row as u16)].fg,
        app.render_context().muted()
    );
    crate::tui_assert_snapshot!(app = &app; "dictation_model_downloading_zh", render(&app, 80, 20));
}
