use super::draw;
use crate::app::App;
use crate::app::AppCommand;
use crate::app::AppEvent;
use crate::config::Event as ConfigEvent;
use crate::config::TerminalSettings;
use crate::models::Event as ModelEvent;
use crate::terminal::MouseMode;
use crate::terminal::ScreenMode;
use crate::thread::Command as ThreadCommand;
use crate::thread::Event as ThreadEvent;
use crate::thread::ThreadRequestKind;
use crate::thread::interaction::approval::Approval;
use crate::thread::interaction::approval::ApprovalDecision;
use crate::thread::interaction::approval::ApprovalSpec;
use crate::thread::interaction::query::Query;
use crate::thread::interaction::query::QueryChoice;
use crate::thread::interaction::query::QueryCustomAnswer;
use crate::thread::interaction::query::QueryQuestion;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionModel;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::layout::Position;
use ratatui::layout::Rect;
use ratatui::style::Modifier;

pub(super) fn app() -> App {
    let mut app = App::new();
    let mut settings = TerminalSettings::default();
    settings.set_screen_mode(ScreenMode::Inline);
    app.update(ConfigEvent::SettingsReceived(settings));
    app
}

pub(super) fn render(app: &App, width: u16, rows: u16) -> Buffer {
    let rows = if super::output::expanded(app) {
        rows
    } else {
        super::layout::height(app, Rect::new(0, 0, width, rows))
    };
    let mut terminal = Terminal::new(TestBackend::new(width, rows)).unwrap();
    terminal
        .draw(|frame| draw(frame, app, &Default::default()))
        .unwrap();
    terminal.backend().buffer().clone()
}

fn open_help(app: &mut App) {
    app.update(AppEvent::HelpOpened(ListSelectionModel::new(
        "Help",
        vec![ListSelectionGroup::new(
            "Commands",
            vec![
                ListSelectionItem::new("First"),
                ListSelectionItem::new("Second"),
            ],
        )],
    )));
}

fn pending_query() -> Query {
    Query::new(vec![QueryQuestion {
        id: "next".into(),
        header: "Next step".into(),
        prompt: "How should the work continue?".into(),
        choices: vec![QueryChoice {
            label: "Continue".into(),
            description: "Use the proposed approach".into(),
        }],
        custom_answer: QueryCustomAnswer::Allowed,
    }])
    .unwrap()
}

#[test]
fn command_panel_keeps_background_approval_pending_until_close() {
    let mut app = app();
    app.insert_text("unfinished chat draft");
    open_help(&mut app);
    app.update(ThreadEvent::ApprovalRequested(Approval::new(
        ApprovalSpec {
            title: "Approval required".into(),
            reason: "Run the requested command?".into(),
            details: vec!["Process spawn  ·  cargo test".into()],
        },
    )));

    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        None
    );
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    assert_eq!(
        app.list_selection().unwrap().selected_visible_index(),
        Some(1)
    );
    assert_eq!(
        app.approval_view().unwrap().selected,
        ApprovalDecision::ApproveOnce
    );
    assert!(!app.approval_view().unwrap().submitting);
    let frame = text(&render(&app, 50, 16));
    assert!(frame.contains("Help"));
    assert!(!frame.contains("Approval required"));
    crate::tui_assert_snapshot!(app = &app; "panel_with_pending_approval", frame);

    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(app.command_panel().is_none());
    assert_eq!(app.input(), "unfinished chat draft");
    let frame = text(&render(&app, 50, 16));
    assert!(frame.contains("Run the requested command?"));
    crate::tui_assert_snapshot!(app = &app; "approval_restored_after_panel", frame);
    let Some(AppCommand::Thread(ThreadCommand::ResolveRequest(response))) =
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
    else {
        panic!("closing the panel must restore approval input");
    };
    assert_eq!(response.kind, ThreadRequestKind::Approval);
}

