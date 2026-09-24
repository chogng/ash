use super::Radio;
use super::RadioGroup;
use super::RadioGroupOrientation;
use super::RadioGroupStyle;
use super::RadioSelection;
use crate::ButtonBackgrounds;
use crate::ButtonState;
use crate::ButtonStyle;
use crate::Color;
use crate::CornerRadii;
use crate::Edges;
use crate::Rect;
use crate::Size;
use crate::TextStyle;
use crate::UiScene;
use zui::ui::Icon;
use zui::ui::IconDefinition;
use zui::ui::IconId;

const TEST_ICON: Icon = Icon::new(
    IconId::new("mode"),
    IconDefinition::symbolic(
        br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M2 8h12"/></svg>"#,
    ),
);

fn test_style() -> RadioGroupStyle {
    RadioGroupStyle::new(
        ButtonStyle::new(
            ButtonBackgrounds::new(Color::TRANSPARENT).with_hovered(Color::rgb(220, 221, 222)),
            TextStyle::new(13.0, Color::rgb(30, 31, 32)),
        )
        .with_selected_backgrounds(ButtonBackgrounds::new(Color::WHITE))
        .with_corner_radii(CornerRadii::uniform(6.0))
        .with_padding(Edges::new(5.0, 8.0, 5.0, 8.0)),
        Size::new(98.0, 28.0),
    )
    .with_gap(4.0)
}

#[test]
fn radio_group_arranges_one_selected_button_surface() {
    let group = RadioGroup::new(
        Rect::from_xywh(10.0, 8.0, 200.0, 28.0),
        RadioGroupOrientation::Horizontal,
        vec![
            Radio::new("Cowork", ButtonState::Hovered),
            Radio::new("Code", ButtonState::Resting).with_selection(RadioSelection::Selected),
        ],
        test_style(),
    );
    let mut scene = UiScene::new(Color::TRANSPARENT);

    scene.draw_component(&group);

    assert_eq!(group.selected_index(), Some(1));
    assert_eq!(
        group.radio_bounds(0),
        Some(Rect::from_xywh(10.0, 8.0, 98.0, 28.0))
    );
    assert_eq!(
        group.radio_bounds(1),
        Some(Rect::from_xywh(112.0, 8.0, 98.0, 28.0))
    );
    assert_eq!(scene.rects()[0].fill(), Color::rgb(220, 221, 222));
    assert_eq!(scene.rects()[1].fill(), Color::WHITE);
    assert_eq!(scene.text_blocks()[0].text(), "Cowork");
    assert_eq!(scene.text_blocks()[1].text(), "Code");
    assert_eq!(
        scene
            .inspection()
            .nodes()
            .iter()
            .map(|node| node.name())
            .collect::<Vec<_>>(),
        ["RadioGroup", "Radio", "Radio", "Button", "Button"]
    );
}

#[test]
#[should_panic(expected = "RadioGroup cannot contain multiple selected radios")]
fn radio_group_rejects_multiple_selected_buttons() {
    RadioGroup::new(
        Rect::from_xywh(0.0, 0.0, 200.0, 28.0),
        RadioGroupOrientation::Horizontal,
        vec![
            Radio::new("First", ButtonState::Resting).with_selection(RadioSelection::Selected),
            Radio::new("Second", ButtonState::Resting).with_selection(RadioSelection::Selected),
        ],
        test_style(),
    );
}

#[test]
fn vertical_radio_group_uses_the_same_button_basis() {
    let group = RadioGroup::new(
        Rect::from_xywh(0.0, 0.0, 98.0, 60.0),
        RadioGroupOrientation::Vertical,
        vec![
            Radio::new("First", ButtonState::Resting),
            Radio::new("Second", ButtonState::Resting),
        ],
        test_style(),
    );

    assert_eq!(
        group.radio_bounds(0),
        Some(Rect::from_xywh(0.0, 0.0, 98.0, 28.0))
    );
    assert_eq!(
        group.radio_bounds(1),
        Some(Rect::from_xywh(0.0, 32.0, 98.0, 28.0))
    );
}

#[test]
fn radio_projects_icon_and_centered_content_to_its_button() {
    let group = RadioGroup::new(
        Rect::from_xywh(10.0, 8.0, 98.0, 28.0),
        RadioGroupOrientation::Horizontal,
        vec![
            Radio::new("Code", ButtonState::Resting)
                .with_icon(TEST_ICON)
                .with_measured_label_size(Size::new(28.0, 13.0)),
        ],
        test_style(),
    );
    let mut scene = UiScene::new(Color::TRANSPARENT);

    scene.draw_component(&group);

    assert_eq!(scene.icons()[0].icon(), TEST_ICON);
    assert_eq!(scene.icons()[0].bounds().origin.x, 34.0);
    assert_eq!(scene.text_blocks()[0].origin().x, 56.0);
}
