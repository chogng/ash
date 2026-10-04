use crate::app::App;
use crate::config::KeyHintStyle;
use crate::config::TerminalSettings;
use crate::nls::Language;
use crate::status::StatusLineItem;
use crate::status::StatusLineSettings;
use crate::terminal::ScreenMode;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
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
                let prefix = match mode {
                    ScreenMode::Fullscreen => "  Enter 发送",
                    ScreenMode::Inline if permissions => "  ⏸ 手动 · ← 仪表盘",
                    ScreenMode::Inline => "  ← 仪表盘",
                };
                assert!(
                    hints.replace(' ', "").starts_with(&prefix.replace(' ', "")),
                    "{mode:?}: {hints}"
                );
                let permission_row = match mode {
                    ScreenMode::Fullscreen => footer.statusline.y,
                    ScreenMode::Inline => footer.hintline.y,
                };
                assert_eq!(
                    row(&buffer, permission_row)
                        .replace(' ', "")
                        .contains("手动"),
                    permissions
                );
                let key_column = (2..width)
                    .find(|&x| buffer[(x, footer.hintline.y)].symbol() == "←")
                    .unwrap();
                if mode == ScreenMode::Inline {
                    assert_eq!(key_column, if permissions { 11 } else { 2 });
                }
                let key = &buffer[(key_column, footer.hintline.y)];
                assert_eq!(key.fg, app.render_context().foreground());
                assert!(key.modifier.contains(Modifier::BOLD));
                frames.push(format!(
                    "{mode:?} · width={width} · permissions={permissions}\n{}",
                    text(&buffer)
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
