use std::time::{Duration, Instant};

use super::{Resizable, SashController};
use crate::{
    Point, Rect, SashOrientation, SashState, SplitViewLayout, SplitViewLayoutPriority,
    SplitViewOrientation, SplitViewPane,
};
use zui::ui::HoverPresence;

const HOVER_DELAY: Duration = Duration::from_millis(300);

fn split_snapshot() -> crate::SplitViewResizeSnapshot {
    SplitViewLayout::new(
        Rect::from_xywh(0.0, 0.0, 1_000.0, 1.0),
        SplitViewOrientation::Horizontal,
        &[
            SplitViewPane::new(480.0, 240.0, f32::INFINITY)
                .with_priority(SplitViewLayoutPriority::High),
            SplitViewPane::new(520.0, 160.0, 800.0),
        ],
    )
    .sash(0)
    .expect("two flexible panes should expose a sash")
    .resize_snapshot()
}

#[test]
fn sash_controller_delays_hover_until_its_deadline() {
    let now = Instant::now();
    let mut controller = SashController::new(HOVER_DELAY);

    assert!(!controller.pointer_presence(HoverPresence::Over, now));
    assert_eq!(controller.presentation(), SashState::Resting);
    assert_eq!(controller.next_deadline(), Some(now + HOVER_DELAY));
    assert!(!controller.advance(now + HOVER_DELAY - Duration::from_millis(1)));
    assert_eq!(controller.presentation(), SashState::Resting);
    assert!(controller.advance(now + HOVER_DELAY));
    assert_eq!(controller.presentation(), SashState::Hovered);
    assert_eq!(controller.next_deadline(), None);
}

#[test]
fn sash_controller_cancels_pending_and_visible_hover_on_exit() {
    let now = Instant::now();
    let mut controller = SashController::new(HOVER_DELAY);

    controller.pointer_presence(HoverPresence::Over, now);
    assert!(!controller.pointer_presence(HoverPresence::Outside, now));
    assert_eq!(controller.next_deadline(), None);
    assert_eq!(controller.presentation(), SashState::Resting);

    controller.pointer_presence(HoverPresence::Over, now);
    controller.advance(now + HOVER_DELAY);
    assert!(controller.pointer_presence(HoverPresence::Outside, now));
    assert_eq!(controller.presentation(), SashState::Resting);
}

#[test]
fn sash_controller_enters_active_presentation_immediately_for_drag() {
    let now = Instant::now();
    let mut controller = SashController::new(HOVER_DELAY);

    controller.pointer_presence(HoverPresence::Over, now);
    assert!(controller.begin_drag(now));
    assert_eq!(controller.presentation(), SashState::Active);
    assert_eq!(controller.next_deadline(), None);
    assert!(controller.end_drag(HoverPresence::Over, now));
    assert_eq!(controller.presentation(), SashState::Hovered);
}

#[test]
fn resizable_uses_vertical_sash_pointer_delta_and_snapshot_constraints() {
    let now = Instant::now();
    let snapshot = split_snapshot();
    let mut resizable = Resizable::new(SashOrientation::Vertical);

    assert!(resizable.begin_drag(snapshot, Point::new(480.0, 700.0), now));
    assert_eq!(resizable.resize_to(Point::new(480.0, 0.0)), None);
    assert_eq!(
        resizable.resize_to(Point::new(580.0, 0.0)),
        Some(snapshot.resize(100.0))
    );
    assert!(resizable.end_drag(HoverPresence::Outside, now));
    assert!(!resizable.is_dragging());
}

#[test]
fn resizable_uses_horizontal_sash_pointer_delta() {
    let now = Instant::now();
    let snapshot = split_snapshot();
    let mut resizable = Resizable::new(SashOrientation::Horizontal);

    assert!(resizable.begin_drag(snapshot, Point::new(700.0, 20.0), now));
    assert_eq!(
        resizable.resize_to(Point::new(0.0, 70.0)),
        Some(snapshot.resize(50.0))
    );
}

#[test]
fn resizable_rejects_a_second_drag_until_the_first_ends() {
    let now = Instant::now();
    let snapshot = split_snapshot();
    let mut resizable = Resizable::new(SashOrientation::Vertical);

    assert!(resizable.begin_drag(snapshot, Point::new(480.0, 0.0), now));
    assert!(!resizable.begin_drag(snapshot, Point::new(480.0, 0.0), now));
    assert!(resizable.cancel());
    assert!(!resizable.is_dragging());
    assert_eq!(resizable.presentation(), SashState::Resting);
}
