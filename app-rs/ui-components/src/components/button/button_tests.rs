use zui::ui::{Icon, IconDefinition, IconId};

use super::{Button, ButtonBackgrounds, ButtonSelection, ButtonState, ButtonStyle};
use crate::{Border, Color, CornerRadii, Edges, FontWeight, Rect, TextStyle, UiScene};

const TEST_ICON: Icon = Icon::new(
    IconId::new("test"),
    IconDefinition::symbolic(
        br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>"#,
    ),
);

fn test_style() -> ButtonStyle {
    ButtonStyle::new(
        ButtonBackgrounds::new(Color::rgb(10, 20, 30))
            .with_hovered(Color::rgb(20, 30, 40))
            .with_focused(Color::rgb(25, 35, 45))
            .with_pressed(Color::rgb(30, 40, 50))
            .with_disabled(Color::rgb(5, 10, 15)),
        TextStyle::new(11.0, Color::rgb(80, 120, 160)).with_weight(FontWeight::Bold),
    )
    .with_selected_backgrounds(
        ButtonBackgrounds::new(Color::rgb(40, 50, 60))
            .with_hovered(Color::rgb(50, 60, 70))
            .with_focused(Color::rgb(55, 65, 75))
            .with_pressed(Color::rgb(60, 70, 80))
            .with_disabled(Color::rgb(20, 25, 30)),
    )
    .with_selected_text_style(TextStyle::new(11.0, Color::rgb(180, 190, 200)))
    .with_disabled_text_style(TextStyle::new(11.0, Color::rgb(50, 60, 70)))
    .with_border(Border::uniform(1.0, Color::WHITE))
    .with_corner_radii(CornerRadii::uniform(8.0))
    .with_padding(Edges::new(5.0, 8.0, 5.0, 10.0))
    .with_icon_size(13.0)
    .with_content_gap(6.0)
}

#[test]
fn button_projects_keyboard_focus_independently_from_pointer_hover() {
    let button = Button::new(
        Rect::from_xywh(0.0, 0.0, 100.0, 27.0),
        "Focused action",
        ButtonState::Focused,
        test_style(),
    );
    let mut scene = UiScene::new(Color::TRANSPARENT);

    scene.draw_component(&button);

    assert_eq!(scene.rects()[0].fill(), Color::rgb(25, 35, 45));
}

#[test]
fn button_selects_background_from_host_provided_state() {
    let button = Button::new(
        Rect::from_xywh(0.0, 0.0, 100.0, 27.0),
        "Action",
        ButtonState::Hovered,
        test_style(),
    );
    let mut scene = UiScene::new(Color::TRANSPARENT);

    scene.draw_component(&button);

    assert_eq!(scene.rects()[0].fill(), Color::rgb(20, 30, 40));
    assert!(scene.icons().is_empty());
    assert_eq!(scene.text_blocks()[0].text(), "Action");
    assert!(scene.text_blocks()[0].is_text_centered());
}

#[test]
fn button_style_can_keep_list_text_leading_aligned() {
    let button = Button::new(
        Rect::from_xywh(0.0, 0.0, 100.0, 27.0),
        "Leading",
        ButtonState::Resting,
        test_style().with_leading_text(),
    );
    let mut scene = UiScene::new(Color::TRANSPARENT);

    scene.draw_component(&button);

    assert!(!scene.text_blocks()[0].is_text_centered());
}

#[test]
fn button_places_a_trailing_hint_in_its_own_text_column() {
    let hint = Color::rgb(120, 121, 122);
    let button = Button::label_and_hint(
        Rect::from_xywh(20.0, 4.0, 100.0, 28.0),
        "Rename",
        "R",
        ButtonState::Resting,
        test_style()
            .with_hint_text_style(TextStyle::new(11.0, hint))
            .with_hint_width(12.0),
    );
    let mut scene = UiScene::new(Color::TRANSPARENT);

    scene.draw_component(&button);

    assert_eq!(button.accessible_label(), "Rename");
    assert_eq!(scene.text_blocks()[0].text(), "Rename");
    assert_eq!(scene.text_blocks()[1].text(), "R");
    assert_eq!(scene.text_blocks()[1].origin().x, 100.0);
    assert_eq!(scene.text_blocks()[1].style().color(), hint);
}

#[test]
fn button_places_a_trailing_icon_at_the_end_of_its_content() {
    let button = Button::label_and_trailing_icon(
        Rect::from_xywh(20.0, 4.0, 100.0, 27.0),
        "Move to group",
        TEST_ICON,
        ButtonState::Resting,
        test_style(),
    );
    let mut scene = UiScene::new(Color::TRANSPARENT);

    scene.draw_component(&button);

    assert_eq!(button.accessible_label(), "Move to group");
    assert_eq!(scene.text_blocks()[0].text(), "Move to group");
    assert_eq!(scene.text_blocks()[0].origin().x, 30.0);
    assert_eq!(
        scene.icons()[0].bounds(),
        Rect::from_xywh(99.0, 11.0, 13.0, 13.0)
    );
}

