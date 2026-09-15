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
