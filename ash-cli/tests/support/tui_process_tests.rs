use super::LARGE_SIZE;
use super::OUTPUT_LIMIT;
use super::SCREEN_QUIET_PERIOD;
use super::STATE_TIMEOUT;
use super::TerminalCapture;
use super::TerminalWait;
use super::TerminalWaitFor;
use portable_pty::ExitStatus;
use std::time::Duration;
use std::time::Instant;

#[test]
fn input_progress_does_not_wait_for_animation_to_be_quiet() {
    let start = Instant::now();
    let mut capture = TerminalCapture::new(LARGE_SIZE);
    capture.push(b"Working |");
    let mut wait = TerminalWait::new(TerminalWaitFor::OutputAfter(capture.revision()), start);
    assert!(wait.observe(&capture, None, start).unwrap().is_none());
    capture.push(b"\rWorking /");
    assert!(
        wait.observe(&capture, None, start + Duration::from_millis(100))
            .unwrap()
            .is_some()
    );
    // This is only output progress. The same frame cannot complete a business-state wait.
    let mut completed = TerminalWait::new(TerminalWaitFor::ScreenContains("Done"), start);
    for index in 1..50 {
        capture.push(if index % 2 == 0 {
            b"\rWorking |"
        } else {
            b"\rWorking /"
        });
        assert!(
            completed
                .observe(&capture, None, start + Duration::from_millis(index * 100))
                .unwrap()
                .is_none()
        );
    }
}

#[test]
fn transient_business_hint_is_observable_during_continuous_animation() {
    let start = Instant::now();
    let mut capture = TerminalCapture::new(LARGE_SIZE);
    let mut hint = TerminalWait::new(TerminalWaitFor::ScreenContains("next: bypass"), start);
    capture.push(b"Working |\r\ncurrent: auto review\r\nnext: bypass");
    for index in 0..50 {
        capture.push(if index % 2 == 0 {
            b"\x1b[1;1HWorking |"
        } else {
            b"\x1b[1;1HWorking /"
        });
        let screen = hint
            .observe(&capture, None, start + Duration::from_millis(index * 100))
            .unwrap()
            .expect("a present hint must not wait for animation to stop");
        assert!(screen.contains("current: auto review"));
        assert!(screen.contains("next: bypass"));
    }
    capture.push(b"\x1b[3;1H\x1b[2K");
    assert!(
        hint.observe(&capture, None, start + Duration::from_secs(5))
            .unwrap()
            .is_none(),
        "an expired hint must not be returned from an earlier matching frame"
    );
}

#[test]
fn stable_snapshot_requires_target_text_but_ignores_style_and_cursor_redraws() {
    let start = Instant::now();
    let mut capture = TerminalCapture::new(LARGE_SIZE);
    capture.push(b"Old screen");
    let mut wait = TerminalWait::new(
        TerminalWaitFor::StableScreenContains("Approval required"),
        start,
    );
    assert!(wait.observe(&capture, None, start).unwrap().is_none());
    assert!(
        wait.observe(&capture, None, start + SCREEN_QUIET_PERIOD)
            .unwrap()
            .is_none()
    );
    capture.push(b"\rApproval required");
    let matched = start + Duration::from_secs(1);
    assert!(wait.observe(&capture, None, matched).unwrap().is_none());
    for millis in [50, 100, 150, 200] {
        capture.push(b"\x1b[?25l\x1b[1;1H\x1b[0m");
        assert!(
            wait.observe(&capture, None, matched + Duration::from_millis(millis))
                .unwrap()
                .is_none()
        );
    }
    let screen = wait
        .observe(&capture, None, matched + SCREEN_QUIET_PERIOD)
        .unwrap()
        .unwrap();
    assert_eq!(screen, capture.screen());
    assert!(screen.contains("Approval required"));
    capture.push(b"\r\x1b[2KLater state");
    assert!(screen.contains("Approval required"));
    assert!(!screen.contains("Later state"));
}

#[test]
fn stable_snapshot_does_not_accept_an_animated_business_state() {
    let start = Instant::now();
    let mut capture = TerminalCapture::new(LARGE_SIZE);
    let mut wait = TerminalWait::new(TerminalWaitFor::StableScreenContains("Working"), start);
    for index in 0..50 {
        capture.push(if index % 2 == 0 {
            b"\rWorking |"
        } else {
            b"\rWorking /"
        });
        assert!(
            wait.observe(&capture, None, start + Duration::from_millis(index * 100))
                .unwrap()
                .is_none()
        );
    }
}