#[test]
fn button_lays_out_icon_and_label_inside_content_padding() {
    let button = Button::icon_and_label(
        Rect::from_xywh(20.0, 4.0, 100.0, 27.0),
        TEST_ICON,
        "Open files",
        ButtonState::Pressed,
        test_style(),
    );
    let mut scene = UiScene::new(Color::TRANSPARENT);

    scene.draw_component(&button);

    assert_eq!(button.bounds(), Rect::from_xywh(20.0, 4.0, 100.0, 27.0));
    assert_eq!(scene.rects()[0].fill(), Color::rgb(30, 40, 50));
    assert_eq!(
        scene.icons()[0].bounds(),
        Rect::from_xywh(30.0, 11.0, 13.0, 13.0)
    );
    assert_eq!(scene.icons()[0].color(), Color::rgb(80, 120, 160));
    assert_eq!(scene.text_blocks()[0].origin().x, 49.0);
    assert_eq!(scene.text_blocks()[0].text(), "Open files");
}

#[test]
fn button_centers_a_measured_icon_and_label_footprint() {
    let button = Button::icon_and_label(
        Rect::from_xywh(20.0, 4.0, 100.0, 27.0),
        TEST_ICON,
        "Code",
        ButtonState::Resting,
        test_style(),
    )
    .with_measured_label_size(crate::Size::new(30.0, 13.0));
    let mut scene = UiScene::new(Color::TRANSPARENT);

    scene.draw_component(&button);

    assert_eq!(scene.icons()[0].bounds().origin.x, 46.5);
    assert_eq!(scene.text_blocks()[0].origin().x, 65.5);
}

#[test]
fn button_style_derives_icon_and_label_width_from_internal_geometry() {
    assert_eq!(
        test_style().preferred_icon_and_label_width(42.0),
        10.0 + 13.0 + 6.0 + 42.0 + 8.0
    );
}

#[test]
fn button_skips_content_when_padding_consumes_bounds() {
    let style = test_style().with_padding(Edges::uniform(20.0));
    let button = Button::icon_and_label(
        Rect::from_xywh(0.0, 0.0, 24.0, 24.0),
        TEST_ICON,
        "Hidden",
        ButtonState::Resting,
        style,
    );
    let mut scene = UiScene::new(Color::TRANSPARENT);

    scene.draw_component(&button);

    assert_eq!(scene.rects().len(), 1);
    assert!(scene.icons().is_empty());
    assert!(scene.text_blocks().is_empty());
}

#[test]
fn icon_button_centers_artwork_and_retains_accessible_label() {
    let button = Button::icon(
        Rect::from_xywh(10.0, 5.0, 28.0, 28.0),
        TEST_ICON,
        "Toggle sidebar",
        ButtonState::Resting,
        test_style().with_padding(Edges::uniform(4.0)),
    );
    let mut scene = UiScene::new(Color::TRANSPARENT);

    scene.draw_component(&button);

    assert_eq!(button.accessible_label(), "Toggle sidebar");
    assert_eq!(
        scene.icons()[0].bounds(),
        Rect::from_xywh(17.5, 12.5, 13.0, 13.0)
    );
    assert!(scene.text_blocks().is_empty());
}

#[test]
fn button_projects_selected_and_disabled_presentation_independently() {
    let button = Button::new(
        Rect::from_xywh(0.0, 0.0, 100.0, 27.0),
        "Unavailable",
        ButtonState::Disabled,
        test_style(),
    )
    .with_selection(ButtonSelection::Selected);
    let mut scene = UiScene::new(Color::TRANSPARENT);

    scene.draw_component(&button);

    assert_eq!(scene.rects()[0].fill(), Color::rgb(20, 25, 30));
    assert_eq!(
        scene.text_blocks()[0].style().color(),
        Color::rgb(50, 60, 70)
    );
}

#[test]
fn button_projects_selected_text_style() {
    let button = Button::new(
        Rect::from_xywh(0.0, 0.0, 100.0, 27.0),
        "Selected",
        ButtonState::Resting,
        test_style(),
    )
    .with_selection(ButtonSelection::Selected);
    let mut scene = UiScene::new(Color::TRANSPARENT);

    scene.draw_component(&button);

    assert_eq!(
        scene.text_blocks()[0].style().color(),
        Color::rgb(180, 190, 200)
    );
}
