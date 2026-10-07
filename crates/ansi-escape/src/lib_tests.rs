use super::ansi_text;
use ratatui::style::Color;

#[test]
fn converts_sgr_color_to_ratatui_style_without_raw_escape_sequences() {
    let text = ansi_text("before \x1b[31mred\x1b[0m after");
    let line = text.lines.first().expect("one parsed line");
    let visible = line
        .spans
        .iter()
        .map(|span| span.content.as_ref())
        .collect::<String>();

    assert_eq!(visible, "before red after");
    assert!(
        line.spans
            .iter()
            .any(|span| span.content == "red" && span.style.fg == Some(Color::Red))
    );
    assert!(!visible.contains('\x1b'));
}

#[test]
fn expands_tabs_for_prefixed_transcript_output() {
    let text = ansi_text("1\tvalue");
    let visible = text.lines[0]
        .spans
        .iter()
        .map(|span| span.content.as_ref())
        .collect::<String>();

    assert_eq!(visible, "1    value");
}

#[test]
fn removes_non_sgr_terminal_control_sequences() {
    let text = ansi_text("\x1b]0;private title\x07\x1b[2Kvisible");
    let visible = text.lines[0]
        .spans
        .iter()
        .map(|span| span.content.as_ref())
        .collect::<String>();

    assert_eq!(visible, "visible");
    assert!(!visible.contains('\x1b'));
}
