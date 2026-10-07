use crate::app::App;
use crate::app::command_panel::CommandPanel;
use crate::config::TerminalSettings;
use crate::keymap::KeyEvent;
use crate::nls::Language;
use crate::terminal::ScreenMode;
use crossterm::event::KeyCode;
use crossterm::event::KeyEventKind;
use crossterm::event::KeyModifiers;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Modifier;

fn app(mode: ScreenMode, language: Language) -> App {
    let mut app = App::for_dir_with_input_catalog_and_startup_context(
        std::path::Path::new("."),
        crate::thread::composer::ChatInputCatalog::default(),
        crate::TuiStartupContext::new("."),
    );
    configure(&mut app, mode, language);
    app
}

fn configure(app: &mut App, mode: ScreenMode, language: Language) {
    let mut settings = TerminalSettings::default();
    settings.set_screen_mode(mode);
    settings.set_language(language);
    app.update(crate::config::Event::SettingsReceived(settings));
}

fn press(app: &mut App, code: KeyCode, area: Rect) {
    assert_eq!(
        app.handle_key_in_area(KeyEvent::new(code, KeyModifiers::NONE), area),
        None
    );
}

fn render(app: &App, area: Rect) -> Buffer {
    let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
    terminal
        .draw(|frame| crate::app::frame::draw(frame, app))
        .unwrap();
    terminal.backend().buffer().clone()
}

fn text(buffer: &Buffer) -> String {
    crate::terminal::text::text_in_range(
        buffer,
        crate::terminal::text::ScreenSelectionRange::new(
            ratatui::layout::Position::new(0, 0),
            ratatui::layout::Position::new(buffer.area.width - 1, buffer.area.height - 1),
        ),
    )
    .unwrap()
}

#[test]
fn question_mark_opens_shortcuts_and_dismissal_restores_input_in_both_modes() {
    for mode in [ScreenMode::Fullscreen, ScreenMode::Inline] {
        let mut app = app(mode, Language::English);
        let area = Rect::new(0, 0, 160, 32);
        let before = text(&render(&app, area));
        assert!(before.contains("? for shortcuts"));
        for modifiers in [KeyModifiers::NONE, KeyModifiers::SHIFT] {
            app.handle_key_in_area(
                KeyEvent::new_with_kind(KeyCode::Char('?'), modifiers, KeyEventKind::Release),
                area,
            );
            assert!(app.command_panel().is_none());
            assert_eq!(
                app.handle_key_in_area(KeyEvent::new(KeyCode::Char('?'), modifiers), area),
                None
            );
            assert!(matches!(
                app.command_panel(),
                Some(CommandPanel::Shortcuts(_))
            ));
            assert!(app.input().is_empty());
            app.handle_key_in_area(
                KeyEvent::new_with_kind(KeyCode::Char('?'), modifiers, KeyEventKind::Repeat),
                area,
            );
            assert!(matches!(
                app.command_panel(),
                Some(CommandPanel::Shortcuts(_))
            ));
            assert!(!app.chat_input_focused());
            press(&mut app, KeyCode::Char('x'), area);
            app.handle_paste("pasted text".into());
            assert!(app.input().is_empty());
            let opened = render(&app, area);
            let output = text(&opened);
            for title in [
                "Keyboard shortcuts",
                "Compose",
                "Session",
                "Transcript",
                "/shortcuts customize",
            ] {
                assert!(output.contains(title), "{mode:?}: {title}\n{output}");
            }
            assert!(opened.content.iter().any(|cell| cell.symbol() == "/"
                && cell.fg == app.render_context().focus()
                && cell.modifier.contains(Modifier::BOLD)));
            crate::tui_assert_snapshot!(app = &app; "shortcuts_wide", output);
            press(&mut app, KeyCode::Esc, area);
            assert!(app.command_panel().is_none());
            assert!(app.chat_input_focused());
            assert_eq!(text(&render(&app, area)), before);
        }
        press(&mut app, KeyCode::Char('?'), area);
        press(&mut app, KeyCode::Char('?'), area);
        assert!(app.command_panel().is_none());
        press(&mut app, KeyCode::Char('x'), area);
        press(&mut app, KeyCode::Char('?'), area);
        assert_eq!(app.input(), "x?");
        assert!(app.command_panel().is_none());
        assert!(!text(&render(&app, area)).contains("? for shortcuts"));
    }
}

#[test]
fn question_mark_remains_text_in_a_draft_and_history_search() {
    for mode in [ScreenMode::Fullscreen, ScreenMode::Inline] {
        for draft in [" ", "already typing", "/", "@"] {
            let mut app = app(mode, Language::English);
            let area = Rect::new(0, 0, 80, 24);
            app.insert_text(draft);
            press(&mut app, KeyCode::Char('?'), area);
            assert!(app.command_panel().is_none());
            assert_eq!(app.input(), format!("{draft}?"));
        }
        let mut app = app(mode, Language::English);
        let area = Rect::new(0, 0, 80, 24);
        app.handle_key_in_area(
            KeyEvent::new(KeyCode::Char('r'), KeyModifiers::CONTROL),
            area,
        );
        assert!(app.input_state().searching_history());
        press(&mut app, KeyCode::Char('?'), area);
        assert!(app.command_panel().is_none());
        assert!(app.input_state().searching_history());
    }
}

