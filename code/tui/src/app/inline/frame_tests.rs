use super::draw;
use super::layout::height;
use crate::app::App;
use crate::config::Event as ConfigEvent;
use crate::config::TerminalSettings;
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
fn input_keeps_terminal_selection_and_uses_a_bounded_area() {
    let mut app = app();
    assert_eq!(app.mouse_mode(), MouseMode::TerminalSelection);
    assert!(!app.mouse_mode().enables_pointer_actions());
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
