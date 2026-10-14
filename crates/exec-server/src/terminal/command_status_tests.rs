use super::*;

#[test]
fn command_events_are_renderer_independent_and_ordered() {
    let mut tracker = TerminalCommandStatusTracker::new(CommandStatusMode::ShellIntegration, None);
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
    let mut tracker = TerminalCommandStatusTracker::new(CommandStatusMode::ShellIntegration, None);
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
            ParsedTerminalOutput::CommandStarted
            | ParsedTerminalOutput::CommandFinished(_)
            | ParsedTerminalOutput::Cwd(_, _)
            | ParsedTerminalOutput::CommandLine(_, _)
            | ParsedTerminalOutput::PromptStart
            | ParsedTerminalOutput::RichCommandDetection(_)
            | ParsedTerminalOutput::CommandStorageDisabled
            | ParsedTerminalOutput::PromptType(_)
            | ParsedTerminalOutput::ShellIntegration(_) => None,
        })
        .flatten()
        .collect()
}

#[test]
fn split_start_markers_and_unknown_exit_status_do_not_report_success() {
    let mut tracker = TerminalCommandStatusTracker::new(CommandStatusMode::ShellIntegration, None);
    tracker.finish_active(Some(0), 1);
    assert!(tracker.read_events(0, 128).0.is_empty());
    for bytes in [b"\x1b]633;".as_slice(), b"C\x1b", b"\\output\x1b]633;D\x07"] {
        for item in tracker.parse_output(bytes.to_vec()) {
            match item {
                ParsedTerminalOutput::CommandStarted => tracker.start_active(2),
                ParsedTerminalOutput::CommandFinished(code) => tracker.finish_active(code, 3),
                ParsedTerminalOutput::Bytes(_) | ParsedTerminalOutput::ShellIntegration(_) => {}
                ParsedTerminalOutput::Cwd(value, trusted) => tracker.record_cwd(value, trusted, 2),
                ParsedTerminalOutput::CommandLine(command, trusted) => {
                    tracker.record_command_line(command, trusted, 2)
                }
                ParsedTerminalOutput::PromptStart => tracker.record_prompt(2),
                ParsedTerminalOutput::RichCommandDetection(rich) => {
                    tracker.record_rich_detection(rich, 2)
                }
                ParsedTerminalOutput::CommandStorageDisabled => tracker.disable_command_storage(2),
                ParsedTerminalOutput::PromptType(value) => tracker.record_prompt_type(value, 2),
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
        let mut tracker = TerminalCommandStatusTracker::new(mode, None);
        let parsed = tracker.parse_output(b"\r\n\x1b]633;D;0\x07prompt> ".to_vec());
        for item in parsed {
            if let ParsedTerminalOutput::CommandFinished(code) = item {
                tracker.finish_active(code, 1);
            }
        }
        assert!(tracker.read_events(0, 128).0.is_empty());
    }
}

#[test]
fn prompt_markers_and_fragmented_cwd_preserve_command_invocation_directory() {
    let mut tracker = TerminalCommandStatusTracker::new(CommandStatusMode::ShellIntegration, None);
    let stream = b"\x1b]633;A\x07\x1b]633;P;Cwd=/work/a\\x3bb\\\\c\x1b\\prompt> \x1b]633;B\x07\x1b]633;C\x07\x1b]633;C\x07output\x1b]633;D;23\x07\x1b]633;P;Cwd=/other\x07";
    let mut visible = Vec::new();
    for byte in stream {
        for item in tracker.parse_output(vec![*byte]) {
            match item {
                ParsedTerminalOutput::Bytes(bytes) => visible.extend(bytes),
                ParsedTerminalOutput::ShellIntegration(_) => {}
                ParsedTerminalOutput::Cwd(value, trusted) => tracker.record_cwd(value, trusted, 4),
                ParsedTerminalOutput::CommandLine(command, trusted) => {
                    tracker.record_command_line(command, trusted, 4)
                }
                ParsedTerminalOutput::PromptStart => tracker.record_prompt(4),
                ParsedTerminalOutput::RichCommandDetection(rich) => {
                    tracker.record_rich_detection(rich, 4)
                }
                ParsedTerminalOutput::CommandStorageDisabled => tracker.disable_command_storage(4),
                ParsedTerminalOutput::PromptType(value) => tracker.record_prompt_type(value, 4),
                ParsedTerminalOutput::CommandStarted => tracker.start_active(4),
                ParsedTerminalOutput::CommandFinished(code) => tracker.finish_active(code, 5),
            }
        }
    }
    assert_eq!(visible, b"prompt> output");
    assert_eq!(tracker.cwd().unwrap().value, "/other");
    let (events, _, _) = tracker.read_events(0, 128);
    assert_eq!(events.len(), 2);
    assert_eq!(events[1].exit_code, Some(23));
    assert_eq!(events[0].cwd.as_deref(), Some("/work/a;b\\c"));
    assert_eq!(events[1].cwd, events[0].cwd);
}

#[test]
fn escape_decoder_handles_literal_backslash_hex_unicode_and_missing_status() {
    for (encoded, expected) in [
        (r"/work/a\x3Bb", "/work/a;b"),
        (r"C:\\work\\file", r"C:\work\file"),
        (r"/work/\\x3b", r"/work/\x3b"),
        (r"/work/a\x0ab", "/work/a\nb"),
        ("/中文/🙂", "/中文/🙂"),
        (r"/work/\xzz", r"/work/\xzz"),
    ] {
        let mut tracker =
            TerminalCommandStatusTracker::new(CommandStatusMode::ShellIntegration, None);
        let parsed =
            tracker.parse_output(format!("\x1b]633;P;Cwd={encoded};nonce\x07").into_bytes());
        assert!(matches!(&parsed[0], ParsedTerminalOutput::Cwd(value, false) if value == expected));
    }
    let mut tracker = TerminalCommandStatusTracker::new(CommandStatusMode::ShellIntegration, None);
    tracker.start_active(0);
    let parsed = tracker.parse_output(b"\x1b]633;D\x07".to_vec());
    assert!(matches!(
        parsed[0],
        ParsedTerminalOutput::CommandFinished(None)
    ));
    tracker.finish_active(None, 1);
    assert_eq!(
        tracker.read_events(0, 10).0[1].status,
        TerminalCommandStatus::Completed
    );
}

#[test]
fn unknown_and_oversized_unowned_osc_preserve_output_without_mutating_commands() {
    for bytes in [
        b"\x1b]633;D;garbage\x07".to_vec(),
        b"\x1b]633;F;unfinalized\x07".to_vec(),
        [
            b"\x1b]633;Unknown=".as_slice(),
            &vec![b'x'; MAX_OSC_BYTES + 1],
            b"\x07tail",
        ]
        .concat(),
    ] {
        let mut tracker =
            TerminalCommandStatusTracker::new(CommandStatusMode::ShellIntegration, None);
        let parsed = tracker.parse_output(bytes.clone());
        assert_eq!(visible_bytes(parsed), bytes);
        assert!(tracker.cwd().is_none());
        assert!(tracker.read_events(0, 128).0.is_empty());
    }
    let mut tracker = TerminalCommandStatusTracker::new(CommandStatusMode::ShellIntegration, None);
    let open = [b"\x1b]633;".as_slice(), &vec![b'x'; MAX_OSC_BYTES + 1]].concat();
    assert_eq!(visible_bytes(tracker.parse_output(open.clone())), open);
    assert!(tracker.flush_output().is_empty());
    assert!(matches!(
        tracker.parse_output(b"\x1b]633;C\x07".to_vec())[0],
        ParsedTerminalOutput::CommandStarted
    ));
}

#[test]
fn malformed_and_oversized_owned_metadata_never_reflect_values_or_nonce() {
    for bytes in [
        b"\x1b]633;P;Cwd=\x07".to_vec(),
        b"\x1b]633;P;Cwd=/nul\\x00arg\x07".to_vec(),
        b"\x1b]633;E;bad\\x00value;nonce\x07".to_vec(),
        [
            b"\x1b]633;EnvJson;".as_slice(),
            &vec![b'x'; MAX_OSC_BYTES + 1],
            b";nonce\x07",
        ]
        .concat(),
    ] {
        let mut tracker =
            TerminalCommandStatusTracker::new(CommandStatusMode::ShellIntegration, None);
        assert!(visible_bytes(tracker.parse_output(bytes)).is_empty());
        assert!(tracker.cwd().is_none());
        assert!(tracker.read_events(0, 128).0.is_empty());
    }
    let mut tracker = TerminalCommandStatusTracker::new(CommandStatusMode::ShellIntegration, None);
    let open = [
        b"\x1b]633;EnvSingleEntry;TOKEN;".as_slice(),
        &vec![b'x'; MAX_OSC_BYTES + 1],
    ]
    .concat();
    let parsed = tracker.parse_output(open);
    assert!(matches!(
        parsed.first(),
        Some(ParsedTerminalOutput::ShellIntegration(
            TerminalShellIntegrationEvent::Environment {
                values: None,
                is_trusted: false,
            }
        ))
    ));
    assert!(tracker.pending_output.is_empty());
    assert!(visible_bytes(tracker.parse_output(b"secret;nonce\x1b".to_vec())).is_empty());
    assert_eq!(
        visible_bytes(tracker.parse_output(b"\\visible\x1b]633;B\x07tail".to_vec())),
        b"visibletail"
    );
    tracker.parse_output(b"\x1b]633;E;unfinished;nonce".to_vec());
    assert!(tracker.flush_output().is_empty());
}

#[test]
fn environment_end_accepts_the_standard_empty_final_field_without_weakening_nonce_checks() {
    let mut tracker = TerminalCommandStatusTracker::new(
        CommandStatusMode::ShellIntegration,
        Some("private-nonce".into()),
    );
    assert!(matches!(
        tracker
            .parse_output(b"\x1b]633;EnvSingleEnd;private-nonce;\x07".to_vec())
            .first(),
        Some(ParsedTerminalOutput::ShellIntegration(
            TerminalShellIntegrationEvent::EnvironmentEnd { is_trusted: true }
        ))
    ));
    assert!(matches!(
        tracker
            .parse_output(b"\x1b]633;EnvSingleEnd;wrong;\x07".to_vec())
            .first(),
        Some(ParsedTerminalOutput::ShellIntegration(
            TerminalShellIntegrationEvent::EnvironmentEnd { is_trusted: false }
        ))
    ));
}

fn apply_metadata(tracker: &mut TerminalCommandStatusTracker, bytes: &[u8], sequence: u64) {
    for item in tracker.parse_output(bytes.to_vec()) {
        match item {
            ParsedTerminalOutput::Bytes(_) | ParsedTerminalOutput::ShellIntegration(_) => {}
            ParsedTerminalOutput::Cwd(value, trusted) => {
                tracker.record_cwd(value, trusted, sequence)
            }
            ParsedTerminalOutput::CommandLine(command, trusted) => {
                tracker.record_command_line(command, trusted, sequence)
            }
            ParsedTerminalOutput::PromptStart => tracker.record_prompt(sequence),
            ParsedTerminalOutput::PromptType(value) => tracker.record_prompt_type(value, sequence),
            ParsedTerminalOutput::RichCommandDetection(rich) => {
                tracker.record_rich_detection(rich, sequence)
            }
            ParsedTerminalOutput::CommandStorageDisabled => {
                tracker.disable_command_storage(sequence)
            }
            ParsedTerminalOutput::CommandStarted => tracker.start_active(sequence),
            ParsedTerminalOutput::CommandFinished(code) => tracker.finish_active(code, sequence),
        }
    }
}

#[test]
fn command_text_nonce_and_cwd_trust_survive_fragmentation_without_trusting_missing_or_old_nonces() {
    for (suffix, trusted) in [(";session-nonce", true), (";old-nonce", false), ("", false)] {
        let mut tracker = TerminalCommandStatusTracker::new(
            CommandStatusMode::ShellIntegration,
            Some("session-nonce".into()),
        );
        let input = format!(
            "\x1b]633;A\x07\x1b]633;P;Cwd=/work\\x3ba{suffix}\x07\x1b]633;P;HasRichCommandDetection=True\x07\x1b]633;E;echo\\x20🙂\\x3b\\x20printf\\x20'\\x0a'{suffix}\x1b\\\x1b]633;C\x07\x1b]633;C\x07\x1b]633;D;17\x07"
        );
        for byte in input.bytes() {
            apply_metadata(&mut tracker, &[byte], 8);
        }
        let events = tracker.read_events(0, 128).0;
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].command.as_deref(), Some("echo 🙂; printf '\n'"));
        assert_eq!(events[1].is_trusted, Some(trusted));
        assert_eq!(tracker.cwd().unwrap().is_trusted, Some(trusted));
        let integration = tracker.shell_integration().unwrap();
        assert!(
            integration.command_detection
                && integration.cwd_detection
                && integration.has_rich_command_detection
        );
        assert_eq!(integration.after_output_sequence, 8);
        assert_eq!(integration.commands, vec![events[1].clone()]);
        assert!(!format!("{integration:?}").contains("session-nonce"));
    }
    let mut tracker = TerminalCommandStatusTracker::new(CommandStatusMode::ShellIntegration, None);
    apply_metadata(
        &mut tracker,
        b"\x1b]633;E;echo;\x07\x1b]633;C\x07\x1b]633;D\x07",
        0,
    );
    assert_eq!(
        tracker.shell_integration().unwrap().commands[0].is_trusted,
        Some(false)
    );
}

