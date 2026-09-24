use super::{
    ScrollAxis, ScrollCommand, ScrollDelta, ScrollMetrics, ScrollState, ScrollView,
    ScrollViewStyle, ScrollbarPresentation, ScrollbarStyle, ScrollbarVisibility,
};
use crate::{
    Color, Component, Point, Rect, ScrollbarAxis, ScrollbarPart, ScrollbarState, Size, UiScene,
};

fn style() -> ScrollViewStyle {
    ScrollViewStyle::new(ScrollbarStyle::new(
        Color::TRANSPARENT,
        Color::rgb(126, 126, 132),
    ))
}

#[test]
fn state_applies_pixel_end_and_ensure_visible_commands_with_axis_clamping() {
    let metrics = ScrollMetrics::new(Size::new(100.0, 80.0), Size::new(300.0, 240.0));
    let mut state = ScrollState::default();

    assert!(state.apply(
        ScrollCommand::ByPixels(ScrollDelta::both(50.0, 60.0)),
        metrics,
        ScrollAxis::Vertical,
    ));
    assert_eq!(state.offset(), Point::new(0.0, 60.0));
    assert!(state.apply(
        ScrollCommand::ToEnd(ScrollAxis::Vertical),
        metrics,
        ScrollAxis::Vertical,
    ));
    assert_eq!(state.vertical_offset(), 160.0);
    assert!(state.apply(
        ScrollCommand::EnsureVisible(Rect::from_xywh(0.0, 20.0, 20.0, 20.0)),
        metrics,
        ScrollAxis::Vertical,
    ));
    assert_eq!(state.vertical_offset(), 20.0);
    assert!(state.apply(
        ScrollCommand::ToStart(ScrollAxis::Both),
        metrics,
        ScrollAxis::Vertical,
    ));
    assert_eq!(state.offset(), Point::new(0.0, 0.0));
}

#[test]
fn draw_clips_content_and_reports_translated_content_geometry() {
    let mut state = ScrollState::default();
    let metrics = ScrollMetrics::new(Size::new(100.0, 80.0), Size::new(100.0, 240.0));
    state.apply(
        ScrollCommand::ByPixels(ScrollDelta::vertical(60.0)),
        metrics,
        ScrollAxis::Vertical,
    );
    let view = ScrollView::new(
        Rect::from_xywh(10.0, 20.0, 100.0, 80.0),
        metrics.content(),
        state,
        ScrollAxis::Vertical,
        style(),
    );
    let mut scene = UiScene::new(Color::WHITE);

    let viewport = view.draw(&mut scene, |scene, viewport| {
        scene.draw_rect(crate::PaintRect::new(
            Rect::from_xywh(
                viewport.content_origin().x,
                viewport.content_origin().y,
                100.0,
                240.0,
            ),
            Color::WHITE,
        ));
        viewport
    });

    assert_eq!(viewport.content_origin(), Point::new(10.0, -40.0));
    assert_eq!(
        viewport.visible_content_bounds(),
        Rect::from_xywh(0.0, 60.0, 100.0, 80.0)
    );
    assert_eq!(
        scene.rects()[0].clip_bounds(),
        Some(Rect::from_xywh(10.0, 20.0, 100.0, 80.0))
    );
}

#[test]
fn automatic_vertical_scrollbar_uses_proportional_clamped_thumb_geometry() {
    let mut state = ScrollState::default();
    let metrics = ScrollMetrics::new(Size::new(100.0, 100.0), Size::new(100.0, 400.0));
    state.apply(
        ScrollCommand::ToEnd(ScrollAxis::Vertical),
        metrics,
        ScrollAxis::Vertical,
    );
    let view = ScrollView::new(
        Rect::from_xywh(0.0, 0.0, 100.0, 100.0),
        metrics.content(),
        state,
        ScrollAxis::Vertical,
        style(),
    );

    let scrollbar = view.vertical_scrollbar().unwrap();

    assert_eq!(
        scrollbar.track_bounds(),
        Rect::from_xywh(92.0, 0.0, 8.0, 100.0)
    );
    assert_eq!(
        scrollbar.thumb_bounds(),
        Rect::from_xywh(92.0, 75.0, 8.0, 25.0)
    );
    assert!(view.horizontal_scrollbar().is_none());
}

