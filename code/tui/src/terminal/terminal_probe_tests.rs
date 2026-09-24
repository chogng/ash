use super::osc_11_background;
use super::osc_11_response_ranges;
use super::parse_osc_11_response;
use ash_terminal_detection::TerminalRgb;

#[test]
fn parses_xterm_rgb_response_with_bel_terminator() {
    assert_eq!(
        parse_osc_11_response(b"\x1b]11;rgb:ffff/8000/0000\x07"),
        Some(TerminalRgb::new(255, 128, 0))
    );
}

#[test]
fn parses_rgb_response_with_string_terminator_and_variable_precision() {
    assert_eq!(
        parse_osc_11_response(b"prefix\x1b]11;rgb:f/8/0\x1b\\suffix"),
        Some(TerminalRgb::new(255, 136, 0))
    );
}

#[test]
fn parses_c1_osc_and_hash_rgb_responses() {
    assert_eq!(
        parse_osc_11_response(b"\x9d11;#1f2328\x07"),
        Some(TerminalRgb::new(31, 35, 40))
    );
}

#[test]
fn rejects_incomplete_or_malformed_responses() {
    assert_eq!(parse_osc_11_response(b"\x1b]11;rgb:ffff/ffff/ffff"), None);
    assert_eq!(parse_osc_11_response(b"\x1b]11;rgb:zz/00/00\x07"), None);
    assert_eq!(
        parse_osc_11_response(b"\x1b]10;rgb:ffff/ffff/ffff\x07"),
        None
    );
}

#[test]
fn finds_a_valid_background_reply_among_unrelated_input() {
    let input = b"a\x1b]10;rgb:eeee/eeee/eeee\x1b\\b\x1b]11;rgb:f5f5/f5f5/f5f5\x07c";

    assert_eq!(
        osc_11_background(input),
        Some(TerminalRgb::new(245, 245, 245))
    );
    assert_eq!(osc_11_response_ranges(input), vec![27..51]);
}

#[test]
fn leaves_osc_looking_bracketed_paste_content_alone() {
    let input = b"\x1b[200~\x1b]11;rgb:ffff/ffff/ffff\x07\x1b[201~x";

    assert_eq!(osc_11_background(input), None);
    assert!(osc_11_response_ranges(input).is_empty());
}

#[test]
fn ignores_incomplete_and_malformed_replies() {
    let input = b"\x1b]11;rgb:ffff/ffff/ffff\x1b]11;rgb:nope\x07";

    assert_eq!(osc_11_background(input), None);
    assert!(osc_11_response_ranges(input).is_empty());
}