#[test]
fn late_text_updates_only_the_active_command_and_prompt_abandons_pending_text() {
    let mut tracker = TerminalCommandStatusTracker::new(
        CommandStatusMode::ShellIntegration,
        Some("nonce".into()),
    );
    apply_metadata(
        &mut tracker,
        b"\x1b]633;E;abandoned;nonce\x07\x1b]633;A\x07\x1b]633;C\x07",
        1,
    );
    assert_eq!(tracker.read_events(0, 128).0[0].command, None);
    apply_metadata(
        &mut tracker,
        b"\x1b]633;E;late\\x3btext;nonce\x07\x1b]633;D\x07\x1b]633;C\x07\x1b]633;D;0\x07",
        2,
    );
    let history = tracker.shell_integration().unwrap().commands;
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].command.as_deref(), Some("late;text"));
    assert_eq!(history[0].is_trusted, Some(true));
    assert_eq!(history[0].status, TerminalCommandStatus::Completed);
    assert_eq!(history[1].command, None);
}

#[test]
fn completed_history_is_bounded_and_task_opt_out_removes_text_without_breaking_status() {
    let mut tracker = TerminalCommandStatusTracker::new(
        CommandStatusMode::ShellIntegration,
        Some("nonce".into()),
    );
    for index in 0..300 {
        tracker.record_command_line(format!("command {index}"), true, index);
        tracker.start_active(index);
        tracker.finish_active(Some(0), index);
    }
    let history = tracker.shell_integration().unwrap().commands;
    assert_eq!(history.len(), MAX_HISTORY_COMMANDS);
    assert_eq!(history[0].command.as_deref(), Some("command 44"));
    tracker.record_command_line("running".into(), true, 301);
    tracker.start_active(301);
    apply_metadata(
        &mut tracker,
        b"\x1b]633;P;Task=build\x07\x1b]633;E;private;nonce\x07\x1b]633;D;1\x07",
        302,
    );
    let integration = tracker.shell_integration().unwrap();
    assert!(integration.command_storage_disabled);
    assert!(integration.commands.is_empty());
    let events = tracker.read_events(0, 1024).0;
    assert!(
        events
            .iter()
            .all(|event| event.command.is_none() && event.is_trusted.is_none())
    );
    assert_eq!(events.last().unwrap().exit_code, Some(1));

    let mut tracker = TerminalCommandStatusTracker::new(CommandStatusMode::ShellIntegration, None);
    for index in 0..40 {
        tracker.record_command_line("x".repeat(32768), false, index);
        tracker.start_active(index);
        tracker.finish_active(Some(0), index);
    }
    let integration = tracker.shell_integration().unwrap();
    assert!(integration.commands.len() <= 16);
    assert!(tracker.read_events(0, 1024).2);
    assert!(
        integration
            .commands
            .iter()
            .map(command_record_bytes)
            .sum::<usize>()
            <= MAX_COMMAND_RECORD_BYTES
    );

    let mut tracker = TerminalCommandStatusTracker::new(CommandStatusMode::ShellIntegration, None);
    tracker.record_cwd("x".repeat(32768), false, 0);
    for index in 0..40 {
        tracker.record_command_line("\n".repeat(32768), false, index);
        tracker.start_active(index);
        tracker.finish_active(Some(0), index);
    }
    let history = tracker.shell_integration().unwrap();
    let events = tracker.read_events(0, 1024).0;
    assert!(serde_json::to_vec(&history).unwrap().len() <= MAX_COMMAND_RECORD_BYTES);
    assert!(serde_json::to_vec(&events).unwrap().len() <= MAX_COMMAND_RECORD_BYTES);
    assert!(
        serde_json::to_vec(&(history, events)).unwrap().len()
            < exec_server_protocol::MAX_FRAME_BYTES
    );
}

