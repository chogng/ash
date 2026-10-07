use std::num::NonZeroU32;

use super::*;

fn policy() -> LanguageServerRestartPolicy {
    LanguageServerRestartPolicy::bounded_exponential(
        NonZeroU32::new(3).unwrap(),
        Duration::from_millis(10),
        Duration::from_millis(25),
        Duration::from_secs(30),
    )
}

#[test]
fn bounded_backoff_caps_and_enters_crash_loop_after_the_restart_budget() {
    let now = Instant::now();
    let mut tracker = ServerRestartTracker::default();

    assert_eq!(
        tracker.failure(now, "one".into(), policy()),
        RestartDecision::Backoff {
            attempt: 1,
            retry_after: Duration::from_millis(10),
        }
    );
    assert_eq!(
        tracker.failure(now, "two".into(), policy()),
        RestartDecision::Backoff {
            attempt: 2,
            retry_after: Duration::from_millis(20),
        }
    );
    assert_eq!(
        tracker.failure(now, "three".into(), policy()),
        RestartDecision::Backoff {
            attempt: 3,
            retry_after: Duration::from_millis(25),
        }
    );
    assert_eq!(
        tracker.failure(now, "four".into(), policy()),
        RestartDecision::CrashLoop {
            restart_attempts: 3,
            message: "four".into(),
        }
    );
}

#[test]
fn a_healthy_window_resets_consecutive_restart_accounting() {
    let now = Instant::now();
    let mut tracker = ServerRestartTracker::default();
    let _ = tracker.failure(now, "first".into(), policy());
    tracker.mark_ready(now);

    assert!(matches!(
        tracker.failure(now + Duration::from_secs(31), "later".into(), policy()),
        RestartDecision::Backoff { attempt: 1, .. }
    ));
}

#[test]
fn never_policy_surfaces_the_first_failure_without_a_retry() {
    let mut tracker = ServerRestartTracker::default();

    assert_eq!(
        tracker.failure(
            Instant::now(),
            "unavailable".into(),
            LanguageServerRestartPolicy::Never,
        ),
        RestartDecision::Failed("unavailable".into())
    );
}
