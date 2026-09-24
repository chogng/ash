use std::time::{Duration, Instant};

use super::*;

#[test]
fn selection_auto_scroll_repeats_until_the_pointer_returns_inside() {
    let mut state = FileEditorAutoScrollState::default();
    let now = Instant::now();
    let bounds = Rect::from_xywh(0.0, 20.0, 200.0, 100.0);

    state.update(Point::new(80.0, 115.0), bounds, now);
    assert_eq!(state.advance(now), FileEditorAutoScrollDirection::Down);
    assert_eq!(
        state.advance(now + Duration::from_millis(20)),
        FileEditorAutoScrollDirection::Idle
    );
    assert_eq!(
        state.advance(now + Duration::from_millis(35)),
        FileEditorAutoScrollDirection::Down
    );

    state.update(Point::new(80.0, 80.0), bounds, now);
    assert_eq!(state.deadline(), None);
}
