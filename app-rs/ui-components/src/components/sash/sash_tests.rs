use super::{Sash, SashOrientation, SashState, SashStyle};
use crate::{Color, Component, Rect, UiScene};

#[test]
fn vertical_sash_exposes_a_wide_target_and_centered_feedback() {
    let sash = Sash::new(
        Rect::from_xywh(200.0, 32.0, 0.0, 668.0),
        SashOrientation::Vertical,
        SashState::Hovered,
        SashStyle::new(Color::rgb(0, 120, 212)),
    );

    assert_eq!(
        sash.interaction_bounds(),
        Rect::from_xywh(196.0, 32.0, 8.0, 668.0)
    );
    assert_eq!(
        sash.feedback_bounds(),
        Rect::from_xywh(199.0, 32.0, 2.0, 668.0)
    );
}

#[test]
fn horizontal_sash_uses_the_orthogonal_geometry() {
    let sash = Sash::new(
        Rect::from_xywh(20.0, 430.0, 800.0, 0.0),
        SashOrientation::Horizontal,
        SashState::Active,
        SashStyle::new(Color::WHITE)
            .with_drag_area_size(10.0)
            .with_feedback_size(1.0),
    );

    assert_eq!(
        sash.interaction_bounds(),
        Rect::from_xywh(20.0, 425.0, 800.0, 10.0)
    );
    assert_eq!(
        sash.feedback_bounds(),
        Rect::from_xywh(20.0, 429.5, 800.0, 1.0)
    );
}

#[test]
fn resting_sash_does_not_paint_feedback() {
    let sash = Sash::new(
        Rect::from_xywh(200.0, 32.0, 0.0, 668.0),
        SashOrientation::Vertical,
        SashState::Resting,
        SashStyle::new(Color::WHITE),
    );
    let mut scene = UiScene::new(Color::TRANSPARENT);

    sash.paint(&mut scene);

    assert!(scene.rects().is_empty());
}

#[test]
#[should_panic(expected = "Sash track bounds must be finite")]
fn sash_rejects_non_finite_track_geometry() {
    Sash::new(
        Rect::from_xywh(f32::NAN, 32.0, 0.0, 668.0),
        SashOrientation::Vertical,
        SashState::Resting,
        SashStyle::new(Color::WHITE),
    );
}