#[test]
fn command_panel_keeps_background_query_pending_until_close() {
    let mut app = app();
    app.insert_text("chat draft stays here");
    open_help(&mut app);
    app.update(ThreadEvent::QueryRequested(pending_query()));

    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        None
    );
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    assert_eq!(
        app.list_selection().unwrap().selected_visible_index(),
        Some(1)
    );
    assert_eq!(app.query_view().unwrap().selected, 0);
    assert!(!app.query_view().unwrap().submitting);
    crate::tui_assert_snapshot!(app = &app; "panel_with_pending_query", text(&render(&app, 50, 16)));

    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(app.command_panel().is_none());
    assert_eq!(app.input(), "chat draft stays here");
    crate::tui_assert_snapshot!(app = &app; "query_restored_after_panel", text(&render(&app, 50, 16)));
    let Some(AppCommand::Thread(ThreadCommand::ResolveRequest(response))) =
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
    else {
        panic!("closing the panel must restore query input");
    };
    assert_eq!(response.kind, ThreadRequestKind::Query);
}

#[test]
fn command_panel_paste_does_not_edit_a_background_query() {
    let mut app = app();
    app.insert_text("chat draft stays here");
    app.update(ThreadEvent::QueryRequested(pending_query()));
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    assert_eq!(app.query_view().unwrap().custom_answer, Some(""));
    app.update(ConfigEvent::EditorOpened(crate::config::config_choices(
        &crate::test_support::empty_config_snapshot(),
        &ash_app_server_protocol::protocol::provider::ProviderListResult { providers: vec![] },
        {
            let mut settings = TerminalSettings::default();
            settings.set_screen_mode(ScreenMode::Inline);
            settings
        },
        crate::status::StatusLineSettings::default(),
    )));
    app.handle_key(KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE));
    app.handle_paste("Screen mode".into());
    assert_eq!(app.list_selection().unwrap().query(), "Screen mode");
    assert_eq!(app.query_view().unwrap().custom_answer, Some(""));
    assert_eq!(app.input(), "chat draft stays here");
    crate::tui_assert_snapshot!(
        app = &app;
        "panel_search_with_pending_custom_answer",
        text(&render(&app, 50, 16))
    );
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(app.command_panel().is_none());
    app.handle_paste("Keep the user draft".into());
    assert_eq!(
        app.query_view().unwrap().custom_answer,
        Some("Keep the user draft")
    );
}

#[test]
fn short_query_remains_visible_while_browsing_history() {
    let mut app = app();
    let area = Rect::new(0, 0, 42, 12);
    app.insert_text("chat draft stays here");
    app.handle_key_in_area(KeyEvent::new(KeyCode::Home, KeyModifiers::CONTROL), area);
    assert!(app.transcript_scroll().anchor().is_some());
    app.update(ThreadEvent::QueryRequested(pending_query()));
    let layout = super::layout(&app, area);
    assert_eq!(layout.session.request.height, 6);
    assert_eq!(layout.session.transcript.height, 0);
    let buffer = render(&app, area.width, area.height);
    let frame = text(&buffer);
    assert!(frame.contains("How should the work continue?"));
    assert!(frame.contains("Continue  Use the proposed approach"));
    assert!(frame.contains("chat draft stays here"));
    assert_eq!(buffer[(1, layout.session.request.y + 2)].symbol(), ">");
    crate::tui_assert_snapshot!(app = &app; "short_query_while_browsing", frame);
}

#[test]
fn hooks_panel_opens_inline_and_restores_draft_after_close() {
    let mut app = app();
    app.insert_text("keep this draft");
    app.update(crate::hooks::Event::Opened(
        crate::test_support::hook_catalog(vec![]),
    ));
    assert_eq!(app.list_selection().unwrap().title(), "Extensions");
    crate::tui_assert_snapshot!(app = &app; "hooks_inline", text(&render(&app, 80, 24)));
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(app.command_panel().is_none());
    assert!(app.input().contains("keep this draft"));
}

