use super::resolve_command_output;
use std::borrow::Cow;

#[test]
fn command_output_resolves_only_the_visible_redrawn_row() {
    assert!(matches!(
        resolve_command_output("abc\r\ndef", 80),
        Cow::Borrowed(_)
    ));
    assert_eq!(resolve_command_output("longer\rshort\n", 80), "shortr\n");
    assert_eq!(resolve_command_output("old\r\x1b[Knew\r\n", 80), "new\n");
    assert_eq!(resolve_command_output("old\r\x1b[2K更新", 80), "更新");
    assert_eq!(resolve_command_output("界tail\rx", 80), "x tail");
    assert_eq!(resolve_command_output("abcdefghijk\rfinish", 6), "finish");
}

#[test]
fn command_output_keeps_the_styles_of_surviving_cells() {
    assert_eq!(
        resolve_command_output("\x1b[31mabcdef\r\x1b[32mxy", 80),
        "\x1b[0;38;5;2mxy\x1b[0;38;5;1mcdef\x1b[0;38;5;2m\x1b[0m"
    );
}

#[test]
fn redrawn_rows_follow_styles_across_line_boundaries() {
    assert_eq!(
        resolve_command_output("\x1b[2mheading\nold\r\x1b[2Knew\nend", 80),
        "\x1b[2mheading\nnew\nend\x1b[0m"
    );
}
