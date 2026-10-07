use crate::app::App;
use crate::config::KeyHintStyle;
use crate::config::TerminalSettings;
use crate::keymap::KeyEvent;
use crate::nls::Language;
use crate::status::StatusLineItem;
use crate::status::StatusLineSettings;
use crate::terminal::ScreenMode;
use crossterm::event::KeyCode;
use crossterm::event::KeyModifiers;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Modifier;

fn render(app: &App, width: u16, height: u16) -> Buffer {
    let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
    terminal
        .draw(|frame| crate::app::frame::draw(frame, app))
        .unwrap();
    terminal.backend().buffer().clone()
}

fn areas(app: &App, area: Rect) -> super::Layout {
    match app.screen_mode() {
        ScreenMode::Fullscreen => crate::app::fullscreen::layout(app, area).session.footer,
        ScreenMode::Inline => crate::app::inline::layout(app, area).session.footer,
    }
}

fn row(buffer: &Buffer, y: u16) -> String {
    (0..buffer.area.width)
        .map(|x| buffer[(x, y)].symbol())
        .collect()
}

fn text(buffer: &Buffer) -> String {
    (0..buffer.area.height)
        .map(|y| row(buffer, y))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn permission_text_uses_its_mode_color_in_both_screens_and_languages() {
    use unicode_segmentation::UnicodeSegmentation;
    use unicode_width::UnicodeWidthStr;
    for screen in [ScreenMode::Fullscreen, ScreenMode::Inline] {
        for language in [Language::English, Language::Chinese] {
            let mut app = App::new();
            let mut terminal = TerminalSettings::default();
            terminal.set_screen_mode(screen);
            terminal.set_language(language);
            app.update(crate::config::Event::SettingsReceived(terminal));
            for (approval, label, color) in [
                (
                    ash_protocol::ApprovalMode::Manual,
                    "⏸ Manual",
                    app.render_context().warning(),
                ),
                (
                    ash_protocol::ApprovalMode::Auto,
                    "⏩ Auto",
                    app.render_context().accent(),
                ),
                (
                    ash_protocol::ApprovalMode::BypassPermissions,
                    "▶ Bypass permissions",
                    app.render_context().danger(),
                ),
            ] {
                app.set_next_approval_mode(approval);
                let buffer = render(&app, 100, 20);
                let y = areas(&app, buffer.area).hintline.y;
                let (icon, label) = label.split_once(' ').unwrap();
                let label = format!("{icon} {}", crate::nls::localize(language, label));
                assert!(
                    row(&buffer, y)
                        .replace(' ', "")
                        .contains(&label.replace(' ', ""))
                );
                let mut x = 2;
                for symbol in label.graphemes(true) {
                    assert_eq!(
                        buffer[(x, y)].fg,
                        color,
                        "{screen:?} {language:?} {approval:?} x={x}"
                    );
                    x += symbol.width() as u16;
                }
                let separator = 2 + label.width() as u16 + 1;
                assert_eq!(buffer[(separator, y)].symbol(), "·");
                assert_eq!(buffer[(separator, y)].fg, app.render_context().muted());
            }
        }
    }
}

#[test]
fn dashboard_shares_the_left_hint_row_and_permission_switch_in_both_modes() {
    let mut frames = Vec::new();
    for mode in [ScreenMode::Fullscreen, ScreenMode::Inline] {
        for width in [80, 32] {
            for permissions in [true, false] {
                let mut app = App::new();
                let mut settings = TerminalSettings::default();
                settings.set_screen_mode(mode);
                settings.set_language(Language::Chinese);
                app.update(crate::config::Event::SettingsReceived(settings));
                let mut status = StatusLineSettings::default();
                for item in StatusLineItem::ALL {
                    status.set(item, item == StatusLineItem::Permissions && permissions);
                }
                app.update(crate::status::Event::LineSettingsReceived(status));
                assert!(app.can_open_dashboard_from_input());
                let buffer = render(&app, width, 14);
                let footer = areas(&app, buffer.area);
                assert_eq!(footer.statusline.height, 1);
                assert_eq!(footer.statusline.bottom(), footer.hintline.y);
                let hints = row(&buffer, footer.hintline.y);
                assert!(
                    hints.replace(' ', "").contains("←仪表盘"),
                    "{mode:?}: {hints}"
                );
                assert_ne!(buffer[(2, footer.hintline.y)].symbol(), " ");
                let expected = match (permissions, width) {
                    (true, 32) => "  ⏸ 手动 · ← 仪表盘",
                    (true, _) => "  ⏸ 手动 · ← 仪表盘 · ? 查看快捷键",
                    (false, _) => "  ← 仪表盘 · ? 查看快捷键",
                };
                assert_eq!(
                    hints.replace(' ', ""),
                    expected.replace(' ', ""),
                    "{mode:?}"
                );
                let permission_row = footer.hintline.y;
                assert!(!row(&buffer, footer.statusline.y).contains("手动"));
                assert_eq!(
                    row(&buffer, permission_row)
                        .replace(' ', "")
                        .contains("手动"),
                    permissions
                );
                let key_column = (2..width)
                    .find(|&x| buffer[(x, footer.hintline.y)].symbol() == "←")
                    .unwrap();
                assert_eq!(key_column, if permissions { 11 } else { 2 });
                let key = &buffer[(key_column, footer.hintline.y)];
                assert_eq!(key.fg, app.render_context().foreground());
                assert!(key.modifier.contains(Modifier::BOLD));
                frames.push(format!(
                    "{mode:?} · width={width} · permissions={permissions}\n{}",
                    text(&buffer).trim_end()
                ));

                settings.set_key_hint_style(KeyHintStyle::Muted);
                app.update(crate::config::Event::SettingsReceived(settings));
                let muted = render(&app, width, 14);
                assert_eq!(text(&muted), text(&buffer));
                assert_eq!(
                    muted[(key_column, footer.hintline.y)].fg,
                    app.render_context().muted()
                );
                assert!(
                    muted[(key_column, footer.hintline.y)]
                        .modifier
                        .contains(Modifier::ITALIC)
                );
                app.handle_key(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE));
                let draft = render(&app, width, 14);
                assert!(
                    !row(&draft, footer.hintline.y)
                        .replace(' ', "")
                        .contains("仪表盘")
                );
                assert_eq!(
                    row(&draft, permission_row)
                        .replace(' ', "")
                        .contains("手动"),
                    permissions
                );
            }
        }
    }
    crate::tui_assert_snapshot!("dashboard_left_footer_in_both_modes", frames.join("\n\n"));
}

