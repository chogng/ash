use super::*;

#[test]
fn rejects_traversal_and_platform_specific_absolute_paths() {
    for path in [
        "../file",
        "a/../file",
        "/tmp/file",
        "C:\\file",
        "\\\\host\\share",
    ] {
        assert_eq!(validate_path(path), Err(ExecError::InvalidInput));
    }
    assert_eq!(validate_path("src/main.rs"), Ok(()));
    assert_eq!(validate_path("."), Ok(()));
}

#[test]
fn process_contract_round_trips_and_rejects_unknown_authority_fields() {
    let request = Request::ProcessStart(ProcessStart {
        input: crate::ProcessInput::Closed,
        operation_id: "call-1".into(),
        program: "sh".into(),
        arguments: vec![],
        cwd: ".".into(),
        timeout_millis: 1000,
    });
    let mut value = serde_json::to_value(request).unwrap();
    assert!(serde_json::from_value::<Request>(value.clone()).is_ok());
    value["params"]["authorization"] = serde_json::json!("unrestricted");
    assert!(serde_json::from_value::<Request>(value).is_err());
}

#[test]
fn terminal_start_and_control_round_trip_without_extra_authority() {
    let start = ProcessStart {
        operation_id: "tty".into(),
        program: "sh".into(),
        arguments: vec![],
        cwd: ".".into(),
        timeout_millis: 1000,
        input: ProcessInput::Terminal { rows: 24, cols: 80 },
    };
    assert!(start.validate().is_ok());
    let mut invalid = start.clone();
    invalid.input = ProcessInput::Terminal { rows: 0, cols: 80 };
    assert_eq!(invalid.validate(), Err(ExecError::InvalidInput));
    for request in [
        Request::ProcessStart(start),
        Request::ProcessResize {
            operation_id: "tty".into(),
            rows: 40,
            cols: 100,
        },
        Request::ProcessInterrupt {
            operation_id: "tty".into(),
        },
    ] {
        let value = serde_json::to_value(request).unwrap();
        let decoded: Request = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), value);
    }
}

#[test]
fn process_read_requires_an_explicit_wait_budget() {
    let mut value = serde_json::json!({"method":"processRead", "params":{
        "operationId":"process", "stdoutCursor":0, "stderrCursor":0, "waitMillis":500
    }});
    let request: Request = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(request).unwrap(), value);
    value["params"]
        .as_object_mut()
        .unwrap()
        .remove("waitMillis");
    assert!(serde_json::from_value::<Request>(value).is_err());
}

#[test]
fn file_ranges_and_upload_states_round_trip_without_extra_authority() {
    for request in [
        Request::FileRead {
            path: "file".into(),
            offset: 0,
            expected_revision: None,
        },
        Request::FileReadRelease {
            path: "file".into(),
            revision: "ab".repeat(32),
        },
        Request::FileWriteBegin {
            operation_id: "upload".into(),
            path: "file".into(),
            total_bytes: 3,
            content_revision: "ab".repeat(32),
            condition: WriteCondition::MissingOrEmpty,
        },
        Request::FileWriteChunk {
            operation_id: "upload".into(),
            offset: 0,
            bytes: vec![0, 1, 255],
        },
        Request::FileWriteCommit {
            operation_id: "upload".into(),
        },
        Request::FileWriteAbort {
            operation_id: "upload".into(),
        },
        Request::FileWriteStatus {
            operation_id: "upload".into(),
        },
    ] {
        let mut value = serde_json::to_value(request).unwrap();
        let decoded: Request = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), value);
        value["params"]["authorization"] = serde_json::json!("unrestricted");
        assert!(serde_json::from_value::<Request>(value).is_err());
    }
    for state in [
        FileWriteState::Uploading { next_offset: 3 },
        FileWriteState::Committed {
            revision: "ab".repeat(32),
        },
        FileWriteState::Aborted,
        FileWriteState::OutcomeUnknown,
        FileWriteState::Rejected {
            error: ExecError::Conflict,
        },
    ] {
        let value = serde_json::to_value(Response::FileWrite(state)).unwrap();
        let decoded: Response = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), value);
    }
}