#[test]
fn hooks_inline_details_wrap_and_scroll_without_losing_actions() {
    use ash_app_server_protocol::protocol::config::{
        HookActionDto, HookConfigDto, HookEnablementDto, HookEventDto, HookMatcherDto,
    };
    let hook = HookConfigDto {
        id: "user:hook:check".into(),
        event: HookEventDto::PreToolUse,
        matcher: HookMatcherDto { tool_names: vec![] },
        action: HookActionDto::Process {
            program: "/project with spaces/scripts/validate-changes.py".into(),
            args: vec![
                "--require-review-before-running-tools".into(),
                "--project=/long/path/to/current/project".into(),
                "--configuration-from=/long/path/to/.ash/config.toml".into(),
            ],
        },
        enablement: HookEnablementDto::Disabled,
    };
    let mut app = app();
    app.update(crate::hooks::Event::Opened(
        crate::test_support::hook_catalog(vec![hook]),
    ));
    for _ in 0..2 {
        app.handle_key_in_area(
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
            Rect::new(0, 0, 48, 14),
        );
    }
    assert_eq!(app.list_selection().unwrap().title(), "user:hook:check");
    crate::tui_assert_snapshot!(app = &app; "hooks_inline_detail_wrapped", text(&render(&app, 48, 14)));
    app.handle_key_in_area(
        KeyEvent::new(KeyCode::PageDown, KeyModifiers::NONE),
        Rect::new(0, 0, 48, 14),
    );
    let Some(crate::app::command_panel::CommandPanel::Hooks(panel)) = app.command_panel() else {
        panic!("expected Hooks panel")
    };
    assert!(panel.detail().unwrap().1 > 0);
    crate::tui_assert_snapshot!(app = &app; "hooks_inline_detail_scrolled", text(&render(&app, 48, 14)));
    assert!(matches!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        Some(AppCommand::Host(crate::host::Command::OpenTextFile { .. }))
    ));
}

#[test]
fn slash_completion_keeps_the_inline_input_at_the_bottom() {
    let mut app = app();
    let screen = Rect::new(0, 0, 80, 60);
    let resting_input_row = super::layout(&app, screen).input.y;

    app.insert_text("/status");
    assert!(app.completion_visible());
    let completion = render(&app, screen.width, screen.height);
    assert_eq!(super::layout(&app, screen).input.y, resting_input_row);
    crate::tui_assert_snapshot!(app = &app; "inline_status_completion_compact", text(&completion));

    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    assert!(!app.completion_visible());
}

