use super::{InputBox, InputBoxState, InputBoxStateColors, InputBoxStyle};
use crate::{
    CaretVisibility, Color, Component, CornerRadii, Edges, Rect, TextInput, TextInputCommand,
    TextInputCompositionCursor, TextInputCompositionEvent, TextInputLayoutEngine, TextStyle,
    UiScene,
};

fn test_style() -> InputBoxStyle {
    InputBoxStyle::new(
        InputBoxStateColors::new(
            Color::rgb(20, 20, 20),
            Color::rgb(25, 25, 25),
            Color::rgb(30, 30, 30),
        ),
        InputBoxStateColors::new(
            Color::rgb(70, 70, 70),
            Color::rgb(80, 80, 80),
            Color::rgb(90, 130, 180),
        ),
        TextStyle::new(14.0, Color::WHITE).with_line_height(18.0),
        TextStyle::new(14.0, Color::rgb(120, 120, 120)).with_line_height(18.0),
    )
    .with_corner_radii(CornerRadii::uniform(6.0))
    .with_padding(Edges::new(4.0, 8.0, 4.0, 8.0))
    .with_caret_width(1.5)
}

#[test]
fn empty_focused_input_paints_placeholder_and_caret() {
    let bounds = Rect::from_xywh(10.0, 20.0, 180.0, 32.0);
    let style = test_style();
    let mut engine = TextInputLayoutEngine::new();
    let text_input = TextInput::new();
    let input = InputBox::new(
        bounds,
        "Ask Ash",
        InputBoxState::Focused(CaretVisibility::Visible),
        style,
        &text_input,
        &mut engine,
    );
    let mut scene = UiScene::new(Color::TRANSPARENT);

    input.paint(&mut scene);

    assert_eq!(scene.rects().len(), 2);
    assert_eq!(scene.text_blocks()[0].text(), "Ask Ash");
    assert_eq!(input.caret_bounds().unwrap().origin.x, 18.0);
}

#[test]
fn input_box_paints_preedit_without_committing_text() {
    let bounds = Rect::from_xywh(0.0, 0.0, 240.0, 34.0);
    let style = test_style();
    let mut text_input = TextInput::new();
    text_input.apply(TextInputCommand::Insert("hello!".to_owned()));
    text_input.apply(TextInputCommand::SelectAll);
    text_input.apply_composition(TextInputCompositionEvent::Preedit {
        text: "世界".to_owned(),
        cursor: TextInputCompositionCursor::Visible(3..3),
    });
    let mut engine = TextInputLayoutEngine::new();
    let input = InputBox::new(
        bounds,
        "",
        InputBoxState::Focused(CaretVisibility::Visible),
        style,
        &text_input,
        &mut engine,
    );
    let mut scene = UiScene::new(Color::TRANSPARENT);

    input.paint(&mut scene);

    assert_eq!(text_input.text(), "hello!");
    assert_eq!(scene.text_blocks()[0].text(), "世界");
    assert!(scene.rects().len() >= 3);
    assert!(input.caret_bounds().is_some());
}

#[test]
fn hidden_preedit_cursor_does_not_paint_a_caret() {
    let bounds = Rect::from_xywh(0.0, 0.0, 180.0, 32.0);
    let style = test_style();
    let mut text_input = TextInput::new();
    text_input.apply(TextInputCommand::Insert("a".to_owned()));
    text_input.apply_composition(TextInputCompositionEvent::Preedit {
        text: "b".to_owned(),
        cursor: TextInputCompositionCursor::Hidden,
    });
    let mut engine = TextInputLayoutEngine::new();
    let input = InputBox::new(
        bounds,
        "",
        InputBoxState::Focused(CaretVisibility::Visible),
        style,
        &text_input,
        &mut engine,
    );

    assert_eq!(text_input.text(), "a");
    assert_eq!(input.caret_bounds(), None);
}

#[test]
fn hidden_blink_phase_keeps_focused_chrome_without_painting_the_caret() {
    let bounds = Rect::from_xywh(10.0, 20.0, 180.0, 32.0);
    let mut engine = TextInputLayoutEngine::new();
    let input = InputBox::new(
        bounds,
        "",
        InputBoxState::Focused(CaretVisibility::Hidden),
        test_style(),
        &TextInput::new(),
        &mut engine,
    );
    let mut scene = UiScene::new(Color::TRANSPARENT);

    input.paint(&mut scene);

    assert_eq!(scene.rects().len(), 1);
    assert!(input.caret_bounds().is_some());
}

#[test]
fn active_selection_hides_the_blinking_caret() {
    let bounds = Rect::from_xywh(10.0, 20.0, 180.0, 32.0);
    let mut text_input = TextInput::new();
    text_input.apply(TextInputCommand::Insert("selected".to_owned()));
    text_input.apply(TextInputCommand::SelectAll);
    let mut engine = TextInputLayoutEngine::new();
    let input = InputBox::new(
        bounds,
        "",
        InputBoxState::Focused(CaretVisibility::Visible),
        test_style(),
        &text_input,
        &mut engine,
    );
    let mut scene = UiScene::new(Color::TRANSPARENT);

    input.paint(&mut scene);

    assert_eq!(scene.rects().len(), 2);
    assert_eq!(
        scene.rects()[1].bounds(),
        input.layout.selection_bounds()[0]
    );
}
