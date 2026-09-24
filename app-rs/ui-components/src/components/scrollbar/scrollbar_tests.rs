use super::HorizontalScrollbar;
use super::ScrollbarAxis;
use super::ScrollbarMetrics;
use super::ScrollbarPart;
use super::ScrollbarPresentation;
use super::ScrollbarState;
use super::ScrollbarStyle;
use super::VerticalScrollbar;
use crate::Color;
use crate::Component;
use crate::Point;
use crate::Rect;
use crate::UiScene;

fn style() -> ScrollbarStyle {
    ScrollbarStyle::new(Color::TRANSPARENT, Color::rgb(126, 126, 132))
}

#[test]
fn vertical_scrollbar_resolves_track_and_thumb_from_scalar_metrics() {
    let scrollbar = VerticalScrollbar::new(
        Rect::from_xywh(0.0, 0.0, 100.0, 100.0),
        ScrollbarMetrics::new(100.0, 400.0, 300.0),
        style(),
    );

    assert_eq!(scrollbar.layout().axis(), ScrollbarAxis::Vertical);
    assert_eq!(
        scrollbar.track_bounds(),
        Rect::from_xywh(92.0, 0.0, 8.0, 100.0)
    );
    assert_eq!(
        scrollbar.thumb_bounds(),
        Rect::from_xywh(92.0, 75.0, 8.0, 25.0)
    );
}

#[test]
fn scrollbar_owns_hit_drag_and_track_page_geometry() {
    let scrollbar = VerticalScrollbar::new(
        Rect::from_xywh(0.0, 0.0, 100.0, 100.0),
        ScrollbarMetrics::new(100.0, 400.0, 0.0),
        style(),
    );
    let thumb = scrollbar.thumb_bounds();
    let pointer = Point::new(thumb.origin.x + 2.0, thumb.origin.y + 4.0);
    let hit = scrollbar.hit_test(pointer).unwrap();
    assert_eq!(hit.part(), ScrollbarPart::Thumb);

    let drag = scrollbar
        .begin_drag(hit, pointer, Point::new(0.0, 0.0))
        .unwrap();
    assert_eq!(drag.axis(), ScrollbarAxis::Vertical);

    let track_point = Point::new(
        scrollbar.track_bounds().origin.x + 2.0,
        scrollbar.track_bounds().bottom() - 1.0,
    );
    let track_hit = scrollbar.hit_test(track_point).unwrap();
    assert_eq!(track_hit.part(), ScrollbarPart::Track);
    assert!(
        scrollbar
            .track_click_command(track_hit, track_point)
            .is_some()
    );
}

#[test]
fn scrollbar_component_selects_state_color_and_opacity() {
    let hovered_thumb = Color::rgba(20, 30, 40, 200);
    let scrollbar = VerticalScrollbar::new(
        Rect::from_xywh(0.0, 0.0, 100.0, 100.0),
        ScrollbarMetrics::new(100.0, 400.0, 0.0),
        ScrollbarStyle::new(Color::TRANSPARENT, Color::TRANSPARENT)
            .with_hovered_colors(Color::TRANSPARENT, hovered_thumb),
    )
    .with_presentation(ScrollbarPresentation::new(ScrollbarState::Hovered, 0.5));
    let mut scene = UiScene::new(Color::WHITE);

    scrollbar.paint(&mut scene);

    assert_eq!(
        scene.rects().last().unwrap().fill(),
        Color::rgba(20, 30, 40, 100)
    );
}

#[test]
fn horizontal_scrollbar_has_horizontal_geometry_without_an_axis_argument() {
    let scrollbar = HorizontalScrollbar::new(
        Rect::from_xywh(10.0, 20.0, 100.0, 80.0),
        ScrollbarMetrics::new(100.0, 200.0, 0.0),
        style(),
    );

    assert_eq!(scrollbar.layout().axis(), ScrollbarAxis::Horizontal);
    assert_eq!(
        scrollbar.track_bounds(),
        Rect::from_xywh(10.0, 92.0, 100.0, 8.0)
    );

    let mut scene = UiScene::new(Color::TRANSPARENT);
    scene.draw_component(&scrollbar);
    assert!(
        scene
            .inspection()
            .nodes()
            .iter()
            .any(|node| node.name() == "HorizontalScrollbar")
    );
}