#[test]
fn prompt_type_is_fragmented_display_metadata_retained_at_its_output_boundary() {
    let mut tracker = TerminalCommandStatusTracker::new(
        CommandStatusMode::ShellIntegration,
        Some("private-nonce".into()),
    );
    for byte in b"\x1b]633;P;PromptType=starship\x07" {
        apply_metadata(&mut tracker, &[*byte], 9);
    }
    let integration = tracker.shell_integration().unwrap();
    assert_eq!(integration.prompt_type.as_deref(), Some("starship"));
    assert_eq!(integration.after_output_sequence, 9);
    assert!(!integration.command_detection);
    assert!(integration.commands.is_empty());
    // A framework change replaces the current display value, including explicit reset.
    apply_metadata(&mut tracker, b"\x1b]633;P;PromptType=\x07", 12);
    assert_eq!(
        tracker.shell_integration().unwrap().prompt_type.as_deref(),
        Some("")
    );
    let malformed = b"\x1b]633;P;PromptType=bad\\x0avalue;private-nonce\x07";
    assert!(visible_bytes(tracker.parse_output(malformed.to_vec())).is_empty());
    assert_eq!(
        tracker.shell_integration().unwrap().after_output_sequence,
        12
    );
}

#[test]
fn environment_frames_decode_unicode_and_never_forward_nonce_or_malformed_values() {
    let mut tracker = TerminalCommandStatusTracker::new(
        CommandStatusMode::ShellIntegration,
        Some("private-nonce".into()),
    );
    let stream = b"\x1b]633;EnvSingleStart;1;private-nonce\x07\x1b]633;EnvSingleEntry;NAME;value\\x3b\\x0aline;private-nonce\x07\x1b]633;EnvSingleEnd;wrong\x07";
    let mut frames = Vec::new();
    for byte in stream {
        for event in tracker.parse_output(vec![*byte]) {
            if let ParsedTerminalOutput::ShellIntegration(event) = event {
                frames.push(event);
            }
        }
    }
    assert_eq!(
        frames,
        vec![
            TerminalShellIntegrationEvent::EnvironmentStart {
                clear: true,
                is_trusted: true
            },
            TerminalShellIntegrationEvent::EnvironmentEntry {
                key: "NAME".into(),
                value: Some("value;\nline".into()),
                is_trusted: true
            },
            TerminalShellIntegrationEvent::EnvironmentEnd { is_trusted: false },
        ]
    );
    assert!(!format!("{frames:?}").contains("private-nonce"));
    let invalid = tracker.parse_output(b"\x1b]633;EnvJson;{bad;private-nonce\x07".to_vec());
    assert!(matches!(
        &invalid[0],
        ParsedTerminalOutput::ShellIntegration(TerminalShellIntegrationEvent::Environment {
            values: None,
            is_trusted: false
        })
    ));
}

#[test]
fn oversized_environment_transactions_become_unavailable_instead_of_partial_trusted_values() {
    let mut tracker = TerminalCommandStatusTracker::new(
        CommandStatusMode::ShellIntegration,
        Some("nonce".into()),
    );
    tracker.parse_output(b"\x1b]633;EnvSingleStart;1;nonce\x07".to_vec());
    let mut aborted = false;
    for index in 0..513 {
        for event in tracker.parse_output(
            format!("\x1b]633;EnvSingleEntry;KEY{index};value;nonce\x07").into_bytes(),
        ) {
            aborted |= matches!(
                event,
                ParsedTerminalOutput::ShellIntegration(
                    TerminalShellIntegrationEvent::Environment {
                        values: None,
                        is_trusted: false
                    }
                )
            );
        }
    }
    assert!(aborted);
}
