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
use crate::models::Event as ModelEvent;
use crate::models::ModelSummary;
use crate::render::test_context;
use crate::sessions::Event as SessionEvent;
use crate::status::Event as StatusEvent;
use crate::status::RemainingContextWindow;
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
use crossterm::event::KeyEvent;
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
    assert_eq!(buffer[(area.x + 4, area.y + 1)].symbol(), ">");
    crate::tui_assert_snapshot!("input_history_search", render(&app, 100, 20));
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
        None
    );
    assert_eq!(app.input(), "");
    crate::tui_assert_snapshot!("input_history_search_cancelled", render(&app, 100, 20));
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
    crate::tui_assert_snapshot!("pull_request_agent_task", render(&app, 100, 20));
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
                    .top_tip
                    .y
            ))
            .unwrap()
            .contains("ask permissions on")
    );
    assert!(rendered.lines().last().unwrap().contains("/home"));
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
    let notice_row = usize::from(areas_after.top_tip.y);

    assert_eq!(areas_after, areas_before);
    assert_eq!(areas_after.top_tip.height, 1);
    assert_eq!(areas_after.top_tip.bottom(), areas_after.composer.y);
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

    crate::tui_assert_snapshot!("completed_update_notice", render(&app, 80, 20));
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
    let tip_row = usize::from(areas_after.top_tip.y);

    assert_eq!(areas_after, areas_before);
    assert_eq!(areas_after.top_tip.height, 1);
    assert!(
        rows[tip_row]
            .trim_end()
            .ends_with("image in clipboard · ctrl+v to paste")
    );
    crate::tui_assert_snapshot!("clipboard_image_top_tip", rendered);

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
        full_context_window: None,
        available_context_window: None,
        remaining_context_window: RemainingContextWindow::Unknown,
        usage: &usage,
        reference_cost: &reference_cost,
        session_id: "session-1",
        thread_id: "thread-1",
    }));
    let mut app = App::new();
    app.open_command_panel(panel);
    let area = Rect::new(0, 0, 80, 20);
    let modal = super::modal::layout(area);
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
    assert!(text.contains("Thread"));
    assert!(text.contains("Processes"));
    assert!(text.contains("Esc to close"));
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
                crate::config::KeyHintStyle::Contrast,
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
    crate::tui_assert_snapshot!("modal_wrapped_tabs", text);
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

    let usage = ash_protocol::ModelUsageSummary::default();
    let reference_cost = ash_protocol::ModelReferenceCostSummary::default();
    app.update(StatusEvent::PanelOpened(status_panel(StatusViewData {
        model: "openai/gpt",
        full_context_window: None,
        available_context_window: None,
        remaining_context_window: RemainingContextWindow::Unknown,
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
        full_context_window: Some(100_000),
        available_context_window: Some(90_000),
        remaining_context_window: RemainingContextWindow::Exact {
            remaining_tokens: 80_000,
            available_tokens: 90_000,
        },
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
    assert!(rendered.contains("Status"));
    assert!(rendered.contains("Thread"));
    assert!(rendered.contains("Processes"));
    assert!(rendered.contains("Tab to switch · Esc to close"));
    crate::tui_assert_snapshot!("status_panel_adaptive_height", rendered);

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
    let notice_row = rows[usize::from(areas.top_tip.y)];
    let manager_last_row = rows[usize::from(areas.top_tip.y.saturating_sub(1))];

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
    let top_tip_row = usize::from(layout(&app, terminal_area).session.top_tip.y);
    let rendered = render(&app, terminal_area.width, terminal_area.height);
    let rows = rendered.lines().collect::<Vec<_>>();

    assert!(rows[top_tip_row].contains("← Dashboard"));
    assert!(!rows[top_tip_row].contains("shift+tab"));
    assert!(!rows[19].contains("permissions on"));
    assert!(
        rows[usize::from(layout(&app, Rect::new(0, 0, 80, 20)).session.top_tip.y)]
            .contains("⏸ ask permissions on")
    );

    assert!(app.handle_tick(Instant::now() + Duration::from_secs(10)));
    let rendered = render(&app, terminal_area.width, terminal_area.height);
    let rows = rendered.lines().collect::<Vec<_>>();
    assert!(rows[top_tip_row].trim().is_empty());
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
fn narrow_session_prioritizes_policy_above_input_and_keeps_shortcuts_below() {
    let mut app = App::new();
    enter_session(
        &mut app,
        "current",
        vec![manager_session("current", SessionManagerStatus::Idle, None)],
    );

    let terminal_area = Rect::new(0, 0, 24, 20);
    let top_tip_row = usize::from(layout(&app, terminal_area).session.top_tip.y);
    let rendered = render(&app, terminal_area.width, terminal_area.height);
    let rows = rendered.lines().collect::<Vec<_>>();

    assert_eq!(rows[top_tip_row].trim(), "⏸ ask permissions on");
    assert!(!rows[top_tip_row].contains("shift+tab"));
    assert_eq!(rows[19].trim_end(), "  Enter send");
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
    app.insert_text("/dashboard");
    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
            .is_none()
    );

    let rendered = render(&app, 100, 28);
    let needs_input = rendered
        .lines()
        .find(|line| line.contains("needs-input"))
        .unwrap();
    let working = rendered
        .lines()
        .find(|line| line.contains("Running targeted tests"))
        .unwrap();
    assert!(!rendered.lines().any(|line| line.contains("done")));

    assert!(rendered.lines().next().unwrap().contains("."));
    assert!(rendered.contains("Needs input"));
    assert!(rendered.contains("Working"));
    assert!(
        rendered
            .lines()
            .any(|line| line.trim_end() == "  Archived (1)")
    );
    assert!(needs_input.starts_with("  ? needs-input"));
    assert!(needs_input.contains("Which API should I use?"));
    assert!(working.starts_with("  ⠋ working"));
    assert_eq!(
        rendered.lines().last().unwrap().trim_end(),
        "  Esc to return"
    );
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
fn top_tip_shows_permission_modes_above_input_shortcuts() {
    let mut app = App::new();
    for (mode, label) in [
        (
            ash_protocol::ApprovalMode::AskPermissions,
            "⏸ ask permissions on",
        ),
        (ash_protocol::ApprovalMode::AutoReview, "⏩  auto review on"),
        (
            ash_protocol::ApprovalMode::BypassPermissions,
            "▶ bypass permissions on",
        ),
    ] {
        app.set_next_approval_mode(mode);
        let screen = render(&app, 100, 20);
        let hints = screen.lines().last().unwrap().trim_end();
        assert!(hints.starts_with("  Enter send"));
        assert!(!hints.contains("permissions on") && !hints.contains("auto review on"));
        let top_tip = layout(&app, Rect::new(0, 0, 100, 20)).session.top_tip;
        assert!(
            screen
                .lines()
                .nth(usize::from(top_tip.y))
                .unwrap()
                .contains(label)
        );
        assert!(screen.lines().nth(18).unwrap().trim().is_empty());
    }
}

#[test]
fn key_hint_style_applies_to_fullscreen_without_changing_hint_text() {
    let mut app = App::new();
    let contrast = render_buffer(&app, 100, 20);
    let row = 19;
    assert_eq!(contrast[(2, row)].symbol(), "E");
    assert_eq!(contrast[(2, row)].fg, test_context().foreground());
    assert!(contrast[(2, row)].modifier.contains(Modifier::BOLD));
    assert_eq!(contrast[(7, row)].fg, test_context().muted());
    assert!(!contrast[(7, row)].modifier.contains(Modifier::BOLD));

    let mut settings = crate::config::TerminalSettings::default();
    settings.set_key_hint_style(crate::config::KeyHintStyle::Muted);
    app.update(crate::config::Event::SettingsReceived(settings));
    let muted = render_buffer(&app, 100, 20);
    assert_eq!(muted[(2, row)].symbol(), "E");
    assert_eq!(muted[(2, row)].fg, test_context().muted());
    assert!(muted[(2, row)].modifier.contains(Modifier::ITALIC));
    assert_eq!(muted[(7, row)].fg, test_context().muted());
    assert!(muted[(7, row)].modifier.contains(Modifier::ITALIC));
}

#[test]
fn turn_activity_does_not_enter_status_line() {
    let mut app = App::new();
    app.insert_text("start");
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    app.update(ThreadEvent::TurnActivityChanged(TurnActivity::Working));
    app.insert_text("change direction");

    let rendered = render(&app, 80, 20);

    assert!(!rendered.contains("working"));
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
fn top_tip_uses_a_distinct_color_for_each_approval_mode_symbol() {
    let mut app = App::new();
    for (mode, icon, color) in [
        (
            ash_protocol::ApprovalMode::AskPermissions,
            "⏸",
            test_context().warning(),
        ),
        (
            ash_protocol::ApprovalMode::AutoReview,
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
        let row = layout(&app, buffer.area).session.top_tip.y;
        let column = (0..100)
            .find(|x| buffer[(*x, row)].symbol() == icon)
            .unwrap();
        assert_eq!(buffer[(column, row)].fg, color);
        assert_eq!(
            buffer[(column + icon.width() as u16, row)].fg,
            test_context().chat_input_chrome()
        );
    }
}

#[test]
fn top_tip_colors_current_and_next_modes_independently() {
    let mut app = App::new();
    app.set_current_approval_mode(Some(ash_protocol::ApprovalMode::AskPermissions));
    app.set_next_approval_mode(ash_protocol::ApprovalMode::AutoReview);
    let buffer = render_buffer(&app, 120, 20);
    let row = layout(&app, buffer.area).session.top_tip.y;
    let current = (0..120)
        .find(|x| buffer[(*x, row)].symbol() == "⏸")
        .unwrap();
    let next = (0..120)
        .find(|x| buffer[(*x, row)].symbol() == "⏩")
        .unwrap();
    assert_eq!(buffer[(current, row)].fg, test_context().warning());
    assert_eq!(buffer[(next, row)].fg, test_context().accent());
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
    crate::tui_assert_snapshot!("transcript_scrolled_to_first_message", scrolled_to_start);
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
    assert!(wide.lines().nth(18).unwrap().trim().is_empty());

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
    assert!(narrow.lines().nth(18).unwrap().trim().is_empty());
}

#[test]
fn boxed_input_keeps_its_width_and_renders_the_prompt_inside() {
    let app = App::new();
    let input = layout(&app, Rect::new(0, 0, 80, 20)).input;
    let buffer = render_buffer(&app, 80, 20);
    assert_eq!(buffer[(0, input.y)].symbol(), " ");
    assert_eq!(buffer[(2, input.y)].symbol(), "╭");
    assert_eq!(buffer[(77, input.y)].symbol(), "╮");
    assert_eq!(buffer[(2, input.y)].fg, test_context().chat_input_chrome());
    assert_eq!(buffer[(0, input.y + 1)].symbol(), " ");
    assert_eq!(buffer[(2, input.y + 1)].symbol(), "│");
    assert_eq!(buffer[(4, input.y + 1)].symbol(), ">");
    assert_eq!(buffer[(4, input.y + 1)].fg, test_context().foreground());
    assert_eq!(buffer[(77, input.y + 1)].symbol(), "│");
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
    let top_tip_row = areas.top_tip.y;

    let before = render(&app, 80, 20);
    assert!(
        before
            .lines()
            .nth(usize::from(top_tip_row))
            .unwrap()
            .contains("← Dashboard")
    );

    app.insert_text("hello");
    assert!(matches!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        Some(AppCommand::Thread(ThreadCommand::SubmitTurn { .. }))
    ));

    let buffer = render_buffer(&app, 80, 20);
    let bottom_row = layout(&app, terminal_area).session.bottom.bottom() - 1;
    let hint_column = 78 - "shift+tab to cycle policy".width() as u16;
    let hint = &buffer[(hint_column, top_tip_row)];

    assert_eq!(hint.symbol(), "s");
    assert_eq!(hint.fg, test_context().muted());
    assert!(hint.modifier.contains(Modifier::ITALIC));
    assert_eq!(buffer[(2, top_tip_row)].symbol(), "⏸");
    assert_eq!(buffer[(2, top_tip_row)].fg, test_context().warning());
    assert!(
        !(0..80)
            .map(|x| buffer[(x, bottom_row)].symbol())
            .collect::<String>()
            .contains("permissions on")
    );
    assert_eq!(buffer[(2, composer.y)].symbol(), "╭");
    assert_eq!(buffer[(77, composer.y)].symbol(), "╮");

    let first_tip_expired = Instant::now() + Duration::from_secs(6);
    assert!(app.handle_tick(first_tip_expired));
    let after = render(&app, 80, 20);
    let after_tip = after.lines().nth(usize::from(top_tip_row)).unwrap();
    assert!(!after_tip.contains("← Dashboard"));
    assert!(!after_tip.contains("shift+tab"));

    let policy_changed = first_tip_expired + Duration::from_secs(1);
    app.cycle_next_approval_mode(policy_changed);
    assert_eq!(app.approval_mode(), ash_protocol::ApprovalMode::AutoReview);
    let after_change = render(&app, 80, 20);
    assert!(
        after_change
            .lines()
            .nth(usize::from(top_tip_row))
            .unwrap()
            .contains("shift+tab to cycle policy")
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
        assert_eq!(before[(2, areas.top_tip.y)].symbol(), "⏸");
        assert_eq!(
            before[(2, areas.top_tip.y)].fg,
            app.render_context().warning()
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
        // The mode icon, mode label and keyboard hint all lose contrast together.
        for x in [2, 4, 54] {
            let full = &before[(x, areas.top_tip.y)];
            let faded = &fading[(x, areas.top_tip.y)];
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
            if y != areas.top_tip.y {
                for x in 0..80 {
                    assert_eq!(before[(x, y)], fading[(x, y)]);
                }
            }
        }
        assert!(app.handle_tick(started + Duration::from_secs(5)));
        let hidden = render_buffer(&app, 80, 20);
        assert!(!(0..80).any(|x| hidden[(x, areas.top_tip.y)].symbol() != " "));
        assert_eq!(layout(&app, area).session, areas);
        assert!(!app.handle_tick(started + Duration::from_secs(6)));
    }
}

#[test]
fn policy_changes_restart_the_fade_and_keep_current_and_next_modes_visible() {
    let mut app = App::new();
    let started = Instant::now();
    app.set_current_approval_mode(Some(ash_protocol::ApprovalMode::AskPermissions));
    app.cycle_next_approval_mode(started);
    assert_eq!(app.approval_mode(), ash_protocol::ApprovalMode::AutoReview);
    let visible = render(&app, 120, 20);
    assert!(visible.contains("current: ask permissions on"));
    assert!(visible.contains("next: auto review on"));
    crate::tui_assert_snapshot!("policy_top_tip_current_and_next", visible);
    assert!(app.handle_tick(started + Duration::from_secs(4)));
    app.cycle_next_approval_mode(started + Duration::from_secs(4));
    assert_eq!(
        app.approval_mode(),
        ash_protocol::ApprovalMode::BypassPermissions
    );
    let restarted = render_buffer(&app, 120, 20);
    let row = layout(&app, Rect::new(0, 0, 120, 20)).session.top_tip.y;
    assert_eq!(restarted[(2, row)].fg, test_context().warning());
    assert!(render(&app, 120, 20).contains("next: bypass permissions on"));
    assert!(!app.handle_tick(started + Duration::from_secs(7)));
    assert!(app.handle_tick(started + Duration::from_secs(9)));
    crate::tui_assert_snapshot!("policy_top_tip_expired", render(&app, 120, 20));
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
        let row = layout(&app, area).session.top_tip.y;
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
    let cell = &buffer[(2, layout(&app, buffer.area).session.top_tip.y)];
    assert_eq!(cell.fg, Color::Rgb(128, 83, 44));
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
        let row = layout(&app, buffer.area).session.top_tip.y;
        let cell = &buffer[(2, row)];
        if capability == ColorLevel::Ansi256 {
            assert!(matches!(cell.fg, Color::Indexed(_)));
            assert_ne!(cell.fg, app.render_context().warning());
        } else {
            assert_eq!(cell.fg, app.render_context().warning());
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
    assert!(!rendered.contains("← Dashboard"));
    assert!(rendered.contains("auto review on"));
    assert!(rendered.contains("shift+tab to cycle policy"));
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
        rows[usize::from(layout(&app, Rect::new(0, 0, 80, 20)).session.top_tip.y)]
            .contains("⏸ ask permissions on")
    );
}

#[test]
fn turn_activity_does_not_replace_the_permission_mode_in_top_tip() {
    let mut app = App::new();
    app.update(ThreadEvent::TurnActivityChanged(TurnActivity::Working));

    let rendered = render(&app, 80, 20);
    let status_line = rendered.lines().last().unwrap();

    assert!(!status_line.contains("permissions on"));
    let top_tip = layout(&app, Rect::new(0, 0, 80, 20)).session.top_tip;
    assert!(
        rendered
            .lines()
            .nth(usize::from(top_tip.y))
            .unwrap()
            .contains("⏸ ask permissions on")
    );
    assert!(status_line.starts_with("  Enter send"));
    assert!(!status_line.contains("Working"));
}

#[test]
fn chat_input_soft_wraps_long_lines_instead_of_clipping_them() {
    let mut app = App::new();
    app.insert_text("abcdefghij");

    let terminal_area = Rect::new(0, 0, 12, 20);
    let input = layout(&app, terminal_area).input;
    let rendered = render(&app, terminal_area.width, terminal_area.height);
    let rows = rendered.lines().collect::<Vec<_>>();

    assert!(rows[usize::from(input.y + 1)].contains("> ab"));
    assert!(rows[usize::from(input.y + 2)].contains("  cd"));
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
    crate::tui_assert_snapshot!("help_modal", rendered);
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
fn startup_panel_renders_the_effective_context() {
    let mut app = App::new();
    app.insert_text("/startup");
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    crate::tui_assert_snapshot!("startup_panel", render(&app, 80, 20));
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
    let modal = super::modal::layout(area);
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
    assert!(rendered.contains("ask permissions on"));
    assert!(!rows.iter().any(|line| line.trim() == "error"));
    assert!(!rows[19].contains("permissions on"));
    assert!(
        rows[usize::from(layout(&app, Rect::new(0, 0, 80, 20)).session.top_tip.y)]
            .contains("⏸ ask permissions on")
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

    crate::tui_assert_snapshot!("transcript_jump_to_bottom", render(&app, 50, 16));
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
fn transcript_content_aligns_with_the_composer_border_and_input_has_padding() {
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
    assert_eq!(buffer[(2, input.y + 1)].symbol(), "│");
    assert_eq!(buffer[(6, input.y + 1)].symbol(), "d");
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
    assert!(rendered.contains("/mcp"));
    assert!(rendered.contains("/usage"));
    assert!(!rendered.contains("/resume"));
    assert!(!rendered.contains("/archive-thread"));
    assert!(!rendered.contains("/archive-session"));
    assert!(!rendered.contains("/thread "));
    assert!(!rendered.contains("/login"));
    assert!(!rendered.contains("/plugins"));
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
    let position = format!(" {}/{} ", selected + 1, command_count);
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
    assert_eq!(selected, command_count - 1);

    let rendered = render(&app, terminal_area.width, terminal_area.height);
    assert!(rendered.contains(&format!(" {command_count}/{command_count} ")));
    let buffer = render_buffer(&app, terminal_area.width, terminal_area.height);
    assert_eq!(buffer[(79, popup_bottom - 1)].symbol(), "┃");
    assert_eq!(buffer[(79, popup_bottom - 1)].fg, test_context().muted());
    crate::tui_assert_snapshot!("slash_popup_scrolled_to_last_command", rendered);
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
        buffer[(6, layout(&app, terminal_area).input.y + 1)].symbol(),
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
        session_id: session_id.clone(),
        title: id.into(),
        status: if status == SessionManagerStatus::Completed {
            SessionStatus::Archived
        } else {
            SessionStatus::Active
        },
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
    crate::tui_assert_snapshot!("config_general_tab", render(&app, 100, 21));
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
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));

    let selection = app.list_selection().unwrap();
    assert_eq!(selection.active_tab().label(), "Issues");
    assert_eq!(selection.selected_item().unwrap().label(), "Auto refresh");
    crate::tui_assert_snapshot!(
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
    let content = super::modal::layout(Rect::new(0, 0, 100, 17)).content;
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
    crate::tui_assert_snapshot!("short_provider_panel", output);
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    let next = render(&app, 100, 17);
    assert!(next.contains("> API key"));
    assert!(next.contains("API key (optional)"));
    crate::tui_assert_snapshot!("short_provider_modal_api_key", next);
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
                model: ash_protocol::ModelRef::new(
                    ash_protocol::ProviderId::new("anthropic").unwrap(),
                    ash_protocol::ModelId::new("claude-sonnet").unwrap(),
                ),
                display_name: "Claude Sonnet".into(),
                access: ash_protocol::ModelAccess::Subscription,
                output_transport: ash_protocol::ModelOutputTransport::Unary,
                context_window: Some(200_000),
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
fn detail_modal_keeps_scrolled_content_above_its_own_footer() {
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
        let modal = super::modal::layout(area);
        assert!(modal.content.bottom() <= modal.footer.y.max(modal.content.y));
        app.handle_key_in_area(KeyEvent::new(KeyCode::End, KeyModifiers::NONE), area);
        let rendered = render(&app, 80, height);
        if !modal.footer.is_empty() {
            assert!(
                rendered
                    .lines()
                    .nth(usize::from(modal.footer.y))
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
        app.handle_key(crossterm::event::KeyEvent::new(
            crossterm::event::KeyCode::Enter,
            crossterm::event::KeyModifiers::NONE
        )),
        Some(crate::app::AppCommand::Issues(_))
    ));
    for (width, height) in [(100, 32), (60, 16)] {
        let screen = ratatui::layout::Rect::new(0, 0, width, height);
        assert_eq!(layout(&app, screen).session.bottom.bottom(), height);
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
            provider: "custom-gateway".into(),
            base_url: Some("https://example.test/v1".into()),
            max_output_tokens: None,
            model_context: Default::default(),
            custom: Some(CustomProviderConfigDto {
                context_window: 272_000,
                order: 1,
                name: "My gateway".into(),
                model: Some("gateway-model".into()),
                protocol: CustomProviderProtocolDto::Responses,
            }),
        },
    );
    let catalog = ash_app_server_protocol::protocol::model::ModelListResult {
        models: vec![
            ash_app_server_protocol::protocol::model::ModelCatalogEntry {
                model: ash_protocol::ModelRef::new(
                    ash_protocol::ProviderId::new("custom-gateway").unwrap(),
                    ash_protocol::ModelId::new("gateway-model").unwrap(),
                ),
                display_name: "gateway-model".into(),
                access: ash_protocol::ModelAccess::ApiKey,
                output_transport: ash_protocol::ModelOutputTransport::Unary,
                context_window: Some(272_000),
                auto_compact_token_limit: None,
                available_context_window: Some(240_000),
                capabilities: ash_protocol::ModelCapabilities::UNKNOWN,
                supported_reasoning_efforts: vec![],
                model_reasoning_effort: None,
                default_personality: None,
            },
        ],
    };
    crate::models::model_choices(
        &catalog,
        &config,
        &ash_app_server_protocol::protocol::provider::ProviderListResult { providers: vec![] },
    )
    .unwrap()
}

#[test]
fn model_favorites_empty_state_explains_pinning_from_provider_tabs() {
    let mut app = App::new();
    app.update(ModelEvent::PickerOpened(custom_model_choices(vec![])));
    assert_eq!(
        app.list_selection().unwrap().active_tab().label(),
        "Favorites"
    );
    assert_eq!(
        app.list_selection().unwrap().tabs()[1].label(),
        "My gateway"
    );
    crate::tui_assert_snapshot!("model_favorites_empty", render(&app, 100, 18));
}

#[test]
fn model_provider_tab_pins_without_changing_the_selected_model() {
    let mut app = App::new();
    app.update(ModelEvent::PickerOpened(custom_model_choices(vec![])));
    for code in [KeyCode::Tab, KeyCode::Down] {
        app.handle_key(KeyEvent::new(code, KeyModifiers::NONE));
    }
    assert_eq!(
        app.list_selection().unwrap().active_tab().label(),
        "My gateway"
    );
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
        app.list_selection().unwrap().active_tab().label(),
        "My gateway"
    );
    assert_eq!(
        app.list_selection()
            .unwrap()
            .selected_item()
            .unwrap()
            .label(),
        "gateway-model"
    );
    crate::tui_assert_snapshot!("model_provider_pinned", render(&app, 100, 18));
}

#[test]
fn model_favorites_reopens_with_saved_pins_and_unpin_action() {
    let mut app = App::new();
    app.update(ModelEvent::PickerOpened(custom_model_choices(vec![
        ModelRefDto {
            provider: "custom-gateway".into(),
            model: "gateway-model".into(),
        },
    ])));
    assert_eq!(
        app.list_selection().unwrap().active_tab().label(),
        "Favorites"
    );
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Char('p'), KeyModifiers::NONE)),
        Some(AppCommand::Models(crate::models::Command::Pin {
            preference: "custom-gateway/gateway-model".into(),
            pinned: false
        }))
    );
    crate::tui_assert_snapshot!("model_favorites_pinned", render(&app, 100, 18));
}

#[test]
fn model_tab_from_items_moves_the_visible_focus_to_the_tab_bar() {
    let mut app = App::new();
    app.update(ModelEvent::PickerOpened(custom_model_choices(vec![
        ModelRefDto {
            provider: "custom-gateway".into(),
            model: "gateway-model".into(),
        },
    ])));
    assert!(app.list_selection().unwrap().items_focused());
    app.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
    assert_eq!(
        app.list_selection().unwrap().active_tab().label(),
        "My gateway"
    );
    assert!(app.list_selection().unwrap().tabs_focused());
    let buffer = render_buffer(&app, 100, 18);
    let modal = super::modal::layout(Rect::new(0, 0, 100, 18));
    let text = render(&app, 100, 18);
    let row = text.lines().nth(usize::from(modal.content.y)).unwrap();
    let column = row[..row.find("My gateway").unwrap()].width() as u16;
    assert_eq!(buffer[(column, modal.content.y)].symbol(), "M");
    assert_eq!(
        buffer[(column, modal.content.y)].bg,
        test_context().selection_background()
    );
    assert_eq!(
        buffer[(column, modal.content.y)].fg,
        test_context().selection_foreground()
    );
    crate::tui_assert_snapshot!("model_tab_bar_focused", render(&app, 100, 18));
    assert!(app.list_selection().unwrap().search().is_none());
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    assert!(app.list_selection().unwrap().items_focused());
    app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    assert!(app.list_selection().unwrap().tabs_focused());
}

#[test]
fn status_indicator_tracks_turn_events_without_hiding_top_tip() {
    let mut app = App::new();
    app.set_active_turn(ash_protocol::TurnId::new("status-test").unwrap());
    app.update(ThreadEvent::TurnActivityChanged(TurnActivity::Working));
    app.update(HostEvent::TopTipNoticeShown("Copied 42 chars".into()));
    let areas = layout(&app, Rect::new(0, 0, 80, 20)).session;
    assert_eq!(areas.status_indicator.height, 1);
    assert_eq!(areas.status_indicator.bottom(), areas.top_tip.y);
    let working = render(&app, 80, 20);
    assert!(working.contains("Working"));
    assert!(working.contains("ctrl+c to interrupt"));
    assert!(working.contains("Copied 42 chars"));
    crate::tui_assert_snapshot!("status_indicator_with_notice", working);
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
    assert!(app.status_indicator().is_none());
    assert_eq!(
        layout(&app, Rect::new(0, 0, 80, 20))
            .session
            .status_indicator
            .height,
        0
    );
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
    crate::tui_assert_snapshot!("persistent_queue", render(&app, 80, 20));
}
