use super::line_to_borrowed;
use super::line_to_static;
use super::prefix_lines;
use super::push_owned_lines;
use super::styled_text_lines;
use super::wrapped_height;
use ratatui::layout::Alignment;
use ratatui::style::Color;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;

#[test]
fn line_conversions_preserve_style_and_alignment() {
    let source = Line::from(vec![
        Span::styled("hello", Style::default().fg(Color::Green)),
        Span::raw(String::from(" world")),
    ])
    .style(Style::default().bg(Color::Black))
    .alignment(Alignment::Center);

    let borrowed = line_to_borrowed(&source);
    let owned = line_to_static(&source);

    assert_eq!(borrowed, source);
    assert_eq!(owned, source);
}

#[test]
fn owned_line_copy_appends_without_losing_formatting() {
    let source = vec![Line::from(Span::styled(
        "copied",
        Style::default().fg(Color::Cyan),
    ))];
    let mut output = vec![Line::from("existing")];

    push_owned_lines(&source, &mut output);

    assert_eq!(output.len(), 2);
    assert_eq!(output[1], source[0]);
}

#[test]
fn prefixes_distinguish_the_first_and_following_lines() {
    let lines = vec![Line::from("one"), Line::from("two")];

    let lines = prefix_lines(lines, Span::raw("└─ "), Span::raw("   "));

    assert_eq!(lines[0].to_string(), "└─ one");
    assert_eq!(lines[1].to_string(), "   two");
}

#[test]
fn styled_lines_preserve_explicit_empty_lines_and_crlf() {
    let lines = styled_text_lines("one\r\n\ntwo\n", Style::default());

    assert_eq!(
        lines.iter().map(Line::to_string).collect::<Vec<_>>(),
        ["one", "", "two", ""]
    );
}

#[test]
fn wrapped_height_uses_ratatui_word_wrapping() {
    let lines = styled_text_lines("hello world", Style::default());

    assert_eq!(wrapped_height(&lines, 20), 1);
    assert_eq!(wrapped_height(&lines, 5), 2);
    assert_eq!(wrapped_height(&lines, 0), 0);
}
