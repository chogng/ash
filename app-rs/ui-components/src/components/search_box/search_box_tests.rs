use super::{SearchBox, SearchBoxStyle};
use crate::{
    CaretVisibility, Color, Component, InputBoxState, InputBoxStateColors, InputBoxStyle, Rect,
    TextInput, TextInputLayoutEngine, TextStyle, UiScene,
};
use zui::ui::{Icon, IconDefinition, IconId};

const TEST_ICON: Icon = Icon::new(
    IconId::new("search"),
    IconDefinition::symbolic(
        br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="7" cy="7" r="5"/><path d="m10.5 10.5 4 4"/></svg>"#,
    ),
);

#[test]
fn search_box_reuses_input_box_chrome_and_reserves_leading_icon_space() {
    let input_style = InputBoxStyle::new(
        InputBoxStateColors::new(Color::WHITE, Color::WHITE, Color::WHITE),
        InputBoxStateColors::new(
            Color::rgb(210, 210, 210),
            Color::rgb(210, 210, 210),
            Color::rgb(40, 110, 180),
        ),
        TextStyle::new(12.0, Color::rgb(0, 0, 0)),
        TextStyle::new(12.0, Color::rgb(120, 120, 120)),
    );
    let bounds = Rect::from_xywh(10.0, 20.0, 160.0, 28.0);
    let mut engine = TextInputLayoutEngine::new();
    let search_box = SearchBox::new(
        bounds,
        "Search sessions...",
        InputBoxState::Focused(CaretVisibility::Visible),
        SearchBoxStyle::new(input_style, TEST_ICON, Color::rgb(90, 90, 90)),
        &TextInput::new(),
        &mut engine,
    );
    let mut scene = UiScene::new(Color::TRANSPARENT);

    search_box.paint(&mut scene);

    assert_eq!(scene.rects()[0].bounds(), bounds);
    assert_eq!(scene.icons()[0].icon(), TEST_ICON);
    assert_eq!(
        scene.icons()[0].bounds(),
        Rect::from_xywh(18.0, 27.0, 14.0, 14.0)
    );
    assert_eq!(scene.text_blocks()[0].text(), "Search sessions...");
    assert_eq!(search_box.caret_bounds().unwrap().origin.x, 38.0);
}
