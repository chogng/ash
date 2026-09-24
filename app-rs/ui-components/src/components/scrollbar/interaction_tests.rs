use std::time::Duration;
use std::time::Instant;

use super::ScrollbarController;
use super::ScrollbarPresentation;
use super::ScrollbarState;
use crate::Color;
use crate::Point;
use crate::Rect;
use crate::ScrollAxis;
use crate::ScrollState;
use crate::ScrollView;
use crate::ScrollViewStyle;
use crate::ScrollbarStyle;
use crate::Size;

const HOLD: Duration = Duration::from_millis(100);
const FADE_IN: Duration = Duration::from_millis(20);
const FADE_OUT: Duration = Duration::from_millis(40);

fn controller() -> ScrollbarController {
    ScrollbarController::new(HOLD, FADE_IN, FADE_OUT)
}

fn scroll_view(state: ScrollState, axis: ScrollAxis) -> ScrollView {
    ScrollView::new(
        Rect::from_xywh(0.0, 0.0, 100.0, 100.0),
        Size::new(400.0, 400.0),
        state,
        axis,
        ScrollViewStyle::new(ScrollbarStyle::new(
            Color::TRANSPARENT,
            Color::rgb(100, 100, 100),
        )),
    )
}

#[test]
fn activity_fades_in_holds_and_fades_out() {
    let now = Instant::now();
    let mut controller = controller();

    controller.activity(now);
    assert_eq!(
        controller.presentation(),
        ScrollbarPresentation::new(ScrollbarState::Resting, 0.0)
    );
    assert!(controller.advance(now + FADE_IN));
    assert_eq!(controller.presentation().opacity(), 1.0);
    assert!(!controller.advance(now + HOLD));
    assert!(controller.advance(now + HOLD + Duration::from_millis(20)));
    assert_eq!(controller.presentation().opacity(), 0.5);
    assert!(controller.advance(now + HOLD + FADE_OUT));
    assert_eq!(controller.presentation().opacity(), 0.0);
    assert_eq!(controller.next_deadline(), None);
}

#[test]
fn viewport_hover_shows_the_scrollbar_and_exit_starts_fade_out() {
    let now = Instant::now();
    let mut controller = controller();
    let mut state = ScrollState::default();
    let view = scroll_view(state, ScrollAxis::Vertical);

    controller.pointer_moved(view, &mut state, Point::new(50.0, 50.0), now);
    controller.advance(now + FADE_IN);
    assert_eq!(controller.presentation().state(), ScrollbarState::Hovered);
    assert_eq!(controller.presentation().opacity(), 1.0);
    assert_eq!(controller.next_deadline(), None);

    let exited = controller.pointer_moved(view, &mut state, Point::new(-1.0, -1.0), now + FADE_IN);
    assert!(exited.presentation_changed);
    assert_eq!(controller.presentation().state(), ScrollbarState::Resting);
    assert!(controller.next_deadline().is_some());
    controller.advance(now + FADE_IN + FADE_OUT);
    assert_eq!(controller.presentation().opacity(), 0.0);
}

#[test]
fn one_controller_keeps_hover_across_content_and_both_scrollbar_axes() {
    let now = Instant::now();
    let mut controller = controller();
    let mut state = ScrollState::default();
    let view = scroll_view(state, ScrollAxis::Both);
    let vertical = view.vertical_scrollbar().unwrap().track_bounds();
    let horizontal = view.horizontal_scrollbar().unwrap().track_bounds();

    let entered = controller.pointer_moved(view, &mut state, Point::new(50.0, 50.0), now);
    assert_eq!(
        entered,
        super::ScrollbarInteractionOutcome {
            handled: false,
            presentation_changed: true,
        }
    );
    assert_eq!(controller.presentation().state(), ScrollbarState::Hovered);
    controller.advance(now + FADE_IN);

    let crossed_vertical = controller.pointer_moved(
        view,
        &mut state,
        Point::new(vertical.origin.x + 1.0, vertical.origin.y + 1.0),
        now + FADE_IN,
    );
    assert_eq!(
        crossed_vertical,
        super::ScrollbarInteractionOutcome::default()
    );

    let crossed_axis = controller.pointer_moved(
        view,
        &mut state,
        Point::new(horizontal.origin.x + 1.0, horizontal.origin.y + 1.0),
        now + FADE_IN,
    );
    assert_eq!(crossed_axis, super::ScrollbarInteractionOutcome::default());
    assert_eq!(controller.presentation().state(), ScrollbarState::Hovered);

    let exited = controller.pointer_moved(view, &mut state, Point::new(101.0, 50.0), now + FADE_IN);
    assert!(exited.presentation_changed);
    assert_eq!(controller.presentation().state(), ScrollbarState::Resting);
    assert!(controller.next_deadline().is_some());
}

#[test]
fn controller_owns_thumb_capture_and_updates_scroll_state() {
    let now = Instant::now();
    let mut controller = controller();
    let mut state = ScrollState::default();
    let view = scroll_view(state, ScrollAxis::Vertical);
    let scrollbar = view.vertical_scrollbar().unwrap();
    let thumb = scrollbar.thumb_bounds();
    let start = Point::new(thumb.origin.x + 1.0, thumb.origin.y + 1.0);

    assert!(controller.press(view, &mut state, start, now).handled);
    assert_eq!(controller.presentation().state(), ScrollbarState::Active);

    let moved = controller.pointer_moved(
        view,
        &mut state,
        Point::new(start.x, scrollbar.track_bounds().bottom() - 1.0),
        now,
    );
    assert!(moved.handled);
    assert!(moved.presentation_changed);
    assert_eq!(state.vertical_offset(), 300.0);

    assert!(
        controller
            .release(view, Point::new(-1.0, -1.0), now)
            .handled
    );
    assert_eq!(controller.presentation().state(), ScrollbarState::Resting);
}

#[test]
fn release_inside_viewport_restores_viewport_hover() {
    let now = Instant::now();
    let mut controller = controller();
    let mut state = ScrollState::default();
    let view = scroll_view(state, ScrollAxis::Vertical);
    let thumb = view.vertical_scrollbar().unwrap().thumb_bounds();
    let start = Point::new(thumb.origin.x + 1.0, thumb.origin.y + 1.0);

    controller.press(view, &mut state, start, now);
    controller.release(view, Point::new(50.0, 50.0), now);

    assert_eq!(controller.presentation().state(), ScrollbarState::Hovered);
    assert!(controller.next_deadline().is_some());
}

#[test]
fn cancel_immediately_hides_and_stops_animation() {
    let now = Instant::now();
    let mut controller = controller();
    controller.activity(now);

    controller.cancel();

    assert_eq!(controller.presentation().opacity(), 0.0);
    assert_eq!(controller.next_deadline(), None);
}
