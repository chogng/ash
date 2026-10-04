use super::WrappedInput;
use super::wrap_input;

#[test]
fn wraps_logical_lines_and_wide_characters_on_display_boundaries() {
    assert_eq!(
        wrap_input("abcdef\n界界界", 1, 6, 7),
        WrappedInput {
            lines: vec!["abcde".into(), "f".into(), "界界".into(), "界".into()],
            byte_ranges: vec![0..5, 5..6, 7..13, 13..16],
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
            byte_ranges: vec![0..5, 5..5],
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
            byte_ranges: vec![0..2, 2..5],
            cursor_row: 1,
            cursor_column: 2,
        }
    );
}

#[test]
fn joined_emoji_and_combining_marks_wrap_on_whole_glyph_boundaries() {
    let wrapped = wrap_input("x👩‍💻z", 0, 4, 5);
    assert_eq!(wrapped.lines, ["x👩‍💻", "z"]);
    assert_eq!(wrapped.byte_ranges, [0..12, 12..13]);
    assert_eq!((wrapped.cursor_row, wrapped.cursor_column), (1, 1));
    let wrapped = wrap_input("ae\u{301}z", 0, 3, 4);
    assert_eq!(wrapped.lines, ["ae\u{301}", "z"]);
    assert_eq!(wrapped.byte_ranges, [0..4, 4..5]);
}
