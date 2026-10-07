use std::cell::Cell;
use std::cell::RefCell;
use std::time::Duration;

use super::Failure;
use super::WINDOW;
use super::delay;
use super::recovery_error;
use super::retry;

#[test]
fn transport_failures_retry_with_bounded_backoff_until_success() {
    let elapsed = Cell::new(Duration::ZERO);
    let attempts = Cell::new(0_usize);
    let reports = RefCell::new(Vec::new());

    let result = retry(
        "App Server",
        "initial disconnect",
        || {
            let attempt = attempts.get() + 1;
            attempts.set(attempt);
            if attempt < 3 {
                Err(Failure::Retryable(format!("transport failure {attempt}")))
            } else {
                Ok("ready")
            }
        },
        |delay| elapsed.set(elapsed.get() + delay),
        || elapsed.get(),
        |attempt, delay| reports.borrow_mut().push((attempt, delay)),
    )
    .unwrap();

    assert_eq!(result, "ready");
    assert_eq!(attempts.get(), 3);
    assert_eq!(
        reports.into_inner(),
        vec![
            (1, Duration::from_millis(250)),
            (2, Duration::from_millis(500)),
            (3, Duration::from_secs(1)),
        ]
    );
}

#[test]
fn protocol_change_stops_without_more_retries() {
    let attempts = Cell::new(0_usize);
    let error = retry::<()>(
        "App Server",
        "initial disconnect",
        || {
            attempts.set(attempts.get() + 1);
            Err(Failure::Terminal("schema changed".into()))
        },
        |_| {},
        || Duration::ZERO,
        |_, _| {},
    )
    .unwrap_err();

    assert_eq!(attempts.get(), 1);
    assert_eq!(error, "schema changed");
}

#[test]
fn exhausted_window_does_not_start_an_unbounded_attempt() {
    let attempts = Cell::new(0_usize);
    let error = retry::<()>(
        "App Server",
        "stream closed",
        || {
            attempts.set(attempts.get() + 1);
            Err(Failure::Retryable("still closed".into()))
        },
        |_| {},
        || WINDOW,
        |_, _| {},
    )
    .unwrap_err();

    assert_eq!(attempts.get(), 0);
    assert!(error.contains("within 30 seconds after 0 attempts"));
    assert!(error.contains("stream closed"));
    assert_eq!(delay(10), Duration::from_secs(2));
}

#[test]
fn recovery_error_prints_a_copyable_shell_command() {
    let error = recovery_error(
        "connection failed",
        &[
            "ash".into(),
            "resume".into(),
            "session with spaces".into(),
            "thread'quoted".into(),
        ],
    );

    assert_eq!(
        error,
        "connection failed\nReconnect: ash resume 'session with spaces' 'thread'\\''quoted'"
    );
}
