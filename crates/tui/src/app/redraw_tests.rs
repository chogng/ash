use super::FRAME_INTERVAL;
use super::RedrawPriority;
use super::RedrawScheduler;
use std::time::Duration;
use std::time::Instant;

#[test]
fn batched_requests_keep_the_first_frame_deadline() {
    let start = Instant::now();
    let mut redraw = RedrawScheduler::default();

    redraw.request(start, RedrawPriority::Batched);
    redraw.request(start + Duration::from_millis(8), RedrawPriority::Batched);

    assert_eq!(redraw.wait_timeout(start), Some(FRAME_INTERVAL));
    assert!(!redraw.take_due(start + Duration::from_millis(15)));
    assert!(redraw.take_due(start + FRAME_INTERVAL));
    assert_eq!(redraw.wait_timeout(start + FRAME_INTERVAL), None);
}

#[test]
fn immediate_requests_pull_a_batched_frame_forward() {
    let start = Instant::now();
    let mut redraw = RedrawScheduler::default();
    redraw.request(start, RedrawPriority::Batched);

    let input_at = start + Duration::from_millis(3);
    redraw.request(input_at, RedrawPriority::Immediate);

    assert_eq!(redraw.wait_timeout(input_at), Some(Duration::ZERO));
    assert!(redraw.take_due(input_at));
    assert!(!redraw.take_due(input_at));
}