#[test]
fn stable_snapshot_restarts_after_text_changes_and_returns_between_observations() {
    let start = Instant::now();
    let mut capture = TerminalCapture::new(LARGE_SIZE);
    capture.push(b"Done");
    let mut wait = TerminalWait::new(TerminalWaitFor::StableScreenContains("Done"), start);
    assert!(wait.observe(&capture, None, start).unwrap().is_none());
    capture.push(b"\rBusy");
    capture.push(b"\rDone");
    let changed = start + SCREEN_QUIET_PERIOD;
    assert!(wait.observe(&capture, None, changed).unwrap().is_none());
    assert!(
        wait.observe(&capture, None, changed + SCREEN_QUIET_PERIOD)
            .unwrap()
            .is_some()
    );
}

#[test]
fn output_progress_and_screen_waits_survive_diagnostic_capture_truncation() {
    let start = Instant::now();
    let mut capture = TerminalCapture::new(LARGE_SIZE);
    capture.raw.resize(OUTPUT_LIMIT, b'x');
    let mut output = TerminalWait::new(TerminalWaitFor::OutputAfter(capture.revision()), start);
    let mut screen = TerminalWait::new(TerminalWaitFor::StableScreenContains("Ready"), start);
    capture.push(b"Ready");
    assert!(output.observe(&capture, None, start).unwrap().is_some());
    assert!(screen.observe(&capture, None, start).unwrap().is_none());
    capture.push(b"\x1b[0m");
    assert!(
        screen
            .observe(&capture, None, start + SCREEN_QUIET_PERIOD)
            .unwrap()
            .is_some()
    );
    assert_eq!(capture.raw.len(), OUTPUT_LIMIT);
}

#[test]
fn exit_takes_priority_over_output_progress_and_matching_last_frame() {
    let start = Instant::now();
    let mut capture = TerminalCapture::new(LARGE_SIZE);
    capture.push(b"Done");
    for condition in [
        TerminalWaitFor::OutputAfter(0),
        TerminalWaitFor::ScreenContains("Done"),
        TerminalWaitFor::StableScreenContains("Done"),
        TerminalWaitFor::StableScreenOmits("Working"),
    ] {
        let mut wait = TerminalWait::new(condition, start);
        let _ = wait.observe(&capture, None, start).unwrap();
        let error = wait
            .observe(
                &capture,
                Some(ExitStatus::with_exit_code(0)),
                start + SCREEN_QUIET_PERIOD,
            )
            .unwrap_err();
        assert!(error.contains("TUI exited"), "{error}");
        assert!(error.contains("Done"), "{error}");
        assert!(error.contains("raw:"), "{error}");
    }
}

#[test]
fn omission_wait_restarts_when_the_marker_returns() {
    let start = Instant::now();
    let mut capture = TerminalCapture::new(LARGE_SIZE);
    let mut wait = TerminalWait::new(TerminalWaitFor::StableScreenOmits("hint"), start);
    assert!(wait.observe(&capture, None, start).unwrap().is_none());
    capture.push(b"hint");
    assert!(
        wait.observe(&capture, None, start + SCREEN_QUIET_PERIOD)
            .unwrap()
            .is_none()
    );
    capture.push(b"\r\x1b[2K");
    let removed = start + Duration::from_secs(1);
    assert!(wait.observe(&capture, None, removed).unwrap().is_none());
    assert!(
        wait.observe(&capture, None, removed + SCREEN_QUIET_PERIOD)
            .unwrap()
            .is_some()
    );
}

#[test]
fn timeout_reports_the_unsatisfied_condition_and_captured_output() {
    let start = Instant::now();
    let mut capture = TerminalCapture::new(LARGE_SIZE);
    capture.push(b"Working");
    let mut wait = TerminalWait::new(TerminalWaitFor::ScreenContains("Done"), start);
    let error = wait
        .observe(&capture, None, start + STATE_TIMEOUT)
        .unwrap_err();
    for expected in ["timed out", "Done", "Working", "raw:"] {
        assert!(error.contains(expected), "{error}");
    }
}
