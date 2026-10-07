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
