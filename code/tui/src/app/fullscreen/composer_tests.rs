use crate::app::App;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
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
fn composer_keeps_its_prompt_wrapped_text_and_cursor_inside_the_border() {
    let mut app = App::new();
    app.insert_text("检查输入框的留白和换行位置");
    let (buffer, cursor) = render(&app, 24);
    let input = super::super::layout(&app, Rect::new(0, 0, 24, 20)).input;
    assert_eq!(input.height, 4);
    assert_eq!(buffer[(0, input.y + 1)].symbol(), " ");
    assert_eq!(buffer[(2, input.y + 1)].symbol(), "│");
    assert_eq!(buffer[(3, input.y + 1)].symbol(), " ");
    assert_eq!(buffer[(4, input.y + 1)].symbol(), ">");
    assert_eq!(buffer[(5, input.y + 1)].symbol(), " ");
    assert_eq!(buffer[(6, input.y + 1)].symbol(), "检");
    assert_eq!(buffer[(4, input.y + 2)].symbol(), " ");
    assert_eq!(buffer[(6, input.y + 2)].symbol(), "白");
    assert_eq!(buffer[(20, input.y + 1)].symbol(), " ");
    assert_eq!(buffer[(21, input.y + 1)].symbol(), "│");
    assert_eq!(cursor, Position::new(18, input.y + 2));
    assert_eq!(buffer[(21, input.bottom() - 1)].symbol(), "╯");
    crate::tui_assert_snapshot!("composer_wrapped_draft", text(&buffer));
}

#[test]
fn composer_focus_changes_border_and_placeholder_without_moving_the_input() {
    let mut app = App::new();
    app.open_home();
    let area = Rect::new(0, 0, 80, 20);
    let input = super::super::layout(&app, area).input;
    let (focused, cursor) = render(&app, 80);
    assert_eq!(cursor, Position::new(6, input.y + 1));
    assert_eq!(
        focused[(2, input.y)].fg,
        app.render_context().chat_input_chrome()
    );
    assert!(!text(&focused).contains("Build anything"));
    app.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
    assert!(!app.chat_input_focused());
    let (blurred, _) = render(&app, 80);
    assert_eq!(super::super::layout(&app, area).input, input);
    assert_eq!(blurred[(2, input.y)].fg, app.render_context().border());
    assert_eq!(blurred[(4, input.y + 1)].symbol(), ">");
    assert_eq!(blurred[(6, input.y + 1)].symbol(), "B");
    assert_eq!(blurred[(6, input.y + 1)].fg, app.render_context().muted());
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(app.chat_input_focused());
    assert_eq!(render(&app, 80).1, cursor);
}

#[test]
fn composer_model_label_preserves_the_bottom_rule_and_right_margin() {
    let app = App::new();
    let (buffer, _) = render(&app, 80);
    let input = super::super::layout(&app, Rect::new(0, 0, 80, 20)).input;
    for x in 3..58 {
        assert_eq!(buffer[(x, input.bottom() - 1)].symbol(), "─");
    }
    assert_eq!(buffer[(76, input.bottom() - 1)].symbol(), "─");
    assert_eq!(buffer[(77, input.bottom() - 1)].symbol(), "╯");
    for y in input.y..input.bottom() {
        assert_eq!(buffer[(78, y)].symbol(), " ");
        assert_eq!(buffer[(79, y)].symbol(), " ");
    }
    crate::tui_assert_snapshot!("composer_focused", text(&buffer));
}
