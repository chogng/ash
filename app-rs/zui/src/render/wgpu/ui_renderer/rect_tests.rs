use super::{
    instance_range, linear_color, prepare_instances, shadow_blur_extent, validate_paint_rect,
};
use crate::ui::foundation::{Color, CornerRadii, Edges, Point, Rect};
use crate::ui::presentation::{Border, BoxShadow, PaintRect, UiScene};

use super::{UiRenderError, UiViewport};

#[test]
fn prepares_logical_rect_in_physical_pixels() {
    let mut scene = UiScene::new(Color::TRANSPARENT);
    scene.with_clip(Rect::from_xywh(5.0, 6.0, 70.0, 40.0), |scene| {
        scene.draw_rect(
            PaintRect::new(
                Rect::from_xywh(10.0, 12.0, 50.0, 20.0),
                Color::rgb(128, 64, 32),
            )
            .with_border(Border::new(Edges::new(1.0, 2.0, 3.0, 4.0), Color::WHITE))
            .with_corner_radii(CornerRadii::uniform(5.0)),
        );
    });

    let prepared = prepare_instances(&scene, UiViewport::new(200, 120, 2.0)).unwrap();
    let instances = prepared.instances;

    assert_eq!(instances.len(), 1);
    assert_eq!(instances[0].bounds, [20.0, 24.0, 100.0, 40.0]);
    assert_eq!(instances[0].border_widths, [2.0, 4.0, 6.0, 8.0]);
    assert_eq!(instances[0].corner_radii, [10.0; 4]);
    assert_eq!(instances[0].clip_bounds, [10.0, 12.0, 140.0, 80.0]);
}

#[test]
fn skips_rect_outside_empty_clip() {
    let mut scene = UiScene::new(Color::TRANSPARENT);
    scene.with_clip(Rect::from_xywh(200.0, 200.0, 10.0, 10.0), |scene| {
        scene.draw_rect(PaintRect::new(
            Rect::from_xywh(0.0, 0.0, 20.0, 20.0),
            Color::WHITE,
        ));
    });

    let prepared = prepare_instances(&scene, UiViewport::new(100, 100, 1.0)).unwrap();

    assert!(prepared.instances.is_empty());
}

#[test]
fn prepares_soft_shadow_before_its_source_rect() {
    let mut scene = UiScene::new(Color::TRANSPARENT);
    scene.draw_rect(
        PaintRect::new(Rect::from_xywh(10.0, 12.0, 50.0, 20.0), Color::WHITE)
            .with_shadow(
                BoxShadow::new(Color::rgba(0, 0, 0, 64))
                    .with_offset(Point::new(0.0, 4.0))
                    .with_blur_radius(8.0)
                    .with_spread_radius(2.0),
            )
            .with_corner_radii(CornerRadii::uniform(5.0)),
    );

    let prepared = prepare_instances(&scene, UiViewport::new(200, 120, 2.0)).unwrap();
    let instances = prepared.instances;

    assert_eq!(instances.len(), 2);
    assert_eq!(instances[0].bounds, [-8.0, 4.0, 156.0, 96.0]);
    assert_eq!(instances[0].corner_radii, [14.0; 4]);
    assert_eq!(instances[0].effect, [8.0, 24.0, 1.0, 0.0]);
    assert_eq!(instances[1].bounds, [20.0, 24.0, 100.0, 40.0]);
    assert_eq!(instances[1].effect, [0.0; 4]);
}

#[test]
fn negative_spread_contracts_the_shadow_shape_and_corner_radii() {
    let mut scene = UiScene::new(Color::TRANSPARENT);
    scene.draw_rect(
        PaintRect::new(Rect::from_xywh(10.0, 12.0, 50.0, 20.0), Color::WHITE)
            .with_shadow(
                BoxShadow::new(Color::rgba(0, 0, 0, 64))
                    .with_offset(Point::new(0.0, 4.0))
                    .with_blur_radius(6.0)
                    .with_spread_radius(-1.0),
            )
            .with_corner_radii(CornerRadii::uniform(5.0)),
    );

    let prepared = prepare_instances(&scene, UiViewport::new(200, 120, 2.0)).unwrap();
    let shadow = prepared.instances[0];

    assert_eq!(shadow.bounds, [4.0, 16.0, 132.0, 72.0]);
    assert_eq!(shadow.corner_radii, [8.0; 4]);
    assert_eq!(shadow.effect, [6.0, 18.0, 1.0, 0.0]);
}

