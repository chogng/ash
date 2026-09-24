use super::{TextInputLayoutEngine, TextInputLayoutStyle};
use crate::{
    Color, Rect, TextInput, TextInputCommand, TextInputCompositionCursor,
    TextInputCompositionEvent, TextStyle,
};

fn test_style() -> TextInputLayoutStyle {
    TextInputLayoutStyle::new(TextStyle::new(14.0, Color::WHITE).with_line_height(18.0))
        .with_caret_width(1.5)
}

#[test]
fn shaped_selection_uses_the_same_text_metrics_as_the_caret() {
    let mut input = TextInput::new();
    input.apply(TextInputCommand::Insert("hello".to_owned()));
    input.apply(TextInputCommand::SelectAll);
    let mut engine = TextInputLayoutEngine::new();
    let layout = engine.layout(
        Rect::from_xywh(8.0, 4.0, 220.0, 24.0),
        &input,
        &test_style(),
    );

    assert_eq!(layout.text(), "hello");
    assert!(!layout.selection_bounds().is_empty());
    assert!(layout.caret_bounds().unwrap().origin.x > layout.text_origin().x);
}

#[test]
fn preedit_temporarily_replaces_selection_without_mutating_input() {
    let mut input = TextInput::new();
    input.apply(TextInputCommand::Insert("hello!".to_owned()));
    input.apply(TextInputCommand::SelectAll);
    input.apply_composition(TextInputCompositionEvent::Preedit {
        text: "世界".to_owned(),
        cursor: TextInputCompositionCursor::Visible(3..3),
    });
    let mut engine = TextInputLayoutEngine::new();
    let layout = engine.layout(
        Rect::from_xywh(8.0, 4.0, 220.0, 24.0),
        &input,
        &test_style(),
    );

    assert_eq!(input.text(), "hello!");
    assert_eq!(layout.text(), "世界");
    assert!(layout.selection_bounds().is_empty());
    assert!(!layout.preedit_underline_bounds().is_empty());
}

#[test]
fn text_measurement_uses_shaped_content_instead_of_character_slots() {
    let mut engine = TextInputLayoutEngine::new();
    let style = TextStyle::new(14.0, Color::WHITE).with_line_height(18.0);

    let short = engine.measure_text("main", &style);
    let long = engine.measure_text("feature/content-width", &style);
    let multilingual = engine.measure_text("工作目录", &style);

    assert!(long.width > short.width);
    assert!(multilingual.width > 0.0);
    assert_eq!(short.height, 18.0);
}
