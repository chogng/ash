use std::time::{Duration, Instant};

use super::TerminalScroll;
use zui::input::{MouseScrollDelta, PhysicalPosition};

#[test]
fn line_wheel_moves_within_the_available_history() {
    let mut scroll = TerminalScroll::default();

    assert!(scroll.scroll(MouseScrollDelta::LineDelta(0.0, 1.0), 8));
    assert_eq!(scroll.offset(), 3);
    assert!(scroll.scroll(MouseScrollDelta::LineDelta(0.0, 10.0), 8));
    assert_eq!(scroll.offset(), 8);
    assert!(scroll.scroll(MouseScrollDelta::LineDelta(0.0, -1.0), 8));
    assert_eq!(scroll.offset(), 5);
}

#[test]
fn pixel_wheel_accumulates_sub_line_motion() {
    let mut scroll = TerminalScroll::default();

    assert!(!scroll.scroll(
        MouseScrollDelta::PixelDelta(PhysicalPosition::new(0.0, 6.0)),
        8,
    ));
    assert!(!scroll.scroll(
        MouseScrollDelta::PixelDelta(PhysicalPosition::new(0.0, 6.0)),
        8,
    ));
    assert!(scroll.scroll(
        MouseScrollDelta::PixelDelta(PhysicalPosition::new(0.0, 6.0)),
        8,
    ));
    assert_eq!(scroll.offset(), 1);
}

#[test]
fn retained_view_stays_anchored_when_output_grows() {
    let mut scroll = TerminalScroll::default();
    scroll.scroll(MouseScrollDelta::LineDelta(0.0, 1.0), 20);

    scroll.preserve_view_after_growth(2, 22);
    assert_eq!(scroll.offset(), 5);

    scroll.reset();
    scroll.preserve_view_after_growth(2, 22);
    assert_eq!(scroll.offset(), 0);
}

#[test]
fn scrollbar_reveals_after_activity_and_can_be_cancelled() {
    let mut scroll = TerminalScroll::default();
    let now = Instant::now();

    scroll.scrollbar_activity(now);
    assert!(scroll.scrollbar_deadline().is_some());
    assert!(scroll.advance_scrollbar(now + Duration::from_millis(150)));
    assert_eq!(scroll.scrollbar_presentation().opacity(), 1.0);

    scroll.cancel_scrollbar();
    assert_eq!(scroll.scrollbar_presentation().opacity(), 0.0);
    assert_eq!(scroll.scrollbar_deadline(), None);
}
