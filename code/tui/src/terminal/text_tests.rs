use super::ScreenSelectionRange;
use super::line_range_at;
use super::text_in_range;
use super::token_range_at;
use ratatui::buffer::Buffer;
use ratatui::layout::Position;
use ratatui::layout::Rect;
use ratatui::style::Style;

#[test]
fn selected_screen_text_trims_row_padding_and_preserves_line_boundaries() {
    let mut buffer = Buffer::empty(Rect::new(0, 0, 8, 3));
    buffer.set_string(0, 0, "alpha", Style::default());
    buffer.set_string(0, 1, "  beta", Style::default());
    buffer.set_string(0, 2, "gamma", Style::default());

    assert_eq!(
        text_in_range(
            &buffer,
            ScreenSelectionRange::new(Position::new(2, 0), Position::new(3, 2))
        ),
        Some("pha\n  beta\ngamm".into())
    );
}

#[test]
fn selected_screen_text_does_not_copy_wide_character_continuation_cells() {
    let mut buffer = Buffer::empty(Rect::new(0, 0, 8, 1));
    buffer.set_string(0, 0, "你 ok", Style::default());

    assert_eq!(
        text_in_range(
            &buffer,
            ScreenSelectionRange::new(Position::new(0, 0), Position::new(4, 0))
        ),
        Some("你 ok".into())
    );
}

#[test]
fn token_selection_distinguishes_words_spaces_symbols_and_wide_characters() {
    let mut buffer = Buffer::empty(Rect::new(0, 0, 24, 1));
    buffer.set_string(0, 0, "alpha  beta::你好吗", Style::default());

    assert_eq!(selected_token(&buffer, 2), Some("alpha".into()));
    assert_eq!(selected_token(&buffer, 5), Some("  ".into()));
    assert_eq!(selected_token(&buffer, 11), Some("::".into()));
    assert_eq!(selected_token(&buffer, 14), Some("你好吗".into()));
}

#[test]
fn line_selection_uses_the_visual_row_and_trims_terminal_padding() {
    let mut buffer = Buffer::empty(Rect::new(0, 0, 12, 2));
    buffer.set_string(0, 1, "  alpha", Style::default());

    let range = line_range_at(&buffer, Position::new(4, 1)).unwrap();

    assert_eq!(text_in_range(&buffer, range), Some("  alpha".into()));
}

fn selected_token(buffer: &Buffer, column: u16) -> Option<String> {
    token_range_at(buffer, Position::new(column, 0)).and_then(|range| text_in_range(buffer, range))
}
