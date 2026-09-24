use std::time::Duration;
use std::time::Instant;

use super::FrameDeadlineSet;

#[test]
fn deadline_set_keeps_the_earliest_wakeup() {
    let now = Instant::now();
    let later = now + Duration::from_millis(30);
    let earlier = now + Duration::from_millis(10);
    let mut deadlines = FrameDeadlineSet::default();

    deadlines.include(later);
    deadlines.include(earlier);

    assert_eq!(deadlines.next_deadline(), Some(earlier));
    assert!(!deadlines.is_empty());
}

#[test]
fn empty_deadline_set_does_not_request_a_wakeup() {
    assert_eq!(FrameDeadlineSet::default().next_deadline(), None);
    assert!(FrameDeadlineSet::default().is_empty());
}
