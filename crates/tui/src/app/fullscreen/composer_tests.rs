use crate::app::App;
use crate::keymap::KeyEvent;
use crossterm::event::KeyCode;
use crossterm::event::KeyModifiers;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::layout::Position;
use ratatui::layout::Rect;

fn render(app: &App, width: u16) -> (Buffer, Position) {
    let mut terminal = Terminal::new(TestBackend::new(width, 20)).unwrap();
    terminal
        .draw(|frame| crate::app::frame::draw(frame, app))
        .unwrap();
    (
        terminal.backend().buffer().clone(),
        terminal.get_cursor_position().unwrap(),
    )
}

fn text(buffer: &Buffer) -> String {
    buffer
        .content
        .chunks(usize::from(buffer.area.width))
        .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn composer_keeps_its_prompt_wrapped_text_and_cursor_between_rules() {
    let mut app = App::new();
    app.insert_text("检查输入框的留白和换行位置");
    let (buffer, cursor) = render(&app, 24);
    let input = super::super::layout(&app, Rect::new(0, 0, 24, 20)).input;
    assert_eq!(input.height, 4);
    assert_eq!(buffer[(0, input.y + 1)].symbol(), " ");
    assert_eq!(buffer[(2, input.y + 1)].symbol(), ">");
    assert_eq!(buffer[(3, input.y + 1)].symbol(), " ");
    assert_eq!(buffer[(4, input.y + 1)].symbol(), "检");
    assert_eq!(buffer[(4, input.y + 2)].symbol(), "换");
    assert_eq!(cursor, Position::new(12, input.y + 2));
    assert_eq!(buffer[(2, input.y)].symbol(), "─");
    assert_eq!(buffer[(21, input.y)].symbol(), "─");
    crate::tui_assert_snapshot!(app = &app; "composer_wrapped_draft", text(&buffer));
}

#[test]
fn composer_focus_keeps_mode_color_and_changes_placeholder_without_moving_the_input() {
    let mut app = App::new();
    app.open_home();
    let area = Rect::new(0, 0, 80, 20);
    let input = super::super::layout(&app, area).input;
    let (focused, cursor) = render(&app, 80);
    assert_eq!(cursor, Position::new(4, input.y + 1));
    assert_eq!(
        focused[(2, input.y)].fg,
        app.render_context().mode_color(app.collaboration_mode())
    );
    assert!(!text(&focused).contains("Build anything"));
    app.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
    assert!(!app.chat_input_focused());
    let (blurred, _) = render(&app, 80);
    assert_eq!(super::super::layout(&app, area).input, input);
    assert_eq!(
        blurred[(2, input.y)].fg,
        app.render_context().mode_color(app.collaboration_mode())
    );
    assert_eq!(blurred[(2, input.y + 1)].symbol(), ">");
    assert_eq!(blurred[(4, input.y + 1)].symbol(), "B");
    assert_eq!(blurred[(4, input.y + 1)].fg, app.render_context().muted());
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(app.chat_input_focused());
    assert_eq!(render(&app, 80).1, cursor);
}

#[test]
fn composer_model_label_preserves_the_bottom_rule_and_right_margin() {
    let app = App::new();
    let (buffer, _) = render(&app, 80);
    let input = super::super::layout(&app, Rect::new(0, 0, 80, 20)).input;
    let labels = super::labels(&app, input, app.render_context()).unwrap();
    for x in 2..labels.model_area.x {
        assert_eq!(buffer[(x, input.bottom() - 1)].symbol(), "─");
    }
    assert_eq!(buffer[(77, input.bottom() - 1)].symbol(), " ");
    for y in input.y..input.bottom() {
        assert_eq!(buffer[(78, y)].symbol(), " ");
        assert_eq!(buffer[(79, y)].symbol(), " ");
    }
    crate::tui_assert_snapshot!(app = &app; "composer_focused", text(&buffer));
}

#[test]
fn composer_collaboration_modes_color_both_rules_prompt_and_selector() {
    use ash_protocol::CollaborationMode;
    use ratatui::style::Color;
    for (mode, expected) in [
        (
            CollaborationMode::Agent,
            crate::render::test_context().mode_color(CollaborationMode::Agent),
        ),
        (CollaborationMode::Plan, Color::Rgb(209, 134, 22)),
        (CollaborationMode::Debug, Color::Rgb(244, 135, 113)),
        (CollaborationMode::Multitask, Color::Rgb(177, 128, 215)),
        (CollaborationMode::Ask, Color::Rgb(137, 209, 133)),
    ] {
        let mut app = App::new();
        app.set_collaboration_mode(mode);
        let mut status = crate::status::StatusLineSettings::default();
        status.set(crate::status::StatusLineItem::Mode, true);
        app.update(crate::status::Event::LineSettingsReceived(status));
        let (buffer, _) = render(&app, 80);
        let input = super::super::layout(&app, Rect::new(0, 0, 80, 20)).input;
        assert_eq!(buffer[(2, input.y)].fg, expected);
        assert_eq!(buffer[(2, input.bottom() - 1)].fg, expected);
        assert_eq!(buffer[(2, input.y + 1)].fg, expected);
        let labels = super::labels(&app, input, app.render_context()).unwrap();
        assert!(labels.model_area.right() <= labels.mode_area.x);
        if mode == CollaborationMode::Agent {
            let row = text(&buffer)
                .lines()
                .nth(usize::from(input.bottom() - 1))
                .unwrap()
                .to_owned();
            assert!(row.contains(" Automatic model "));
            assert!(!row.contains("Agent"));
            assert!(!row.contains('·'));
            assert_eq!(labels.mode_area.width, 0);
            for x in input.x..input.right() {
                assert_eq!(
                    super::target_at(&app, input, Position::new(x, labels.mode_area.y)),
                    None
                );
            }
            app.open_mode_picker();
        } else {
            assert_eq!(
                buffer[(labels.mode_area.x + 1, labels.mode_area.y)].fg,
                expected
            );
            assert!(text(&buffer).contains(&format!(
                "Automatic model · {}",
                crate::thread::composer::options::mode_label(mode)
            )));
            for x in labels.mode_area.x..labels.mode_area.right() {
                assert_eq!(
                    super::target_at(&app, input, Position::new(x, labels.mode_area.y)),
                    Some(super::Target::Mode)
                );
            }
            super::activate(&mut app, super::Target::Mode);
        }
        assert_eq!(
            app.list_selection().unwrap().selected_visible_index(),
            Some(
                crate::thread::composer::options::MODES
                    .iter()
                    .position(|value| *value == mode)
                    .unwrap()
            )
        );
        app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert_eq!(app.collaboration_mode(), mode);
        assert!(app.chat_input_focused());
    }
}