#[test]
fn shortcuts_reflow_localize_scroll_and_transfer_between_modes() {
    for mode in [ScreenMode::Fullscreen, ScreenMode::Inline] {
        for language in [Language::English, Language::Chinese] {
            let mut app = app(mode, language);
            let area = Rect::new(0, 0, 90, 32);
            press(&mut app, KeyCode::Char('?'), area);
            let output = text(&render(&app, area));
            assert!(
                output.replace(' ', "").contains(
                    &crate::nls::localize(language, "Keyboard shortcuts").replace(' ', "")
                )
            );
            crate::tui_assert_snapshot!(app = &app; if language == Language::Chinese { "shortcuts_medium_chinese" } else { "shortcuts_medium" }, output);
            let narrow = Rect::new(0, 0, 44, 18);
            press(&mut app, KeyCode::End, narrow);
            let bottom = text(&render(&app, narrow));
            assert!(bottom.contains("/shortcuts"));
            crate::tui_assert_snapshot!(app = &app; if language == Language::Chinese { "shortcuts_narrow_end_chinese" } else { "shortcuts_narrow_end" }, bottom);
            press(&mut app, KeyCode::Up, narrow);
            assert_ne!(text(&render(&app, narrow)), bottom);
            let scroll = match app.command_panel().unwrap() {
                CommandPanel::Shortcuts(panel) => panel.scroll,
                _ => panic!("shortcut reference is active"),
            };
            configure(
                &mut app,
                if mode == ScreenMode::Fullscreen {
                    ScreenMode::Inline
                } else {
                    ScreenMode::Fullscreen
                },
                language,
            );
            assert!(
                matches!(app.command_panel(), Some(CommandPanel::Shortcuts(panel)) if panel.scroll == scroll)
            );
            press(&mut app, KeyCode::Home, narrow);
            crate::tui_assert_snapshot!(app = &app; if language == Language::Chinese { "shortcuts_narrow_start_chinese" } else { "shortcuts_narrow_start" }, text(&render(&app, narrow)));
            press(&mut app, KeyCode::Esc, narrow);
            assert!(app.chat_input_focused());
        }
    }
}

#[test]
fn shortcut_reference_resolves_custom_bindings_and_omits_blocked_defaults() {
    use ash_app_server_protocol::protocol::config::FrontendConfigDto;
    use std::collections::BTreeMap;
    let mut app = app(ScreenMode::Fullscreen, Language::Chinese);
    let settings = crate::keymap_setup::settings_from_tui(&FrontendConfigDto(BTreeMap::from([(
        "keybindings".into(),
        serde_json::json!([
            {"key": "ctrl+y", "command": "ashCode.action.copyLastResponse"},
            {"key": "ctrl+z", "block": true}
        ]),
    )])))
    .unwrap();
    app.update(crate::keymap_setup::Event::SettingsReceived(settings));
    let area = Rect::new(0, 0, 160, 32);
    press(&mut app, KeyCode::Char('?'), area);
    let output = text(&render(&app, area));
    assert!(output.contains("ctrl+y"));
    assert!(!output.contains("ctrl+o"));
    assert!(!output.contains("ctrl+z"));
    assert!(output.replace(' ', "").contains("复制上一条回复"));
    crate::tui_assert_snapshot!(app = &app; "shortcuts_custom_chinese", output);
}

#[test]
fn question_mark_opens_shortcuts_from_the_conversation() {
    for mode in [ScreenMode::Fullscreen, ScreenMode::Inline] {
        let mut app = App::new();
        configure(&mut app, mode, Language::English);
        let area = Rect::new(0, 0, 80, 24);
        let before = text(&render(&app, area));
        press(&mut app, KeyCode::Char('?'), area);
        assert!(matches!(
            app.command_panel(),
            Some(CommandPanel::Shortcuts(_))
        ));
        crate::tui_assert_snapshot!(app = &app; "shortcuts_conversation", text(&render(&app, area)));
        press(&mut app, KeyCode::Esc, area);
        assert_eq!(text(&render(&app, area)), before);
        assert!(app.chat_input_focused());
    }
}

#[test]
fn question_mark_does_not_open_help_for_attachments_or_pending_chords() {
    for mode in [ScreenMode::Fullscreen, ScreenMode::Inline] {
        let area = Rect::new(0, 0, 80, 24);
        let mut attached = app(mode, Language::English);
        attached.update(crate::host::Event::ClipboardImageRead {
            target: attached.draft_target(),
            result: Ok(crate::host::clipboard::ClipboardImage {
                png: b"\x89PNG\r\n\x1a\npayload".to_vec(),
                fingerprint: crate::host::clipboard::ClipboardImageFingerprint(1),
                width: 1,
                height: 1,
            }),
        });
        assert!(!attached.can_open_shortcut_help());
        press(&mut attached, KeyCode::Char('?'), area);
        assert!(attached.command_panel().is_none());
        assert_eq!(attached.input(), "[Image #1] ?");

        let mut app = app(mode, Language::English);
        let settings = crate::keymap_setup::settings_from_tui(
            &ash_app_server_protocol::protocol::config::FrontendConfigDto(
                std::collections::BTreeMap::from([(
                    "keybindings".into(),
                    serde_json::json!([
                        {"key": "ctrl+k ?", "command": "ashCode.action.copyLastResponse"}
                    ]),
                )]),
            ),
        )
        .unwrap();
        app.update(crate::keymap_setup::Event::SettingsReceived(settings));
        assert_eq!(
            app.handle_key_in_area(
                KeyEvent::new(KeyCode::Char('k'), KeyModifiers::CONTROL),
                area
            ),
            None
        );
        assert!(app.pending_key_chord_label().is_some());
        assert!(!app.can_open_shortcut_help());
        assert_eq!(
            app.handle_key_in_area(KeyEvent::new(KeyCode::Char('?'), KeyModifiers::NONE), area),
            Some(crate::app::AppCommand::Host(
                crate::host::Command::CopyLastResponse
            ))
        );
        assert!(app.command_panel().is_none());
    }
}
