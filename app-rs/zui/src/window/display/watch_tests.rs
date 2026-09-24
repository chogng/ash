use std::time::Duration;
use std::time::Instant;

use super::PollSchedule;

#[test]
fn polling_deadline_advances_only_after_it_becomes_due() {
    let now = Instant::now();
    let interval = Duration::from_secs(1);
    let mut schedule = PollSchedule::new(now, interval);

    assert_eq!(schedule.deadline(), now + interval);
    assert!(!schedule.take_due(now + Duration::from_millis(999)));
    assert_eq!(schedule.deadline(), now + interval);
    assert!(schedule.take_due(now + interval));
    assert_eq!(schedule.deadline(), now + interval + interval);
}

#[test]
fn delayed_poll_reschedules_from_observation_time_without_a_catch_up_loop() {
    let now = Instant::now();
    let interval = Duration::from_secs(1);
    let delayed = now + Duration::from_secs(10);
    let mut schedule = PollSchedule::new(now, interval);

    assert!(schedule.take_due(delayed));
    assert_eq!(schedule.deadline(), delayed + interval);
    assert!(!schedule.take_due(delayed));
}
