use super::Checkbox;
use super::CheckboxColors;
use super::CheckboxSelection;
use super::CheckboxStateColors;
use super::CheckboxStyle;
use super::ToggleState;
use crate::Color;
use crate::Component;
use crate::Rect;
use crate::UiScene;
use zui::ui::Icon;
use zui::ui::IconDefinition;
use zui::ui::IconId;

const CHECKED_ICON: Icon = Icon::new(
    IconId::new("checkbox-checked"),
    IconDefinition::symbolic(
        br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="m3 8 3 3 7-7"/></svg>"#,
    ),
);
const MIXED_ICON: Icon = Icon::new(
    IconId::new("checkbox-mixed"),
    IconDefinition::symbolic(
        br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M3 8h10"/></svg>"#,
    ),
);

fn style() -> CheckboxStyle {
    let unchecked = CheckboxStateColors::new(CheckboxColors::new(
        Color::TRANSPARENT,
        Color::rgb(90, 90, 90),
        Color::TRANSPARENT,
    ));
    let selected = CheckboxStateColors::new(CheckboxColors::new(
        Color::rgb(0, 120, 212),
        Color::rgb(0, 120, 212),
        Color::WHITE,
    ))
    .with_disabled(CheckboxColors::new(
        Color::rgb(70, 70, 70),
        Color::rgb(70, 70, 70),
        Color::rgb(150, 150, 150),
    ));
    CheckboxStyle::new(unchecked, selected, selected, CHECKED_ICON, MIXED_ICON)
}

#[test]
fn checkbox_centers_box_and_paints_checked_icon() {
    let checkbox = Checkbox::new(
        Rect::from_xywh(10.0, 20.0, 40.0, 30.0),
        CheckboxSelection::Checked,
        ToggleState::Resting,
        style(),
    );
    let mut scene = UiScene::new(Color::TRANSPARENT);

    checkbox.paint(&mut scene);

    assert_eq!(
        checkbox.box_bounds(),
        Rect::from_xywh(21.0, 26.0, 18.0, 18.0)
    );
    assert_eq!(scene.rects()[0].fill(), Color::rgb(0, 120, 212));
    assert_eq!(scene.icons()[0].icon(), CHECKED_ICON);
    assert_eq!(scene.icons()[0].bounds(), checkbox.mark_bounds());
}

#[test]
fn mixed_and_unchecked_selections_have_distinct_artwork() {
    let bounds = Rect::from_xywh(0.0, 0.0, 24.0, 24.0);
    let mut unchecked_scene = UiScene::new(Color::TRANSPARENT);
    Checkbox::new(
        bounds,
        CheckboxSelection::Unchecked,
        ToggleState::Resting,
        style(),
    )
    .paint(&mut unchecked_scene);
    assert!(unchecked_scene.icons().is_empty());

    let mut mixed_scene = UiScene::new(Color::TRANSPARENT);
    Checkbox::new(
        bounds,
        CheckboxSelection::Mixed,
        ToggleState::Disabled,
        style(),
    )
    .paint(&mut mixed_scene);
    assert_eq!(mixed_scene.icons()[0].icon(), MIXED_ICON);
    assert_eq!(mixed_scene.icons()[0].color(), Color::rgb(150, 150, 150));
}