#[test]
fn terminal_ready_and_binary_contract_preserve_process_identity_and_bytes() {
    let created = crate::terminal::TerminalCreateResult {
        terminal_id: "terminal-1".into(),
        ready: crate::terminal::TerminalProcessReady {
            pid: 42,
            cwd: "/workspace".into(),
        },
        profile: crate::terminal::TerminalProfile {
            profile_id: "sh".into(),
            title: "Shell".into(),
            is_default: true,
        },
        reconnect: None,
    };
    let value = serde_json::to_value(&created).unwrap();
    assert_eq!(
        serde_json::from_value::<crate::terminal::TerminalCreateResult>(value).unwrap(),
        created
    );
    let request = crate::terminal::TerminalWriteBinaryRequest {
        terminal_id: created.terminal_id,
        data: vec![0, 0x80, 0xff],
    };
    let value = serde_json::to_value(&request).unwrap();
    assert_eq!(
        serde_json::from_value::<crate::terminal::TerminalWriteBinaryRequest>(value).unwrap(),
        request
    );
}

#[test]
fn terminal_command_line_and_argv_preserve_their_wire_representation() {
    for args in [
        terminal::TerminalArguments::Argv(vec!["".into(), "two words".into(), r#"a"b\"#.into()]),
        terminal::TerminalArguments::CommandLine(
            r#"/d /s /c "echo two words & literal;$HOME""#.into(),
        ),
        terminal::TerminalArguments::CommandLine(String::new()),
    ] {
        let execution = terminal::TerminalExecution::Process {
            program: "cmd.exe".into(),
            args: args.clone(),
        };
        let encoded = serde_json::to_value(&execution).unwrap();
        let decoded: terminal::TerminalExecution = serde_json::from_value(encoded.clone()).unwrap();
        assert_eq!(decoded, execution);
        assert_eq!(
            encoded["Process"]["args"],
            serde_json::to_value(&args).unwrap()
        );
        let profile = terminal::TerminalProfileSelection::Custom {
            name: "Raw shell".into(),
            path: vec!["cmd.exe".into()],
            args,
        };
        let encoded = serde_json::to_value(&profile).unwrap();
        assert_eq!(
            serde_json::from_value::<terminal::TerminalProfileSelection>(encoded).unwrap(),
            profile
        );
    }
}

#[test]
fn terminal_read_cwd_is_optional_for_old_frames_and_preserves_command_context() {
    let value = serde_json::json!({"terminal_id": "terminal", "chunks": [], "next_sequence": 4, "output_gap": false, "command_events": [{"sequence": 1, "command_id": "command", "status": "Completed", "exit_code": null, "after_output_sequence": 4}], "next_command_sequence": 1, "command_event_gap": false, "exited": false, "exit_code": null});
    let mut read: terminal::TerminalReadResult = serde_json::from_value(value.clone()).unwrap();
    assert!(read.cwd.is_none());
    assert!(read.command_events[0].cwd.is_none());
    assert_eq!(serde_json::to_value(&read).unwrap(), value);
    read.cwd = Some(terminal::TerminalCwd {
        value: "/changed; directory".into(),
        is_trusted: Some(true),
        after_output_sequence: 4,
    });
    read.command_events[0].cwd = Some("/invocation".into());
    read.command_events[0].command = Some("echo 中文; echo \"quoted\"".into());
    read.command_events[0].is_trusted = Some(false);
    read.shell_integration = Some(terminal::TerminalShellIntegration {
        command_detection: true,
        cwd_detection: true,
        has_rich_command_detection: true,
        command_storage_disabled: false,
        commands: read.command_events.clone(),
        after_output_sequence: 4,
    });
    let encoded = serde_json::to_value(&read).unwrap();
    assert_eq!(
        serde_json::from_value::<terminal::TerminalReadResult>(encoded).unwrap(),
        read
    );
}
