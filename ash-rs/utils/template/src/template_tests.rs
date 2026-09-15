use super::Template;
use super::TemplateError;
use super::TemplateParseError;
use super::TemplateRenderError;
use super::render;
use pretty_assertions::assert_eq;

#[test]
fn render_replaces_placeholders_with_and_without_whitespace() {
    let rendered = render(
        "Hello, {{ name }}. You are in {{place}}. {{ name }} is repeated.",
        [("name", "Ash"), ("place", "ash-rs")],
    )
    .unwrap();

    assert_eq!(rendered, "Hello, Ash. You are in ash-rs. Ash is repeated.");
}

#[test]
fn parsed_templates_can_be_reused() {
    let template = Template::parse("{{greeting}}, {{ name }}!").unwrap();

    assert_eq!(
        template.render([("greeting", "Hello"), ("name", "Ash")]),
        Ok("Hello, Ash!".to_string())
    );
    assert_eq!(
        template.render([("greeting", "Hi"), ("name", "builder")]),
        Ok("Hi, builder!".to_string())
    );
}

#[test]
fn placeholders_are_sorted_and_unique() {
    let template = Template::parse("{{ b }} {{ a }} {{ b }}").unwrap();

    assert_eq!(template.placeholders().collect::<Vec<_>>(), vec!["a", "b"]);
}

#[test]
fn render_supports_multiline_templates_and_adjacent_placeholders() {
    let rendered = render(
        "Line 1: {{first}}{{second}}\nLine 2: {{ third }}",
        [("first", "A"), ("second", "B"), ("third", "C")],
    )
    .unwrap();

    assert_eq!(rendered, "Line 1: AB\nLine 2: C");
}

#[test]
fn render_supports_literal_delimiter_escapes() {
    let rendered = render(
        "literal open: {{{{, literal close: }}}}, value: {{ name }}",
        [("name", "Ash")],
    )
    .unwrap();

    assert_eq!(rendered, "literal open: {{, literal close: }}, value: Ash");
}

#[test]
fn parse_errors_when_placeholder_is_empty() {
    let err = Template::parse("Hello, {{   }}.").unwrap_err();

    assert_eq!(err, TemplateParseError::EmptyPlaceholder { start: 7 });
}

#[test]
fn parse_errors_when_placeholder_is_unterminated() {
    let err = Template::parse("Hello, {{ name.").unwrap_err();

    assert_eq!(
        err,
        TemplateParseError::UnterminatedPlaceholder { start: 7 }
    );
}

#[test]
fn parse_errors_when_placeholder_is_nested() {
    let err = Template::parse("Hello, {{ outer {{ inner }} }}.").unwrap_err();

    assert_eq!(err, TemplateParseError::NestedPlaceholder { start: 7 });
}

#[test]
fn parse_errors_when_closing_delimiter_is_unmatched() {
    let err = Template::parse("Hello, }} world.").unwrap_err();

    assert_eq!(
        err,
        TemplateParseError::UnmatchedClosingDelimiter { start: 7 }
    );
}

#[test]
fn render_errors_when_placeholder_is_missing() {
    let template = Template::parse("Hello, {{ name }}.").unwrap();

    assert_eq!(
        template.render(Vec::<(&str, &str)>::new()),
        Err(TemplateRenderError::MissingValue {
            name: "name".to_string()
        })
    );
}

#[test]
fn render_errors_when_extra_value_is_provided() {
    let template = Template::parse("Hello, {{ name }}.").unwrap();

    assert_eq!(
        template.render([("name", "Ash"), ("unused", "extra")]),
        Err(TemplateRenderError::ExtraValue {
            name: "unused".to_string()
        })
    );
}

#[test]
fn render_errors_when_duplicate_value_is_provided() {
    let template = Template::parse("Hello, {{ name }}.").unwrap();

    assert_eq!(
        template.render([("name", "Ash"), ("name", "other")]),
        Err(TemplateRenderError::DuplicateValue {
            name: "name".to_string()
        })
    );
}

#[test]
fn render_function_wraps_parse_errors() {
    let err = render("Hello, }} world.", [("name", "Ash")]).unwrap_err();

    assert_eq!(
        err,
        TemplateError::Parse(TemplateParseError::UnmatchedClosingDelimiter { start: 7 })
    );
}

#[test]
fn render_function_wraps_render_errors() {
    let err = render("Hello, {{ name }}.", [("extra", "Ash")]).unwrap_err();

    assert_eq!(
        err,
        TemplateError::Render(TemplateRenderError::MissingValue {
            name: "name".to_string()
        })
    );
}
