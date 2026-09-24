use super::WrappedInput;
use super::wrap_input;

#[test]
fn wraps_logical_lines_and_wide_characters_on_display_boundaries() {
    assert_eq!(
        wrap_input("abcdef\n界界界", 1, 6, 7),
        WrappedInput {
            lines: vec!["abcde".into(), "f".into(), "界界".into(), "界".into()],
            cursor_row: 3,
            cursor_column: 2,
        }
    );
}

#[test]
fn exact_boundary_cursor_uses_a_visible_continuation_row() {
    assert_eq!(
        wrap_input("abcde", 0, 5, 7),
        WrappedInput {
            lines: vec!["abcde".into(), String::new()],
            cursor_row: 1,
            cursor_column: 0,
        }
    );
}

#[test]
fn wide_character_moves_whole_to_the_next_visual_row() {
    assert_eq!(
        wrap_input("aa界", 0, 4, 5),
        WrappedInput {
            lines: vec!["aa".into(), "界".into()],
            cursor_row: 1,
            cursor_column: 2,
        }
    );
}