#[test]
fn footer_remains_bounded_when_the_terminal_cannot_fit_both_rows() {
    for mode in [ScreenMode::Fullscreen, ScreenMode::Inline] {
        let mut app = App::new();
        let mut settings = TerminalSettings::default();
        settings.set_screen_mode(mode);
        app.update(crate::config::Event::SettingsReceived(settings));
        for height in 0..10 {
            let buffer = render(&app, 32, height);
            let footer = areas(&app, buffer.area);
            assert!(footer.statusline.bottom() <= height);
            assert!(footer.hintline.bottom() <= height);
            assert_eq!(footer.statusline.bottom(), footer.hintline.y);
            assert_eq!(footer.hintline.height, height.min(1));
            if height > 0 {
                assert!(!row(&buffer, footer.hintline.y).trim().is_empty());
            }
        }
    }
}

#[test]
fn permission_keeps_its_position_and_shows_only_the_effective_mode() {
    let mut frames = Vec::new();
    for mode in [ScreenMode::Fullscreen, ScreenMode::Inline] {
        let mut app = App::new();
        let mut settings = TerminalSettings::default();
        settings.set_screen_mode(mode);
        app.update(crate::config::Event::SettingsReceived(settings));
        app.set_current_approval_mode(Some(ash_protocol::ApprovalMode::Manual));
        app.cycle_next_approval_mode(std::time::Instant::now());
        app.cycle_next_approval_mode(std::time::Instant::now());
        assert_eq!(
            app.approval_mode(),
            ash_protocol::ApprovalMode::BypassPermissions
        );

        let running = render(&app, 80, 14);
        let footer = areas(&app, running.area);
        assert_eq!(
            row(&running, footer.hintline.y).trim(),
            "⏸ Manual · ← Dashboard · ? for shortcuts"
        );
        assert_eq!(
            running[(2, footer.hintline.y)].fg,
            app.render_context().warning()
        );
        assert!(!text(&running).contains("Bypass permissions"));
        assert!(!text(&running).contains("current:"));
        assert!(!text(&running).contains("next:"));
        frames.push(format!("{mode:?} · running\n{}", text(&running).trim_end()));

        app.set_current_approval_mode(None);
        let idle = render(&app, 80, 14);
        assert_eq!(areas(&app, idle.area), footer);
        assert_eq!(
            row(&idle, footer.hintline.y).trim(),
            "▶ Bypass permissions · ← Dashboard · ? for shortcuts"
        );
        assert_eq!(
            idle[(2, footer.hintline.y)].fg,
            app.render_context().danger()
        );
        assert!(!row(&idle, footer.statusline.y).contains("Bypass permissions"));
        frames.push(format!("{mode:?} · idle\n{}", text(&idle).trim_end()));
    }
    crate::tui_assert_snapshot!("effective_permission_in_both_modes", frames.join("\n\n"));
}