pub(super) fn text(buffer: &Buffer) -> String {
    buffer
        .content
        .chunks(usize::from(buffer.area.width))
        .map(|row| {
            let mut line = String::new();
            let mut continuation = 0;
            for cell in row {
                if continuation > 0 {
                    continuation -= 1;
                    continue;
                }
                line.push_str(cell.symbol());
                continuation =
                    unicode_width::UnicodeWidthStr::width(cell.symbol()).saturating_sub(1);
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn dictation_preparation_uses_the_input_tip_and_preserves_the_statusline() {
    let mut app = app();
    app.insert_text("/voice");
    let Some(AppCommand::DictationStart { resource_id }) =
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
    else {
        panic!("expected dictation to start");
    };
    app.update(AppEvent::DictationStarted {
        resource_id: resource_id.clone(),
        error: None,
    });
    app.dictation_model_progress(
        &resource_id,
        ash_app_server_protocol::protocol::dictation::DictationModelStage::Checking,
    );
    let buffer = render(&app, 80, 20);

    let status = "Dictation · checking model files";
    let row = text(&buffer)
        .lines()
        .position(|line| line.contains(status))
        .expect("dictation status is visible");
    let areas = super::layout(&app, buffer.area);
    assert_eq!(row as u16, areas.session.tipline.y);
    assert!(row < usize::from(areas.input.y));
    let rendered = text(&buffer);
    assert!(
        rendered
            .lines()
            .nth(row)
            .unwrap()
            .contains("ctrl+c to stop dictation")
    );
    crate::tui_assert_snapshot!(app = &app; "dictation_preparation", text(&buffer));
    assert!(!rendered.contains("Listening"));
    assert!(rendered.contains("⏸ Manual"));
    assert_eq!(buffer[(2, row as u16)].fg, app.render_context().muted());
}

#[test]
fn dictation_model_preparation_shows_real_download_bytes_in_chinese() {
    let mut app = app();
    let mut settings = TerminalSettings::default();
    settings.set_screen_mode(ScreenMode::Inline);
    settings.set_language(crate::nls::Language::Chinese);
    app.update(ConfigEvent::SettingsReceived(settings));
    app.insert_text("/voice");
    let Some(AppCommand::DictationStart { resource_id }) =
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
    else {
        panic!("expected dictation start");
    };
    app.dictation_model_progress(
        "another-resource",
        ash_app_server_protocol::protocol::dictation::DictationModelStage::Loading,
    );
    assert_eq!(app.dictation_status(), None);
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
    crate::tui_assert_snapshot!(
        app = &app;
        "dictation_model_downloading_zh",
        text(&render(&app, 80, 20))
    );
}

#[test]
fn running_tip_follows_inline_chat_progress() {
    let mut app = app();
    app.set_active_turn(ash_protocol::TurnId::new("inline-tip").unwrap());
    app.update(crate::thread::Event::TurnActivityChanged(
        crate::thread::TurnActivity::Working,
    ));
    app.handle_tick(std::time::Instant::now() + std::time::Duration::from_secs(9));

    let rendered = text(&render(&app, 140, 20));
    assert!(rendered.contains("Working"));
    let rows = rendered.lines().collect::<Vec<_>>();
    let progress_row = rows.iter().position(|row| row.contains("Working")).unwrap();
    let tip_row = rows
        .iter()
        .position(|row| row.contains("Tip: Ask Ash"))
        .unwrap();
    let areas = super::layout(
        &app,
        Rect::new(0, 0, 140, render(&app, 140, 20).area.height),
    )
    .session;
    assert_eq!(tip_row, progress_row + 1);
    assert_eq!(progress_row, usize::from(areas.progress.y));
    assert_eq!(areas.progress.height, 2);
    assert_eq!(areas.progress.bottom(), areas.tipline.y);
    assert!(!rows[usize::from(areas.tipline.y)].contains("Working"));
    assert!(rendered.contains("Tip: Ask Ash to list steps for complex tasks"));

    let mut settings = TerminalSettings::default();
    settings.set_screen_mode(ScreenMode::Inline);
    settings.set_language(crate::nls::Language::Chinese);
    app.update(ConfigEvent::SettingsReceived(settings));
    let localized = text(&render(&app, 140, 20));
    assert!(localized.contains("正在处理"));
    assert!(localized.contains("技巧：复杂任务可以请 Ash 先列出步骤"));
    assert!(!localized.contains("Working"));
    crate::tui_assert_snapshot!(app = &app; "inline_running_tip_after_language_change", localized);
}

#[test]
fn input_stays_at_bottom_with_terminal_mouse_selection() {
    let mut app = app();
    assert_eq!(app.mouse_mode(), MouseMode::TerminalSelection);
    app.insert_text("继续检查终端历史");
    let buffer = render(&app, 80, 32);
    assert!(buffer.area.height < 32);
    assert!(text(&buffer).contains("继续检查终端历史"));
    assert!(!text(&buffer).contains("Ash Code v"));
    crate::tui_assert_snapshot!(app = &app; "input", text(&buffer));
    let layout = super::layout(&app, buffer.area);
    assert!(layout.input.height > 0);
    assert!(layout.input.bottom() <= buffer.area.bottom());
    let mut settings = TerminalSettings::default();
    settings.set_screen_mode(ScreenMode::Fullscreen);
    app.update(ConfigEvent::SettingsReceived(settings));
    assert_eq!(app.mouse_mode(), MouseMode::TuiCapture);
    assert!(app.input().contains("继续检查终端历史"));
}

#[test]
fn subscription_error_dialog_is_visible_in_the_inline_panel() {
    let mut app = app();
    app.update(ConfigEvent::EditorOpened(crate::config::config_choices(
        &crate::test_support::empty_config_snapshot(),
        &ash_app_server_protocol::protocol::provider::ProviderListResult { providers: vec![] },
        TerminalSettings::default(),
        crate::status::StatusLineSettings::default(),
    )));
    app.inline.panels.command_mut().unwrap().open_subscription(
        crate::config::Subscription::new(crate::config::SubscriptionProvider::Kimi).choices(),
        crate::config::SignOutAvailability::Unavailable,
    );
    app.inline
        .panels
        .command_mut()
        .unwrap()
        .show_subscription_error("Error", "Kimi token exchange failed with HTTP 400".into());

    let buffer = render(&app, 80, 24);
    assert!(text(&buffer).contains("Kimi token exchange failed with HTTP 400"));
    crate::tui_assert_snapshot!(app = &app; "subscription_error_dialog", text(&buffer));
}

#[test]
fn config_opens_and_closes_without_reprinting_history() {
    let mut app = app();
    let choices = crate::config::config_choices(
        &crate::test_support::empty_config_snapshot(),
        &ash_app_server_protocol::protocol::provider::ProviderListResult { providers: vec![] },
        {
            let mut settings = TerminalSettings::default();
            settings.set_screen_mode(ScreenMode::Inline);
            settings
        },
        crate::status::StatusLineSettings::default(),
    );
    app.update(ConfigEvent::EditorOpened(choices));
    assert!(app.command_panel().is_some());
    let buffer = render(&app, 100, 32);
    assert!(text(&buffer).contains("Vim mode"));
    assert!(text(&buffer).contains("Screen mode"));
    assert!(!text(&buffer).contains("more below"));
    assert!(super::layout(&app, buffer.area).session.composer.height > 12);
    crate::tui_assert_snapshot!(app = &app; "config", text(&buffer));
    let compact = render(&app, 100, 14);
    assert!(text(&compact).contains("more below"));
    assert!(text(&compact).contains("Esc close"));
    crate::tui_assert_snapshot!(app = &app; "config_compact", text(&compact));
    for _ in 0..8 {
        app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    }
    let scrolled = render(&app, 100, 14);
    assert!(text(&scrolled).contains("Screen mode"));
    assert!(text(&scrolled).contains("inline"));
    crate::tui_assert_snapshot!(app = &app; "config_scrolled_to_screen_mode", text(&scrolled));
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(app.command_panel().is_none());
    crate::tui_assert_snapshot!(app = &app; "config_closed", text(&render(&app, 100, 32)));
}

#[test]
fn model_list_opens_inline_and_restores_input_after_close() {
    let mut app = app();
    app.insert_text("keep this draft");
    let mut config = crate::test_support::empty_config_snapshot();
    config.providers.insert(
        "openai".into(),
        ash_app_server_protocol::protocol::config::ProviderConfigDto {
            fast_models: Default::default(),
            connection: "openai".into(),
            provider: "openai".into(),
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
        ash_protocol::ProviderId::new("openai").unwrap(),
        ash_protocol::ModelId::new("gpt-test").unwrap(),
    );
    let mut info = ash_protocol::ModelInfo::new(model.model.clone(), "GPT Test");
    info.supported_reasoning_efforts = vec![
        ash_protocol::ReasoningEffort::Low,
        ash_protocol::ReasoningEffort::Medium,
        ash_protocol::ReasoningEffort::High,
    ];
    info.model_reasoning_effort = Some(ash_protocol::ReasoningEffort::Medium);
    let catalog = ash_app_server_protocol::protocol::model::ModelListResult {
        models: vec![
            ash_app_server_protocol::protocol::model::ModelCatalogEntry::from_info(
                model.clone(),
                &info,
            ),
        ],
    };
    let choices = crate::models::model_choices(&catalog, &config).unwrap();
    app.update(ModelEvent::PickerOpened(choices));
    assert!(!app.list_selection().unwrap().show_tabs());
    assert_eq!(
        app.list_selection().unwrap().selected_visible_index(),
        Some(0)
    );
    let buffer = render(&app, 100, 32);
    assert!(text(&buffer).contains("GPT Test"));
    assert!(text(&buffer).contains("██ ██ ██"));
    let panel_area = super::layout(&app, buffer.area).session.composer;
    let blocks = buffer
        .content
        .iter()
        .enumerate()
        .filter(|(index, cell)| {
            cell.symbol() == "█"
                && panel_area.contains(Position::new(
                    (index % usize::from(buffer.area.width)) as u16,
                    (index / usize::from(buffer.area.width)) as u16,
                ))
        })
        .map(|(_, cell)| cell)
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
        ]
    );
    assert!(!text(&buffer).contains("openai"));
    let unpinned = text(&buffer);
    assert!(
        app.command_panel_key_hints()
            .unwrap()
            .text()
            .contains("p pin")
    );
    assert!(
        !app.command_panel_key_hints()
            .unwrap()
            .text()
            .contains("unpin")
    );
    app.handle_key(KeyEvent::new(KeyCode::Right, KeyModifiers::NONE));
    assert!(text(&render(&app, 100, 32)).contains("██ ██ ██"));
    let mut settings = TerminalSettings::default();
    settings.set_screen_mode(ScreenMode::Inline);
    settings.set_language(crate::nls::Language::Chinese);
    app.update(ConfigEvent::SettingsReceived(settings));
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Char('p'), KeyModifiers::NONE)),
        Some(AppCommand::Models(crate::models::Command::Pin {
            preference: "openai/gpt-test".into(),
            pinned: true,
        }))
    );
    config.tui.0.insert(
        "pinnedModels".into(),
        serde_json::json!([{"provider":"openai", "model":"gpt-test"}]),
    );
    app.update(ModelEvent::PickerUpdated(
        crate::models::model_choices(&catalog, &config).unwrap(),
    ));
    assert_eq!(
        app.command_panel_key_hints()
            .unwrap()
            .localized_text(crate::nls::Language::Chinese),
        "↑↓ 选择 · Tab 设置项 · ←→ 调整 · / 搜索 · p 取消固定 · Enter 应用 · Esc 取消"
    );
    let pinned = text(&render(&app, 100, 32));
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Char('p'), KeyModifiers::NONE)),
        Some(AppCommand::Models(crate::models::Command::Pin {
            preference: "openai/gpt-test".into(),
            pinned: false,
        }))
    );
    config.tui.0.remove("pinnedModels");
    app.update(ModelEvent::PickerUpdated(
        crate::models::model_choices(&catalog, &config).unwrap(),
    ));
    assert_eq!(
        app.command_panel_key_hints()
            .unwrap()
            .localized_text(crate::nls::Language::Chinese),
        "↑↓ 选择 · Tab 设置项 · ←→ 调整 · / 搜索 · p 固定 · Enter 应用 · Esc 取消"
    );
    let unpinned_chinese = text(&render(&app, 100, 32));
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(app.command_panel().is_none());
    assert!(app.chat_input_focused());
    assert_eq!(app.input(), "keep this draft");
    crate::tui_assert_snapshot!(app = &app; "model_list", unpinned);
    crate::tui_assert_snapshot!(
        app = &app;
        "model_pin_actions_chinese",
        format!("Pinned\n{pinned}\n\nUnpinned\n{unpinned_chinese}")
    );
}