#[test]
fn both_axis_view_composes_independent_horizontal_and_vertical_scrollbars() {
    let view = ScrollView::new(
        Rect::from_xywh(10.0, 20.0, 100.0, 80.0),
        Size::new(300.0, 240.0),
        ScrollState::default(),
        ScrollAxis::Both,
        style(),
    );

    assert_eq!(
        view.horizontal_scrollbar().unwrap().layout().axis(),
        ScrollbarAxis::Horizontal
    );
    assert_eq!(
        view.vertical_scrollbar().unwrap().layout().axis(),
        ScrollbarAxis::Vertical
    );
}

#[test]
fn visibility_policy_can_hide_or_force_a_scrollbar() {
    let bounds = Rect::from_xywh(0.0, 0.0, 100.0, 100.0);
    let content = Size::new(100.0, 100.0);
    let hidden = ScrollView::new(
        bounds,
        content,
        ScrollState::default(),
        ScrollAxis::Vertical,
        style().with_visibility(ScrollbarVisibility::Hidden),
    );
    let forced = ScrollView::new(
        bounds,
        content,
        ScrollState::default(),
        ScrollAxis::Vertical,
        style().with_visibility(ScrollbarVisibility::Always),
    );

    assert!(hidden.vertical_scrollbar().is_none());
    assert!(forced.vertical_scrollbar().is_some());
}

#[test]
fn thumb_drag_maps_track_travel_to_absolute_content_offset() {
    let bounds = Rect::from_xywh(0.0, 0.0, 100.0, 100.0);
    let content = Size::new(100.0, 400.0);
    let view = ScrollView::new(
        bounds,
        content,
        ScrollState::default(),
        ScrollAxis::Vertical,
        style(),
    );
    let scrollbar = view.vertical_scrollbar().unwrap();
    let thumb = scrollbar.thumb_bounds();
    let thumb_travel = scrollbar.track_bounds().size.height - thumb.size.height;
    let pointer = Point::new(thumb.origin.x + 2.0, thumb.origin.y + 4.0);
    let hit = view.hit_test_scrollbar(pointer).unwrap();
    assert_eq!(hit.part(), ScrollbarPart::Thumb);
    let drag = view.begin_scrollbar_drag(hit, pointer).unwrap();
    let mut state = ScrollState::default();

    assert!(state.apply(
        drag.command_at(Point::new(pointer.x, pointer.y + thumb_travel)),
        view.metrics(),
        ScrollAxis::Vertical,
    ));

    assert_eq!(state.vertical_offset(), 300.0);
}

#[test]
fn track_click_pages_before_and_after_the_thumb() {
    let bounds = Rect::from_xywh(0.0, 0.0, 100.0, 100.0);
    let metrics = ScrollMetrics::new(bounds.size, Size::new(100.0, 400.0));
    let mut state = ScrollState::default();
    state.apply(
        ScrollCommand::ByPixels(ScrollDelta::vertical(150.0)),
        metrics,
        ScrollAxis::Vertical,
    );
    let view = ScrollView::new(
        bounds,
        metrics.content(),
        state,
        ScrollAxis::Vertical,
        style(),
    );
    let track = view.vertical_scrollbar().unwrap().track_bounds();
    let point = Point::new(track.origin.x + 2.0, track.origin.y + 1.0);
    let hit = view.hit_test_scrollbar(point).unwrap();
    assert_eq!(hit.part(), ScrollbarPart::Track);

    assert!(state.apply(
        view.track_click_command(hit, point).unwrap(),
        metrics,
        ScrollAxis::Vertical,
    ));

    assert_eq!(state.vertical_offset(), 50.0);
}

#[test]
fn presentation_selects_hover_color_and_applies_fade_opacity() {
    let hovered_thumb = Color::rgba(20, 30, 40, 200);
    let style = ScrollViewStyle::new(
        ScrollbarStyle::new(Color::TRANSPARENT, Color::TRANSPARENT)
            .with_hovered_colors(Color::TRANSPARENT, hovered_thumb),
    );
    let view = ScrollView::new(
        Rect::from_xywh(0.0, 0.0, 100.0, 100.0),
        Size::new(100.0, 400.0),
        ScrollState::default(),
        ScrollAxis::Vertical,
        style,
    )
    .with_scrollbar_presentation(ScrollbarPresentation::new(ScrollbarState::Hovered, 0.5));
    let mut scene = UiScene::new(Color::WHITE);

    view.paint(&mut scene);

    assert_eq!(
        scene.rects().last().unwrap().fill(),
        Color::rgba(20, 30, 40, 100)
    );
}
