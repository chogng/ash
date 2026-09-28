use super::StatusTimer;
use ash_protocol::TurnId;
use std::time::Duration;
use std::time::Instant;

#[test]
fn same_turn_retains_total_time_and_new_turn_resets_it() {
    let now = Instant::now();
    let mut timer = StatusTimer::default();
    let first = TurnId::new("first").unwrap();
    timer.start(now);
    assert_eq!(timer.runs_started(), 1);
    timer.bind_turn(&first, now + Duration::from_secs(1));
    timer.tick(now + Duration::from_secs(65));
    assert_eq!(timer.elapsed(), Duration::from_secs(65));
    timer.bind_turn(&first, now + Duration::from_secs(90));
    assert_eq!(timer.runs_started(), 1);
    timer.tick(now + Duration::from_secs(100));
    assert_eq!(timer.elapsed(), Duration::from_secs(100));
    timer.bind_turn(
        &TurnId::new("second").unwrap(),
        now + Duration::from_secs(101),
    );
    assert_eq!(timer.elapsed(), Duration::ZERO);
    assert_eq!(timer.runs_started(), 2);
    timer.clear();
    assert!(!timer.tick(now + Duration::from_secs(200)));
    assert_eq!(timer.runs_started(), 2);
    timer.start(now + Duration::from_secs(201));
    assert_eq!(timer.runs_started(), 3);
}