#[test]
fn key_hint_style_applies_to_inline_panels_without_changing_hint_text() {
    let mut app = app();
    let choices = crate::config::config_choices(
        &crate::test_support::empty_config_snapshot(),
        &ash_app_server_protocol::protocol::provider::ProviderListResult { providers: vec![] },
        {
            let mut settings = TerminalSettings::default();
            settings.set_screen_mode(ScreenMode::Inline);
            settings
        },
        crate::status::StatusLineSettings::default(),
    );
    app.update(ConfigEvent::EditorOpened(choices));

    let contrast = render(&app, 100, 32);
    let row = contrast.area.height - 1;
    assert_eq!(contrast[(2, row)].symbol(), "E");
    assert_eq!(
        contrast[(2, row)].fg,
        crate::render::test_context().foreground()
    );
    assert!(contrast[(2, row)].modifier.contains(Modifier::BOLD));
    assert_eq!(
        contrast[(13, row)].fg,
        crate::render::test_context().muted()
    );
    assert!(!contrast[(13, row)].modifier.contains(Modifier::BOLD));

    let mut settings = TerminalSettings::default();
    settings.set_screen_mode(ScreenMode::Inline);
    settings.set_key_hint_style(crate::config::KeyHintStyle::Muted);
    app.update(ConfigEvent::SettingsReceived(settings));
    let muted = render(&app, 100, 32);
    let row = muted.area.height - 1;
    assert_eq!(muted[(2, row)].symbol(), "E");
    assert_eq!(muted[(2, row)].fg, crate::render::test_context().muted());
    assert!(muted[(2, row)].modifier.contains(Modifier::ITALIC));
    assert_eq!(muted[(13, row)].fg, crate::render::test_context().muted());
    assert!(muted[(13, row)].modifier.contains(Modifier::ITALIC));
}