#[test]
fn maps_scene_primitives_to_backend_instance_ranges() {
    let mut scene = UiScene::new(Color::TRANSPARENT);
    scene.draw_rect(PaintRect::new(
        Rect::from_xywh(0.0, 0.0, 20.0, 20.0),
        Color::WHITE,
    ));
    scene.with_overlay(|scene| {
        scene.draw_rect(PaintRect::new(
            Rect::from_xywh(5.0, 5.0, 10.0, 10.0),
            Color::rgb(10, 20, 30),
        ));
    });

    let prepared = prepare_instances(&scene, UiViewport::new(100, 100, 1.0)).unwrap();

    assert_eq!(prepared.instances.len(), 2);
    assert_eq!(prepared.primitive_ranges, [0..1, 1..2]);
}

#[test]
fn batch_range_includes_multi_instance_primitives_and_skips_empty_ones() {
    let primitive_ranges = [0..2, 2..2, 2..3];

    assert_eq!(instance_range(&primitive_ranges, 0..3), Some(0..3));
    assert_eq!(instance_range(&primitive_ranges, 1..2), Some(2..2));
    assert_eq!(instance_range(&primitive_ranges, 2..2), None);
}

#[test]
fn rejects_negative_border_width() {
    let rect = PaintRect::new(Rect::from_xywh(0.0, 0.0, 20.0, 20.0), Color::WHITE)
        .with_border(Border::new(Edges::new(1.0, -1.0, 1.0, 1.0), Color::WHITE));

    assert!(matches!(
        validate_paint_rect(4, rect),
        Err(UiRenderError::InvalidPaintRect {
            index: 4,
            reason: "border widths and corner radii must not be negative",
        })
    ));
}

#[test]
fn rejects_non_finite_requested_corner_radius() {
    let rect = PaintRect::new(Rect::from_xywh(0.0, 0.0, 20.0, 20.0), Color::WHITE)
        .with_corner_radii(CornerRadii::uniform(f32::NAN));

    assert!(matches!(
        validate_paint_rect(2, rect),
        Err(UiRenderError::InvalidPaintRect {
            index: 2,
            reason: "coordinates and visual metrics must be finite",
        })
    ));
}

#[test]
fn rejects_negative_shadow_blur_radius() {
    let rect = PaintRect::new(Rect::from_xywh(0.0, 0.0, 20.0, 20.0), Color::WHITE)
        .with_shadow(BoxShadow::new(Color::rgba(0, 0, 0, 64)).with_blur_radius(-1.0));

    assert!(matches!(
        validate_paint_rect(3, rect),
        Err(UiRenderError::InvalidPaintRect {
            index: 3,
            reason: "shadow blur radius must not be negative",
        })
    ));
}

#[test]
fn rejects_non_finite_shadow_spread_radius() {
    let rect = PaintRect::new(Rect::from_xywh(0.0, 0.0, 20.0, 20.0), Color::WHITE)
        .with_shadow(BoxShadow::new(Color::rgba(0, 0, 0, 64)).with_spread_radius(f32::INFINITY));

    assert!(matches!(
        validate_paint_rect(3, rect),
        Err(UiRenderError::InvalidPaintRect {
            index: 3,
            reason: "shadow metrics must be finite",
        })
    ));
}

#[test]
fn uses_three_standard_deviations_for_the_shadow_tail() {
    assert_eq!(shadow_blur_extent(4.0), 12.0);
}

#[test]
fn converts_srgb_channels_to_linear_values() {
    let converted = linear_color(Color::rgba(128, 255, 0, 128));

    assert!((converted[0] - 0.21586).abs() < 0.0001);
    assert_eq!(converted[1], 1.0);
    assert_eq!(converted[2], 0.0);
    assert!((converted[3] - 0.50196).abs() < 0.0001);
}
