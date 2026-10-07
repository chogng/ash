use std::time::Duration;

use super::RestartDecision;
use super::RestartPolicy;
use super::RestartTracker;

fn policy() -> RestartPolicy {
    RestartPolicy {
        maximum_restarts: 3,
        window: Duration::from_secs(10),
        initial_delay: Duration::from_millis(10),
        maximum_delay: Duration::from_millis(40),
    }
}

#[test]
fn exponential_backoff_is_bounded_and_enters_crash_loop() {
    let mut tracker = RestartTracker::new(policy()).unwrap();
    assert_eq!(
        tracker.record_failure(Duration::ZERO),
        RestartDecision::RestartAfter(Duration::from_millis(10))
    );
    assert_eq!(
        tracker.record_failure(Duration::from_secs(1)),
        RestartDecision::RestartAfter(Duration::from_millis(20))
    );
    assert_eq!(
        tracker.record_failure(Duration::from_secs(2)),
        RestartDecision::RestartAfter(Duration::from_millis(40))
    );
    assert_eq!(
        tracker.record_failure(Duration::from_secs(3)),
        RestartDecision::CrashLoop
    );
}

#[test]
fn expired_window_and_healthy_period_allow_bounded_restart_again() {
    let mut tracker = RestartTracker::new(policy()).unwrap();
    tracker.record_failure(Duration::ZERO);
    tracker.record_failure(Duration::from_secs(1));
    tracker.record_healthy();
    assert_eq!(
        tracker.record_failure(Duration::from_secs(11)),
        RestartDecision::RestartAfter(Duration::from_millis(10))
    );
}