#[test]
fn context_hints_replace_the_second_statusline_and_restore_permission() {
    let mut app = app();
    app.insert_text("keep this draft");
    app.chat_panel
        .status_line_mut()
        .apply_model_label("Fixture model");
    let normal = render(&app, 80, 20);
    let regions = super::layout(&app, normal.area).session;
    assert_eq!(regions.footer.statusline.height, 1);
    assert_eq!(regions.footer.hintline.y, regions.footer.statusline.y + 1);
    assert_eq!(
        regions.footer.hintline.y,
        regions.footer.statusline.bottom()
    );
    assert_eq!(regions.composer.bottom(), regions.footer.statusline.y);
    let normal_text = text(&normal);
    assert!(
        normal_text
            .lines()
            .nth(usize::from(regions.footer.statusline.y))
            .unwrap()
            .contains("Fixture model")
    );
    assert!(normal_text.lines().last().unwrap().contains("⏸ Manual"));
    assert!(!normal_text.contains("Enter send"));
    assert_eq!(
        normal[(2, regions.footer.hintline.y)].fg,
        app.render_context().warning()
    );

    app.update(ThreadEvent::QueryRequested(pending_query()));
    assert!(app.query_view().is_some());
    let question = render(&app, 80, 20);
    let question_text = text(&question);
    assert!(
        question_text
            .lines()
            .last()
            .unwrap()
            .contains("Enter to answer")
    );
    assert!(!question_text.contains("Manual"));
    assert!(question_text.contains("Fixture model"));
    let Some(AppCommand::Thread(ThreadCommand::ResolveRequest(response))) =
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
    else {
        panic!("query answer must resolve the active request");
    };
    assert_eq!(response.kind, ThreadRequestKind::Query);
    assert!(app.query_view().unwrap().submitting);
    let waiting = text(&render(&app, 80, 20));
    assert!(
        waiting
            .lines()
            .last()
            .unwrap()
            .contains("Waiting for the request result")
    );
    assert!(!waiting.contains("Manual"));
    app.update(ThreadEvent::RequestResolved(response.identity()));
    assert!(app.query_view().is_none());
    assert_eq!(app.input(), "keep this draft");
    let restored = render(&app, 80, 20);
    assert_eq!(restored, normal);

    open_help(&mut app);
    assert!(app.command_panel().is_some());
    let panel = text(&render(&app, 80, 20));
    assert!(panel.lines().last().unwrap().contains("Esc"));
    assert!(!panel.contains("Manual"));
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(app.command_panel().is_none());
    assert_eq!(app.input(), "keep this draft");
    assert_eq!(render(&app, 80, 20), normal);
    crate::tui_assert_snapshot!(
        app = &app;
        "second_statusline_context_hints",
        format!(
            "Normal\n{normal_text}\nQuestion\n{question_text}\nWaiting\n{waiting}\nPanel\n{panel}\nRestored\n{}",
            text(&restored)
        )
    );
}

