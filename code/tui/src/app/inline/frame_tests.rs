use super::draw;
use super::layout::height;
use crate::app::App;
use crate::app::AppCommand;
use crate::app::AppEvent;
use crate::config::Event as ConfigEvent;
use crate::config::TerminalSettings;
use crate::models::Event as ModelEvent;
use crate::terminal::MouseMode;
use crate::terminal::ScreenMode;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
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
    let rows = height(app, Rect::new(0, 0, width, rows));
    let mut terminal = Terminal::new(TestBackend::new(width, rows)).unwrap();
    terminal
        .draw(|frame| draw(frame, app, &Default::default()))
        .unwrap();
    terminal.backend().buffer().clone()
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
fn voice_status_is_visible_below_the_inline_input() {
    let mut app = app();
    app.insert_text("/voice");
    let Some(AppCommand::VoiceStart { resource_id }) =
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
    else {
        panic!("expected voice mode to start");
    };
    app.update(AppEvent::VoiceStarted {
        resource_id,
        error: None,
    });

    let buffer = render(&app, 80, 20);
    crate::tui_assert_snapshot!("voice_listening", text(&buffer));
    let status = "Voice · listening · /voice to stop";
    let row = text(&buffer)
        .lines()
        .position(|line| line.contains(status))
        .expect("voice status is visible");
    assert_eq!(buffer[(2, row as u16)].fg, app.render_context().muted());
}

#[test]
fn running_tip_appears_below_the_inline_spinner() {
    let mut app = app();
    app.set_active_turn(ash_protocol::TurnId::new("inline-tip").unwrap());
    app.update(crate::thread::Event::TurnActivityChanged(
        crate::thread::TurnActivity::Working,
    ));
    app.handle_tick(std::time::Instant::now() + std::time::Duration::from_secs(9));

    let rendered = text(&render(&app, 80, 20));
    assert!(rendered.contains("Working"));
    assert!(rendered.contains("└ Tip: Ask Ash to list steps for complex tasks"));
}

#[test]
fn input_uses_a_bounded_area_with_terminal_mouse_selection() {
    let mut app = app();
    assert_eq!(app.mouse_mode(), MouseMode::TerminalSelection);
    app.insert_text("继续检查终端历史");
    let buffer = render(&app, 80, 32);
    assert!(buffer.area.height < 32);
    assert!(text(&buffer).contains("继续检查终端历史"));
    assert!(!text(&buffer).contains("Ash Code v"));
    crate::tui_assert_snapshot!("input", text(&buffer));
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
    crate::tui_assert_snapshot!("subscription_error_dialog", text(&buffer));
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
    assert!(text(&buffer).contains("Screen mode"));
    assert!(text(&buffer).contains("inline"));
    crate::tui_assert_snapshot!("config", text(&buffer));
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(app.command_panel().is_none());
    crate::tui_assert_snapshot!("config_closed", text(&render(&app, 100, 32)));
}

#[test]
fn model_list_opens_inline_and_restores_input_after_close() {
    let mut app = app();
    app.insert_text("keep this draft");
    let mut config = crate::test_support::empty_config_snapshot();
    config.providers.insert(
        "openai".into(),
        ash_app_server_protocol::protocol::config::ProviderConfigDto {
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
    assert!(text(&buffer).contains("◼◼◼"));
    let blocks = buffer
        .content
        .iter()
        .filter(|cell| cell.symbol() == "◼")
        .collect::<Vec<_>>();
    assert!(
        blocks
            .iter()
            .any(|cell| cell.fg == app.render_context().accent())
    );
    assert!(
        blocks
            .iter()
            .any(|cell| cell.fg == app.render_context().muted())
    );
    assert!(!text(&buffer).contains("openai"));
    crate::tui_assert_snapshot!("model_list", text(&buffer));
    app.handle_key(KeyEvent::new(KeyCode::Right, KeyModifiers::NONE));
    assert!(text(&render(&app, 100, 32)).contains("◼◼◼"));
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(app.command_panel().is_none());
    assert!(app.chat_input_focused());
    assert_eq!(app.input(), "keep this draft");
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
            .last()
            .unwrap()
            .contains("⏸ ask permissions on")
    );
    assert!(!app.handle_tick(started + Duration::from_secs(4)));
    assert_eq!(render(&app, 80, 32), before);
    assert!(app.handle_tick(started + Duration::from_secs(5)));
    let after = render(&app, 80, 32);
    assert!(
        text(&after)
            .lines()
            .nth(usize::from(areas.top_tip.y))
            .unwrap()
            .trim()
            .is_empty()
    );
    assert!(
        text(&after)
            .lines()
            .last()
            .unwrap()
            .contains("⏸ ask permissions on")
    );
}
