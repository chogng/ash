use super::{SplitViewLayout, SplitViewLayoutPriority, SplitViewOrientation, SplitViewPane};
use crate::Rect;

#[test]
fn horizontal_layout_resolves_panes_and_a_vertical_sash_track() {
    let panes = [
        SplitViewPane::new(200.0, 160.0, 480.0),
        SplitViewPane::new(800.0, 240.0, f32::INFINITY)
            .with_priority(SplitViewLayoutPriority::High),
    ];
    let layout = SplitViewLayout::new(
        Rect::from_xywh(0.0, 32.0, 1_000.0, 668.0),
        SplitViewOrientation::Horizontal,
        &panes,
    );

    assert_eq!(
        layout.pane_bounds(0),
        Some(Rect::from_xywh(0.0, 32.0, 200.0, 668.0))
    );
    assert_eq!(
        layout.pane_bounds(1),
        Some(Rect::from_xywh(200.0, 32.0, 800.0, 668.0))
    );
    assert_eq!(
        layout.sash(0).unwrap().track_bounds(),
        Rect::from_xywh(200.0, 32.0, 0.0, 668.0)
    );
}

#[test]
fn high_priority_pane_absorbs_container_size_changes_first() {
    let panes = [
        SplitViewPane::new(200.0, 160.0, 480.0),
        SplitViewPane::new(800.0, 240.0, f32::INFINITY)
            .with_priority(SplitViewLayoutPriority::High),
    ];

    let larger = SplitViewLayout::new(
        Rect::from_xywh(0.0, 0.0, 1_100.0, 600.0),
        SplitViewOrientation::Horizontal,
        &panes,
    );
    let constrained = SplitViewLayout::new(
        Rect::from_xywh(0.0, 0.0, 500.0, 600.0),
        SplitViewOrientation::Horizontal,
        &panes,
    );

    assert_eq!(larger.pane_size(0), Some(200.0));
    assert_eq!(larger.pane_size(1), Some(900.0));
    assert_eq!(constrained.pane_size(0), Some(200.0));
    assert_eq!(constrained.pane_size(1), Some(300.0));
}

#[test]
fn layout_reduces_normal_pane_after_high_priority_pane_reaches_its_minimum() {
    let panes = [
        SplitViewPane::new(420.0, 160.0, 480.0),
        SplitViewPane::new(240.0, 240.0, f32::INFINITY)
            .with_priority(SplitViewLayoutPriority::High),
    ];
    let layout = SplitViewLayout::new(
        Rect::from_xywh(0.0, 0.0, 500.0, 600.0),
        SplitViewOrientation::Horizontal,
        &panes,
    );

    assert_eq!(layout.pane_size(0), Some(260.0));
    assert_eq!(layout.pane_size(1), Some(240.0));
}

#[test]
fn hidden_pane_has_zero_geometry_and_does_not_create_a_sash() {
    let panes = [
        SplitViewPane::new(200.0, 160.0, 480.0).hidden(),
        SplitViewPane::new(800.0, 240.0, f32::INFINITY)
            .with_priority(SplitViewLayoutPriority::High),
    ];
    let layout = SplitViewLayout::new(
        Rect::from_xywh(0.0, 0.0, 1_000.0, 600.0),
        SplitViewOrientation::Horizontal,
        &panes,
    );

    assert_eq!(
        layout.pane_bounds(0),
        Some(Rect::from_xywh(0.0, 0.0, 0.0, 600.0))
    );
    assert_eq!(
        layout.pane_bounds(1),
        Some(Rect::from_xywh(0.0, 0.0, 1_000.0, 600.0))
    );
    assert!(layout.sashes().is_empty());
}

#[test]
fn resize_snapshot_clamps_both_adjacent_panes_from_drag_start_sizes() {
    let panes = [
        SplitViewPane::new(200.0, 160.0, 480.0),
        SplitViewPane::new(800.0, 240.0, f32::INFINITY),
    ];
    let layout = SplitViewLayout::new(
        Rect::from_xywh(0.0, 0.0, 1_000.0, 600.0),
        SplitViewOrientation::Horizontal,
        &panes,
    );
    let resize = layout.sash(0).unwrap().resize_snapshot();

    let expanded = resize.resize(400.0);
    assert_eq!(expanded.previous_size(), 480.0);
    assert_eq!(expanded.next_size(), 520.0);
    let contracted = resize.resize(-100.0);
    assert_eq!(contracted.previous_size(), 160.0);
    assert_eq!(contracted.next_size(), 840.0);
    assert_eq!(expanded.previous_index(), 0);
    assert_eq!(expanded.next_index(), 1);
}

#[test]
fn vertical_layout_produces_a_horizontal_sash_track() {
    let panes = [
        SplitViewPane::new(400.0, 100.0, f32::INFINITY),
        SplitViewPane::new(200.0, 80.0, 300.0),
    ];
    let layout = SplitViewLayout::new(
        Rect::from_xywh(20.0, 30.0, 800.0, 600.0),
        SplitViewOrientation::Vertical,
        &panes,
    );

    assert_eq!(
        layout.sash(0).unwrap().track_bounds(),
        Rect::from_xywh(20.0, 430.0, 800.0, 0.0)
    );
}

#[test]
#[should_panic(expected = "SplitView resize delta must be finite")]
fn resize_snapshot_rejects_non_finite_pointer_delta() {
    let panes = [
        SplitViewPane::new(200.0, 160.0, 480.0),
        SplitViewPane::new(800.0, 240.0, f32::INFINITY),
    ];
    let layout = SplitViewLayout::new(
        Rect::from_xywh(0.0, 0.0, 1_000.0, 600.0),
        SplitViewOrientation::Horizontal,
        &panes,
    );

    layout.sash(0).unwrap().resize_snapshot().resize(f32::NAN);
}
