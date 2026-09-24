use super::Switch;
use super::SwitchColors;
use super::SwitchSelection;
use super::SwitchStateColors;
use super::SwitchStyle;
use super::ToggleState;
use crate::Border;
use crate::Color;
use crate::CornerRadii;
use crate::Rect;
use crate::Size;
use crate::UiScene;

fn test_style() -> SwitchStyle {
    let off = SwitchStateColors::new(SwitchColors::new(
        Color::rgb(30, 30, 30),
        Color::rgb(220, 220, 220),
    ))
    .with_hovered(SwitchColors::new(
        Color::rgb(40, 40, 40),
        Color::rgb(230, 230, 230),
    ))
    .with_focused(SwitchColors::new(
        Color::rgb(50, 50, 50),
        Color::rgb(240, 240, 240),
    ))
    .with_pressed(SwitchColors::new(
        Color::rgb(60, 60, 60),
        Color::rgb(250, 250, 250),
    ))
    .with_disabled(SwitchColors::new(
        Color::rgb(20, 20, 20),
        Color::rgb(100, 100, 100),
    ));
    let on = SwitchStateColors::new(SwitchColors::new(Color::rgb(0, 120, 212), Color::WHITE))
        .with_hovered(SwitchColors::new(Color::rgb(20, 140, 232), Color::WHITE))
        .with_focused(SwitchColors::new(Color::rgb(40, 160, 252), Color::WHITE))
        .with_pressed(SwitchColors::new(Color::rgb(0, 96, 180), Color::WHITE))
        .with_disabled(SwitchColors::new(
            Color::rgb(70, 70, 70),
            Color::rgb(150, 150, 150),
        ));

    SwitchStyle::new(off, on)
        .with_track_size(Size::new(40.0, 20.0))
        .with_thumb_diameter(14.0)
        .with_thumb_inset(3.0)
        .with_track_border(Border::uniform(1.0, Color::WHITE))
        .with_thumb_border(Border::uniform(1.0, Color::rgb(10, 10, 10)))
        .with_track_corner_radii(CornerRadii::uniform(10.0))
        .with_thumb_corner_radii(CornerRadii::uniform(7.0))
}

#[test]
fn switch_centers_track_and_positions_thumb_for_off_and_on() {
    let off = Switch::new(
        Rect::from_xywh(10.0, 10.0, 80.0, 40.0),
        SwitchSelection::Off,
        ToggleState::Resting,
        test_style(),
    );
    assert_eq!(off.track_bounds(), Rect::from_xywh(30.0, 20.0, 40.0, 20.0));
    assert_eq!(off.thumb_bounds(), Rect::from_xywh(33.0, 23.0, 14.0, 14.0));

    let on = Switch::new(
        off.bounds(),
        SwitchSelection::On,
        ToggleState::Resting,
        test_style(),
    );
    assert_eq!(on.thumb_bounds(), Rect::from_xywh(53.0, 23.0, 14.0, 14.0));
}

#[test]
fn switch_paints_position_and_interaction_state_colors() {
    let switch = Switch::new(
        Rect::from_xywh(0.0, 0.0, 80.0, 40.0),
        SwitchSelection::On,
        ToggleState::Pressed,
        test_style(),
    );
    let mut scene = UiScene::new(Color::TRANSPARENT);

    scene.draw_component(&switch);

    assert_eq!(scene.rects().len(), 2);
    assert_eq!(scene.rects()[0].fill(), Color::rgb(0, 96, 180));
    assert_eq!(scene.rects()[1].fill(), Color::WHITE);
    assert_eq!(scene.rects()[0].bounds(), switch.track_bounds());
    assert_eq!(scene.rects()[1].bounds(), switch.thumb_bounds());
}

#[test]
fn disabled_switch_uses_disabled_colors_without_changing_geometry() {
    let switch = Switch::new(
        Rect::from_xywh(0.0, 0.0, 80.0, 40.0),
        SwitchSelection::Off,
        ToggleState::Disabled,
        test_style(),
    );
    let mut scene = UiScene::new(Color::TRANSPARENT);

    scene.draw_component(&switch);

    assert_eq!(scene.rects()[0].fill(), Color::rgb(20, 20, 20));
    assert_eq!(scene.rects()[1].fill(), Color::rgb(100, 100, 100));
    assert_eq!(scene.rects()[0].bounds(), switch.track_bounds());
    assert_eq!(scene.rects()[1].bounds(), switch.thumb_bounds());
}

#[test]
fn switch_clamps_visual_geometry_to_small_host_bounds() {
    let switch = Switch::new(
        Rect::from_xywh(10.0, 20.0, 12.0, 8.0),
        SwitchSelection::On,
        ToggleState::Resting,
        test_style(),
    );

    assert_eq!(
        switch.track_bounds(),
        Rect::from_xywh(10.0, 20.0, 12.0, 8.0)
    );
    assert_eq!(switch.thumb_bounds(), Rect::from_xywh(14.0, 20.0, 8.0, 8.0));
}

#[test]
fn switch_projects_animation_progress_into_thumb_geometry() {
    let switch = Switch::new(
        Rect::from_xywh(10.0, 10.0, 80.0, 40.0),
        SwitchSelection::On,
        ToggleState::Resting,
        test_style(),
    )
    .with_progress(0.5);

    assert_eq!(
        switch.thumb_bounds(),
        Rect::from_xywh(43.0, 23.0, 14.0, 14.0)
    );
}
