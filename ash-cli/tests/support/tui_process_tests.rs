use super::LARGE_SIZE;
use super::OUTPUT_LIMIT;
use super::SCREEN_QUIET_PERIOD;
use super::STATE_TIMEOUT;
use super::TerminalCapture;
use super::TerminalOutputState;
use super::TerminalWait;
use super::TerminalWaitFor;
use super::capture_terminal_output;
use super::cpp_runtime_environment;
use portable_pty::ExitStatus;
use std::fs;
use std::io;
use std::io::Read;
use std::io::Write;
use std::sync::Arc;
use std::sync::Mutex;
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

#[test]
fn cpp_runtime_environment_configures_only_the_child() {
    let directory = tempfile::tempdir().unwrap();
    let library = directory.path().join("libstdc++.so.6");
    fs::write(&library, b"runtime fixture").unwrap();
    let inherited = std::env::var_os("LD_LIBRARY_PATH");
    let (name, value) = cpp_runtime_environment(&library);
    let mut command = std::process::Command::new("unused-test-child");
    command.env(name, &value);
    assert_eq!(name, "LD_LIBRARY_PATH");
    assert_eq!(value, directory.path());
    assert_eq!(
        command.get_envs().collect::<Vec<_>>(),
        vec![(std::ffi::OsStr::new(name), Some(value.as_os_str()))]
    );
    assert_eq!(std::env::var_os("LD_LIBRARY_PATH"), inherited);
}

#[test]
#[should_panic(expected = "missing declared C++ runtime")]
fn cpp_runtime_environment_rejects_a_missing_runfile() {
    let directory = tempfile::tempdir().unwrap();
    cpp_runtime_environment(&directory.path().join("libstdc++.so.6"));
}

#[test]
fn queue_readiness_rejects_input_echo_and_pending_rows_during_animation() {
    let start = Instant::now();
    let mut capture = TerminalCapture::new(LARGE_SIZE);
    let mut wait = TerminalWait::new(
        TerminalWaitFor::QueuedMessageReady {
            position: 2,
            text: "restore this draft",
        },
        start,
    );
    capture.push(b"> restore this draft\r\nQueue 1: keep this message \xc2\xb7 next");
    assert!(wait.observe(&capture, None, start).unwrap().is_none());
    capture.push(b"\r\nQueue 2: restore this draft \xc2\xb7 sending");
    for tick in 1..10 {
        capture.push(format!("\x1b[5;1HWorking {tick}").as_bytes());
        assert!(
            wait.observe(&capture, None, start + Duration::from_millis(tick * 100))
                .unwrap()
                .is_none()
        );
    }
    capture.push(b"\x1b[3;1H\x1b[2KQueue 2: restore this draft");
    let acknowledged = start + Duration::from_secs(1);
    assert!(
        wait.observe(&capture, None, acknowledged)
            .unwrap()
            .is_none()
    );
    capture.push(
        format!(
            "\x1b[5;1HWorking /\x1b[3;{}H",
            "Queue 2: restore this draft".len() + 1
        )
        .as_bytes(),
    );
    let screen = wait
        .observe(&capture, None, acknowledged + SCREEN_QUIET_PERIOD)
        .unwrap()
        .unwrap();
    assert!(screen.contains("Working /"));
    assert!(screen.contains("Queue 2: restore this draft"));
    // A later pending state must not reuse the previously acknowledged row.
    capture.push(b" \xc2\xb7 sending");
    assert!(
        wait.observe(
            &capture,
            None,
            acknowledged + SCREEN_QUIET_PERIOD + Duration::from_millis(1)
        )
        .unwrap()
        .is_none()
    );
}

#[test]
fn queue_failure_cannot_complete_a_ready_looking_row() {
    let start = Instant::now();
    let mut capture = TerminalCapture::new(LARGE_SIZE);
    capture.push(
        "Queue 1: keep this message · next\r\ncould not update the queue: request rejected"
            .as_bytes(),
    );
    let mut wait = TerminalWait::new(
        TerminalWaitFor::QueuedMessageReady {
            position: 1,
            text: "keep this message",
        },
        start,
    );
    let error = wait.observe(&capture, None, start).unwrap_err();
    assert!(error.contains("queue operation failed"), "{error}");
    assert!(error.contains("request rejected"), "{error}");
}

