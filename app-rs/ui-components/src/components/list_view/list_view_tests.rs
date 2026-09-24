use super::{ListContentPadding, ListView, VirtualListLayout};
use crate::{
    Color, PaintRect, Point, Rect, ScrollAxis, ScrollCommand, ScrollDelta, ScrollState,
    ScrollViewStyle, ScrollbarStyle, Size, UiScene,
};

fn style() -> ScrollViewStyle {
    ScrollViewStyle::new(ScrollbarStyle::new(
        Color::TRANSPARENT,
        Color::rgb(126, 126, 132),
    ))
}

#[test]
fn fixed_extent_layout_projects_visible_and_overscan_ranges() {
    let bounds = Rect::from_xywh(10.0, 20.0, 200.0, 100.0);
    let mut state = ScrollState::default();
    state.apply(
        ScrollCommand::ByPixels(ScrollDelta::vertical(60.0)),
        crate::ScrollMetrics::new(bounds.size, Size::new(200.0, 1_000.0)),
        ScrollAxis::Vertical,
    );
    let list = ListView::new(bounds, 50, 20.0, state, style()).with_overscan_items(2);

    assert_eq!(list.visible_range(), 3..8);
    assert_eq!(
        list.layout().projected_range(list.scroll_view().viewport()),
        1..10
    );
    assert_eq!(
        list.item_bounds(3),
        Some(Rect::from_xywh(10.0, 20.0, 200.0, 20.0))
    );
}

#[test]
fn item_hit_testing_and_ensure_visible_use_content_coordinates() {
    let bounds = Rect::from_xywh(10.0, 20.0, 200.0, 100.0);
    let list = ListView::new(bounds, 50, 20.0, ScrollState::default(), style());

    assert_eq!(list.item_at(Point::new(20.0, 65.0)), Some(2));
    assert_eq!(list.item_at(Point::new(20.0, 125.0)), None);
    assert_eq!(
        list.ensure_visible_command(12),
        Some(ScrollCommand::EnsureVisible(Rect::from_xywh(
            0.0, 240.0, 200.0, 20.0
        )))
    );
    assert_eq!(list.ensure_visible_command(50), None);
}

#[test]
fn draw_only_invokes_projected_items_and_clips_them_to_the_viewport() {
    let bounds = Rect::from_xywh(0.0, 0.0, 100.0, 60.0);
    let list =
        ListView::new(bounds, 1_000, 20.0, ScrollState::default(), style()).with_overscan_items(1);
    let mut scene = UiScene::new(Color::WHITE);
    let mut indices = Vec::new();

    list.draw(&mut scene, |scene, item| {
        indices.push(item.index());
        scene.draw_rect(PaintRect::new(item.bounds(), Color::WHITE));
    });

    assert_eq!(indices, vec![0, 1, 2, 3]);
    assert_eq!(scene.rects().len(), 5);
    assert!(
        scene
            .rects()
            .iter()
            .take(3)
            .all(|rect| rect.clip_bounds() == Some(bounds))
    );
}

#[test]
fn empty_layout_has_no_visible_or_hit_testable_items() {
    let bounds = Rect::from_xywh(0.0, 0.0, 100.0, 60.0);
    let layout = VirtualListLayout::new(0, 20.0);
    let viewport = ListView::new(bounds, 0, 20.0, ScrollState::default(), style())
        .scroll_view()
        .viewport();

    assert_eq!(layout.visible_range(viewport), 0..0);
    assert_eq!(layout.item_at(Point::new(10.0, 10.0), viewport), None);
}

#[test]
fn variable_extent_layout_uses_cumulative_geometry_and_skips_gaps() {
    let bounds = Rect::from_xywh(10.0, 20.0, 200.0, 50.0);
    let layout = VirtualListLayout::variable([20.0, 60.0, 30.0])
        .with_item_gap(5.0)
        .with_content_padding(ListContentPadding::new(10.0, 15.0))
        .with_overscan_items(1);
    let mut state = ScrollState::default();
    state.apply(
        ScrollCommand::ByPixels(ScrollDelta::vertical(40.0)),
        crate::ScrollMetrics::new(bounds.size, layout.content_size(bounds.size.width)),
        ScrollAxis::Vertical,
    );
    let list = ListView::from_layout(bounds, layout, state, style());

    assert_eq!(list.layout().content_extent(), 145.0);
    assert_eq!(list.visible_range(), 1..2);
    assert_eq!(
        list.layout().projected_range(list.scroll_view().viewport()),
        0..3
    );
    assert_eq!(
        list.item_bounds(1),
        Some(Rect::from_xywh(10.0, 15.0, 200.0, 60.0))
    );
    assert_eq!(list.item_at(Point::new(20.0, 20.0)), Some(1));

    let unscrolled = ListView::from_layout(
        bounds,
        list.layout().clone(),
        ScrollState::default(),
        style(),
    );
    assert_eq!(unscrolled.item_at(Point::new(20.0, 52.0)), None);
    assert_eq!(
        unscrolled.ensure_visible_command(2),
        Some(ScrollCommand::EnsureVisible(Rect::from_xywh(
            0.0, 100.0, 200.0, 30.0
        )))
    );
}

