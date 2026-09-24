//! Thread timeline scroll tests.

use super::{ThreadTimelineScroll, TimelineScrollDelta};

#[test]
fn timeline_scroll_uses_bottom_relative_line_offsets() {
    let mut scroll = ThreadTimelineScroll::default();

    assert!(scroll.scroll(TimelineScrollDelta::Lines(2.0), 20));
    assert_eq!(scroll.offset(), 6);
    assert!(scroll.scroll(TimelineScrollDelta::Lines(-1.0), 20));
    assert_eq!(scroll.offset(), 3);
}

#[test]
fn timeline_scroll_accumulates_trackpad_pixels() {
    let mut scroll = ThreadTimelineScroll::default();

    assert!(!scroll.scroll(TimelineScrollDelta::Pixels(8.0), 20,));
    assert!(scroll.scroll(TimelineScrollDelta::Pixels(14.0), 20,));
    assert_eq!(scroll.offset(), 1);
}