#[test]
fn terminal_output_end_or_failure_cannot_satisfy_a_wait_from_the_last_frame() {
    let start = Instant::now();
    for state in [
        TerminalOutputState::Closed,
        TerminalOutputState::Failed("reader failed".into()),
    ] {
        let mut capture = TerminalCapture::new(LARGE_SIZE);
        capture.push(b"Ready");
        capture.output_state = state;
        let mut wait = TerminalWait::new(TerminalWaitFor::ScreenContains("Ready"), start);
        let error = wait.observe(&capture, None, start).unwrap_err();
        assert!(error.contains("while waiting"), "{error}");
        assert!(error.contains("Ready"), "{error}");
        assert!(!error.contains("timed out"), "{error}");
    }
}

#[test]
fn output_pump_retries_interrupted_reads_and_reports_the_actual_read_error() {
    struct ScriptedReader(usize);
    impl Read for ScriptedReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            self.0 += 1;
            match self.0 {
                1 => Err(io::ErrorKind::Interrupted.into()),
                2 => {
                    buffer[..5].copy_from_slice(b"Ready");
                    Ok(5)
                }
                3 => Err(io::Error::other("reader disconnected")),
                _ => panic!("must stop at read failure"),
            }
        }
    }
    let capture = Arc::new(Mutex::new(TerminalCapture::new(LARGE_SIZE)));
    let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(Box::new(io::sink())));
    let state = capture_terminal_output(&mut ScriptedReader(0), &writer, &capture);
    let TerminalOutputState::Failed(error) = state else {
        panic!("expected read failure")
    };
    assert_eq!(error, "PTY output read failed: reader disconnected");
    assert_eq!(capture.lock().unwrap().raw_text(), "Ready");
}

#[test]
fn output_pump_reports_terminal_reply_errors_and_clean_eof_separately() {
    struct BrokenWriter;
    impl Write for BrokenWriter {
        fn write(&mut self, _buffer: &[u8]) -> io::Result<usize> {
            Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "reply pipe closed",
            ))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let capture = Arc::new(Mutex::new(TerminalCapture::new(LARGE_SIZE)));
    let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(Box::new(BrokenWriter)));
    let state = capture_terminal_output(&mut io::Cursor::new(b"\x1b[6n"), &writer, &capture);
    let TerminalOutputState::Failed(error) = state else {
        panic!("expected terminal reply failure")
    };
    assert_eq!(error, "PTY terminal reply failed: reply pipe closed");
    let state = capture_terminal_output(&mut io::empty(), &writer, &capture);
    assert!(matches!(state, TerminalOutputState::Closed));
}

#[test]
fn queue_readiness_waits_for_fragmented_suffix_and_tracks_row_changes_between_polls() {
    let start = Instant::now();
    let mut capture = TerminalCapture::new(LARGE_SIZE);
    let mut wait = TerminalWait::new(
        TerminalWaitFor::QueuedMessageReady {
            position: 2,
            text: "restore this draft",
        },
        start,
    );
    capture.push(b"Queue 2: restore this draft");
    assert!(wait.observe(&capture, None, start).unwrap().is_none());
    // One render can be split at this exact boundary by a PTY read. A complete
    // optimistic row must never be mistaken for an acknowledged one.
    capture.push(" · sending".as_bytes());
    capture.push(b"\r\x1b[2KQueue 2: restore this draft");
    let acknowledged = start + SCREEN_QUIET_PERIOD;
    assert!(
        wait.observe(&capture, None, acknowledged)
            .unwrap()
            .is_none()
    );
    for millis in [50, 100, 150, 200] {
        capture.push(format!("\x1b[5;1HWorking {millis}").as_bytes());
        assert!(
            wait.observe(&capture, None, acknowledged + Duration::from_millis(millis))
                .unwrap()
                .is_none()
        );
    }
    assert!(
        wait.observe(&capture, None, acknowledged + SCREEN_QUIET_PERIOD)
            .unwrap()
            .is_some()
    );
}