#[test]
fn measured_extent_updates_repair_the_cumulative_index() {
    let mut layout = VirtualListLayout::new(3, 20.0);
    let unchanged_clone = layout.clone();

    assert_eq!(layout.update_item_extent(1, 35.0), Some(20.0));

    assert_eq!(layout.item_extent(1), Some(35.0));
    assert_eq!(layout.content_extent(), 75.0);
    assert_eq!(unchanged_clone.item_extent(1), Some(20.0));
    assert_eq!(unchanged_clone.content_extent(), 60.0);
}

#[test]
fn variable_extent_index_handles_many_point_updates_without_rebuilding_layout() {
    let item_count = 100_000;
    let mut layout = VirtualListLayout::variable(vec![20.0; item_count]);

    for index in [0, 1, 31, 32, 65_535, item_count - 1] {
        assert_eq!(layout.update_item_extent(index, 35.0), Some(20.0));
    }

    assert_eq!(layout.content_extent(), 2_000_090.0);
    assert_eq!(layout.item_extent(65_535), Some(35.0));
}

#[test]
fn variable_extent_index_splices_large_sequences_without_rebuilding_unrelated_clones() {
    let mut expected = (0..20_000)
        .map(|index| 18.0 + (index % 7) as f32)
        .collect::<Vec<_>>();
    let mut layout = VirtualListLayout::variable(expected.clone());
    let retained_clone = layout.clone();

    for step in 0..200 {
        let start = (step * 7_919) % (expected.len() + 1);
        let delete_count = (step % 17).min(expected.len() - start);
        let replacements = (0..step % 11)
            .map(|offset| 30.0 + ((step + offset) % 13) as f32)
            .collect::<Vec<_>>();
        expected.splice(start..start + delete_count, replacements.iter().copied());
        layout.splice_item_extents(start..start + delete_count, replacements);

        assert_eq!(layout.item_count(), expected.len());
        assert_eq!(layout.content_extent(), expected.iter().sum::<f32>());
        for index in [0, expected.len() / 2, expected.len().saturating_sub(1)] {
            assert_eq!(layout.item_extent(index), expected.get(index).copied());
        }
    }

    assert_eq!(retained_clone.item_count(), 20_000);
    assert_eq!(retained_clone.item_extent(19_999), Some(18.0));
}

#[test]
fn splice_shifts_sparse_extent_overrides_and_drops_replaced_overrides() {
    let mut layout = VirtualListLayout::variable([20.0, 30.0, 40.0, 50.0])
        .with_item_extent_overrides([(1, 35.0), (3, 55.0)]);

    layout.splice_item_extents(1..3, [60.0]);

    assert_eq!(layout.item_count(), 3);
    assert_eq!(layout.item_extent(0), Some(20.0));
    assert_eq!(layout.item_extent(1), Some(60.0));
    assert_eq!(layout.item_extent(2), Some(55.0));
    assert_eq!(layout.content_extent(), 135.0);
}

#[test]
fn sparse_extent_overrides_adjust_geometry_without_changing_the_retained_index() {
    let layout = VirtualListLayout::variable([20.0, 30.0, 40.0]);
    let projected = layout
        .clone()
        .with_item_extent_overrides([(0, 25.0), (2, 10.0)]);
    let bounds = Rect::from_xywh(0.0, 0.0, 100.0, 100.0);
    let viewport =
        ListView::from_layout(bounds, projected.clone(), ScrollState::default(), style())
            .scroll_view()
            .viewport();

    assert_eq!(layout.content_extent(), 90.0);
    assert_eq!(projected.content_extent(), 65.0);
    assert_eq!(
        projected.item_bounds(1, viewport),
        Some(Rect::from_xywh(0.0, 25.0, 100.0, 30.0))
    );
    assert_eq!(projected.item_extent(2), Some(10.0));
}

#[test]
fn item_relative_anchor_survives_measurement_and_reorder() {
    let mut layout = VirtualListLayout::variable([20.0, 20.0, 20.0]);
    let anchor = layout.scroll_anchor(25.0).unwrap();
    assert_eq!(anchor.item_index(), 1);
    assert_eq!(anchor.distance_from_item_start(), 5.0);

    layout.update_item_extent(0, 40.0);
    assert_eq!(
        layout.command_for_anchor(anchor),
        Some(ScrollCommand::ToOffset(Point::new(0.0, 45.0)))
    );
    assert_eq!(
        layout.command_for_anchor(anchor.with_item_index(2)),
        Some(ScrollCommand::ToOffset(Point::new(0.0, 65.0)))
    );
}
