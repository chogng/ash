use super::*;

#[test]
fn command_events_are_renderer_independent_and_ordered() {
    let mut tracker = TerminalCommandStatusTracker::new(true);
    tracker.note_input("cargo test\r", 4);
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
    let mut tracker = TerminalCommandStatusTracker::new(true);
    tracker.note_input("echo ok\r", 0);
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
            ParsedTerminalOutput::CommandFinished(_) => None,
        })
        .flatten()
        .collect()
}
