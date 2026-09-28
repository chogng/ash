use super::ChatInputCursor;
use super::ChatInputFocus;
use crate::render::test_context;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::layout::Position;
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
                None,
                None,
                "> ",
                ChatInputCursor::Hidden,
                focus,
                None,
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
                None,
                None,
                "> ",
                ChatInputCursor::Visible,
                ChatInputFocus::Focused,
                None,
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

#[test]
fn pointer_positions_follow_rules_wide_characters_and_wrapping() {
    let area = Rect::new(0, 0, 8, 4);
    let hit = |column, row| {
        super::cursor_at(area, "ab你cdef", 0, 8, None, Position::new(column, row)).byte
    };

    assert_eq!(hit(2, 1), 0);
    assert_eq!(hit(4, 1), 2);
    assert_eq!(hit(5, 1), 5);
    assert_eq!(hit(2, 2), 7);
    assert_eq!(hit(3, 2), 8);
    assert_eq!(hit(7, 2), 9);
    let wide = super::cursor_at(area, "ab你cdef", 0, 8, None, Position::new(5, 1));
    assert_eq!(wide.byte, 5);
    assert_eq!(wide.glyph_byte, Some(2));
    assert_eq!((wide.row_start, wide.row_end), (0, 7));
    assert_eq!(
        super::cursor_at(area, "ab你cdef", 0, 8, None, Position::new(1, 1),).glyph_byte,
        None
    );
    assert_eq!(
        super::cursor_at(area, "ab你cdef", 0, 8, None, Position::new(7, 2),).glyph_byte,
        None
    );
}