#[test]
fn policy_stays_below_input_and_inline_tips_do_not_fade() {
    use std::time::Duration;
    use std::time::Instant;
    let mut app = app();
    let started = Instant::now();
    app.show_policy_tip(started);
    let before = render(&app, 80, 32);
    let areas = super::layout(&app, before.area).session;
    assert!(
        text(&before)
            .lines()
            .nth(usize::from(areas.footer.hintline.y))
            .unwrap()
            .contains("⏸ Manual")
    );
    assert!(!app.handle_tick(started + Duration::from_secs(4)));
    assert_eq!(render(&app, 80, 32), before);
    assert!(app.handle_tick(started + Duration::from_secs(5)));
    let after = render(&app, 80, 32);
    assert!(
        text(&after)
            .lines()
            .nth(usize::from(areas.tipline.y))
            .unwrap()
            .trim()
            .is_empty()
    );
    assert!(
        text(&after)
            .lines()
            .nth(usize::from(areas.footer.hintline.y))
            .unwrap()
            .contains("⏸ Manual")
    );
}

#[test]
fn plugins_inline_marks_disabled_items_and_restores_draft_after_close() {
    let mut app = app();
    app.insert_text("keep this draft");
    let plugins = serde_json::from_value(serde_json::json!({"revision":1,"activationGeneration":1,"packages":[{
        "id":"review@ash","version":"1","digest":"sha256:fixture","enabled":false,"granted":true,"effective":false,"revoked":false
    }]})).unwrap();
    app.update(crate::marketplace::Event(
        crate::marketplace::Page::Plugins(plugins),
    ));
    let buffer = render(&app, 80, 24);
    let marker = buffer
        .content
        .windows(9)
        .find(|cells| cells.iter().map(|cell| cell.symbol()).collect::<String>() == "[disable]")
        .unwrap();
    assert!(
        marker
            .iter()
            .all(|cell| cell.fg == app.render_context().danger())
    );
    crate::tui_assert_snapshot!(app = &app; "plugins_inline_disabled", text(&buffer));
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(app.command_panel().is_none());
    assert!(app.input().contains("keep this draft"));
}
