use super::super::highlight::MAX_CODE_BYTES;
use super::super::highlight::MAX_CODE_LINES;
use super::super::highlight::MAX_LINE_BYTES;
use super::StreamingCodeHighlighter;
use crate::render::highlight_code;
use crate::render::test_context;

#[test]
fn appended_lines_preserve_multiline_parser_state() {
    let first = "fn main() {\n    /* comment\n";
    let appended = "       continues */\n    println!(\"界\");\n}\n";
    let context = test_context();
    let highlighter =
        StreamingCodeHighlighter::new(first, "rust", context.into(), context.theme_revision())
            .unwrap();

    let (_, lines) = highlighter
        .append(appended, context.into(), context.theme_revision())
        .unwrap();
    let complete = format!("{first}{appended}");

    assert_eq!(
        lines,
        highlight_code(&complete, "rust", context.into())
            .into_iter()
            .skip(first.lines().count())
            .collect::<Vec<_>>()
    );
}

#[test]
fn unknown_languages_keep_appending_plain_visible_lines() {
    let context = test_context();
    let highlighter = StreamingCodeHighlighter::new(
        "",
        "unknown-language",
        context.into(),
        context.theme_revision(),
    )
    .unwrap();

    let (_, lines) = highlighter
        .append("one\n\n", context.into(), context.theme_revision())
        .unwrap();

    assert_eq!(
        lines.iter().map(ToString::to_string).collect::<Vec<_>>(),
        ["one", ""]
    );
}

#[test]
fn incomplete_lines_and_theme_changes_require_a_complete_render() {
    let context = test_context();
    let highlighter = StreamingCodeHighlighter::new(
        "fn first() {}\n",
        "rust",
        context.into(),
        context.theme_revision(),
    )
    .unwrap();
    assert!(
        highlighter
            .append("fn partial()", context.into(), context.theme_revision())
            .is_none()
    );

    let highlighter = StreamingCodeHighlighter::new(
        "fn first() {}\n",
        "rust",
        context.into(),
        context.theme_revision(),
    )
    .unwrap();
    assert!(
        highlighter
            .append(
                "fn second() {}\n",
                context.into(),
                context.theme_revision() + 1,
            )
            .is_none()
    );
}

#[test]
fn crossing_each_resource_limit_requires_a_complete_render() {
    let context = test_context();
    let cases = [
        (
            String::new(),
            format!("{}\n", "x".repeat(MAX_LINE_BYTES + 1)),
        ),
        ("x\n".repeat(MAX_CODE_LINES), "x\n".to_owned()),
        (
            format!("{}\n", "x".repeat(1023)).repeat(MAX_CODE_BYTES / 1024),
            "x\n".to_owned(),
        ),
    ];
    for (initial, appended) in cases {
        let highlighter = StreamingCodeHighlighter::new(
            &initial,
            "unknown-language",
            context.into(),
            context.theme_revision(),
        )
        .unwrap();
        assert!(
            highlighter
                .append(&appended, context.into(), context.theme_revision())
                .is_none()
        );
    }
}
