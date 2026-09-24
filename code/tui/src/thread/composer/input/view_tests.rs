use super::ChatInputChrome;
use super::ChatInputCursor;
use super::ChatInputFocus;
use crate::render::test_context;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::layout::Rect;

fn border(focus: ChatInputFocus) -> ratatui::style::Color {
    let area = Rect::new(0, 0, 40, 4);
    let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
    terminal
        .draw(|frame| {
            super::draw(
                frame,
                area,
                "",
                0,
                0,
                "> ",
                ChatInputCursor::Hidden,
                focus,
                ChatInputChrome::Box,
                None,
                test_context(),
            )
        })
        .unwrap();
    let x = super::content_area(area).x;
    terminal.backend().buffer()[(x, area.y)].fg
}

#[test]
fn input_border_distinguishes_focus_from_rest() {
    assert_eq!(
        border(ChatInputFocus::Focused),
        test_context().chat_input_chrome()
    );
    assert_eq!(border(ChatInputFocus::Blurred), test_context().border());
}

#[test]
fn argument_hint_renders_after_cursor_with_muted_style() {
    let area = Rect::new(0, 0, 40, 4);
    let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
    terminal
        .draw(|frame| {
            super::draw(
                frame,
                area,
                "/cd ",
                4,
                0,
                "> ",
                ChatInputCursor::Visible,
                ChatInputFocus::Focused,
                ChatInputChrome::Rules,
                Some("<path>"),
                test_context(),
            )
        })
        .unwrap();

    let buffer = terminal.backend().buffer();
    let text_y = area.y + 1;
    assert_eq!(buffer[(area.x + 6, text_y)].symbol(), "<");
    assert_eq!(buffer[(area.x + 6, text_y)].fg, test_context().muted());
    assert_eq!(buffer[(area.x + 7, text_y)].symbol(), "p");
    assert_eq!(buffer[(area.x + 7, text_y)].fg, test_context().muted());
}
