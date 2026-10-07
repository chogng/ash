use super::MAX_CODE_BYTES;
use super::highlight_code;
use crate::render::test_context;
use ratatui::text::Line;

#[test]
fn rust_highlighting_preserves_text_and_uses_render_theme_tokens() {
    let lines = highlight_code(
        "fn greet(name: &str) { println!(\"hello {name}\"); }",
        "rust",
        test_context().into(),
    );

    assert_eq!(
        lines.iter().map(Line::to_string).collect::<Vec<_>>(),
        ["fn greet(name: &str) { println!(\"hello {name}\"); }"]
    );
    assert!(
        lines[0]
            .spans
            .iter()
            .any(|span| span.content == "fn" && span.style.fg == Some(test_context().keyword()))
    );
    assert!(lines[0].spans.iter().any(|span| {
        span.content.contains("hello") && span.style.fg == Some(test_context().string())
    }));
}

#[test]
fn multiline_parser_state_is_preserved() {
    let lines = highlight_code(
        "/* one\n   two */\nlet value = 1;",
        "rust",
        test_context().into(),
    );

    assert_eq!(lines.len(), 3);
    assert_eq!(lines[1].to_string(), "   two */");
    assert!(
        lines[1]
            .spans
            .iter()
            .all(|span| span.style.fg == Some(test_context().muted()))
    );
}

#[test]
fn unknown_languages_and_oversized_code_remain_visible() {
    let unknown = highlight_code("hello", "not-a-language", test_context().into());
    let oversized = highlight_code(
        &"x".repeat(MAX_CODE_BYTES + 1),
        "rust",
        test_context().into(),
    );

    assert_eq!(unknown[0].to_string(), "hello");
    assert_eq!(
        unknown[0].spans[0].style.fg,
        Some(test_context().foreground())
    );
    assert_eq!(oversized[0].to_string().len(), MAX_CODE_BYTES + 1);
}

#[test]
fn crlf_content_is_preserved_without_an_extra_terminal_row() {
    let lines = highlight_code(
        "let one = 1;\r\nlet two = 2;\r\n",
        "rs",
        test_context().into(),
    );

    assert_eq!(
        lines.iter().map(Line::to_string).collect::<Vec<_>>(),
        ["let one = 1;", "let two = 2;"]
    );
}
