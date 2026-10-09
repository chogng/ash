use super::*;

#[test]
fn command_events_are_renderer_independent_and_ordered() {
    let mut tracker = TerminalCommandStatusTracker::new(CommandStatusMode::ShellIntegration);
    tracker.start_active(4);
    let parsed = tracker.parse_output(b"cargo test\r\n\x1b]633;D;1\x07prompt> ".to_vec());
    assert!(matches!(parsed[0], ParsedTerminalOutput::Bytes(_)));
    assert!(matches!(
        parsed[1],
        ParsedTerminalOutput::CommandFinished(Some(1))
    ));
    tracker.finish_active(Some(1), 5);

    let (events, next_sequence, gap) = tracker.read_events(0, 128);
    assert!(!gap);
    assert_eq!(next_sequence, 2);
    assert_eq!(events[0].status, TerminalCommandStatus::Running);
    assert_eq!(events[0].after_output_sequence, 4);
    assert_eq!(events[1].status, TerminalCommandStatus::Failed);
    assert_eq!(events[1].exit_code, Some(1));
}

#[test]
fn split_shell_integration_marker_is_removed_from_visible_output() {
    let mut tracker = TerminalCommandStatusTracker::new(CommandStatusMode::ShellIntegration);
    tracker.start_active(0);
    let first = tracker.parse_output(b"echo ok\r\n\x1b]63".to_vec());
    let second = tracker.parse_output(b"3;D;0\x07prompt> ".to_vec());
    assert!(matches!(
        second.first(),
        Some(ParsedTerminalOutput::CommandFinished(Some(0)))
    ));
    assert_eq!(visible_bytes(first), b"echo ok\r\n");
    assert_eq!(visible_bytes(second), b"prompt> ");
}

fn visible_bytes(parsed: Vec<ParsedTerminalOutput>) -> Vec<u8> {
    parsed
        .into_iter()
        .filter_map(|item| match item {
            ParsedTerminalOutput::Bytes(bytes) => Some(bytes),
            ParsedTerminalOutput::CommandStarted | ParsedTerminalOutput::CommandFinished(_) => None,
        })
        .flatten()
        .collect()
}

#[test]
fn split_start_markers_and_unknown_exit_status_do_not_report_success() {
    let mut tracker = TerminalCommandStatusTracker::new(CommandStatusMode::ShellIntegration);
    tracker.finish_active(Some(0), 1);
    assert!(tracker.read_events(0, 128).0.is_empty());
    for bytes in [b"\x1b]633;".as_slice(), b"C\x1b", b"\\output\x1b]633;D\x07"] {
        for item in tracker.parse_output(bytes.to_vec()) {
            match item {
                ParsedTerminalOutput::CommandStarted => tracker.start_active(2),
                ParsedTerminalOutput::CommandFinished(code) => tracker.finish_active(code, 3),
                ParsedTerminalOutput::Bytes(_) => {}
            }
        }
    }
    let (events, _, _) = tracker.read_events(0, 128);
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].status, TerminalCommandStatus::Running);
    assert_eq!(events[1].status, TerminalCommandStatus::Completed);
    assert_eq!(events[1].exit_code, None);
}

#[test]
fn prompt_only_and_disabled_shells_do_not_create_commands() {
    for mode in [
        CommandStatusMode::ShellIntegration,
        CommandStatusMode::Disabled,
    ] {
        let mut tracker = TerminalCommandStatusTracker::new(mode);
        let parsed = tracker.parse_output(b"\r\n\x1b]633;D;0\x07prompt> ".to_vec());
        for item in parsed {
            if let ParsedTerminalOutput::CommandFinished(code) = item {
                tracker.finish_active(code, 1);
            }
        }
        assert!(tracker.read_events(0, 128).0.is_empty());
    }
}
