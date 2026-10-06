use super::*;
use crate::config::Event as ConfigEvent;
use crate::config::TerminalSettings;
use crate::host::Event as HostEvent;
use crate::nls::Language;
use crate::terminal::ScreenMode;
use ash_product_update::AnnouncementContext;
use ash_product_update::AnnouncementDocument;
use ash_product_update::UpdateProduct;
use ratatui::Terminal;
use ratatui::backend::TestBackend;

fn content() -> ash_product_update::Announcement {
    let document = AnnouncementDocument::parse(
        r#"
[[announcements]]
target_app = "ashCode"
[announcements.content]
en = "A newer Ash version is available. Run ash update to upgrade."
zh-CN = "Ash 有新版本可用。运行 ash update 升级。"
"#,
    )
    .unwrap();
    document
        .select(&AnnouncementContext {
            product: UpdateProduct::AshCode,
            version: &"0.1.0".parse().unwrap(),
            os: "macos",
            date: "2026-10-05".parse().unwrap(),
        })
        .unwrap()
}

#[test]
fn announcement_wraps_in_both_modes_and_follows_language_without_changing_draft() {
    for mode in [ScreenMode::Fullscreen, ScreenMode::Inline] {
        let mut app = App::new();
        app.insert_text("Keep this draft");
        let mut settings = TerminalSettings::default();
        settings.set_screen_mode(mode);
        app.update(ConfigEvent::SettingsReceived(settings.clone()));
        let focused = app.chat_input_focused();
        app.update(HostEvent::AnnouncementReceived(content()));
        assert_eq!(app.input(), "Keep this draft");
        assert_eq!(app.chat_input_focused(), focused);
        for (language, name, expected) in [
            (
                Language::English,
                "announcement_english",
                "Announcement: A newer Ash version",
            ),
            (
                Language::Chinese,
                "announcement_chinese",
                "公告：Ash 有新版本可用。",
            ),
        ] {
            settings.set_language(language);
            app.update(ConfigEvent::SettingsReceived(settings.clone()));
            let mut terminal = Terminal::new(TestBackend::new(48, 20)).unwrap();
            terminal
                .draw(|frame| crate::app::frame::draw(frame, &app))
                .unwrap();
            let buffer = terminal.backend().buffer();
            let text = (0..buffer.area.height)
                .map(|y| {
                    let mut text = String::new();
                    let mut continuation = 0;
                    for x in 0..buffer.area.width {
                        if continuation > 0 {
                            continuation -= 1;
                            continue;
                        }
                        let symbol = buffer[(x, y)].symbol();
                        text.push_str(symbol);
                        continuation =
                            unicode_width::UnicodeWidthStr::width(symbol).saturating_sub(1);
                    }
                    text
                })
                .collect::<Vec<_>>()
                .join("\n");
            assert!(text.contains(expected), "{text}");
            assert!(text.contains("Keep this draft"));
            assert_eq!(app.input(), "Keep this draft");
            assert_eq!(app.chat_input_focused(), focused);
            assert_eq!(buffer[(2, 0)].fg, app.render_context().muted());
            let (banner, page) = split(&app, Rect::new(0, 0, 48, 20));
            assert!(banner.height > 0);
            assert_eq!(page.y, banner.bottom());
            assert_eq!(page.bottom(), 20);
            crate::tui_assert_snapshot!(app = &app; name, text);
        }
        settings.set_language(Language::Japanese);
        app.update(ConfigEvent::SettingsReceived(settings));
        assert_eq!(split(&app, Rect::new(0, 0, 48, 20)).0.height, 0);
        assert_eq!(app.announcement, Some(content()));
    }
}

#[test]
fn announcement_publication_survives_option_clones_and_restarts() {
    let source = crate::TuiAnnouncement::default();
    let options = crate::TuiOptions::new("Test").with_announcement(source.clone());
    let reconnect = options.clone();
    assert!(source.get().is_none());
    source.publish(content());
    assert_eq!(
        options.announcement.as_ref().unwrap().get(),
        Some(content())
    );
    assert_eq!(
        reconnect.announcement.as_ref().unwrap().get(),
        Some(content())
    );
}
