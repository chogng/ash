use std::io::BufRead;
use std::io::BufReader;
use std::io::Write;

use ash_app_server_protocol::schema_hash;

use super::diagnostic_error;
use super::validate_managed_response;
use crate::endpoint::EndpointPaths;
use crate::process::ProcessRecord;
use crate::process::ProcessRecordGuard;
use crate::wire::ControlResponse;
use crate::wire::ControlState;

#[test]
fn stopping_connection_returns_the_request_identity_and_structured_cause() {
    let mut output = Vec::new();
    super::reject_stopping_connection(
        br#"{"jsonrpc":"2.0","id":42,"method":"initialize","params":{}}
"#
        .as_slice(),
        &mut output,
    )
    .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&output).unwrap(),
        serde_json::json!({
            "jsonrpc":"2.0", "id":42,
            "error":{"code":-32600,"message":"Local App Server daemon is stopping","data":{"kind":"ServerShuttingDown"}}
        })
    );
    let mut output = Vec::new();
    assert!(super::reject_stopping_connection(b"{}".as_slice(), &mut output).is_err());
    assert!(output.is_empty());
}

#[test]
fn control_reads_distinguish_shutdown_eof_from_malformed_responses() {
    for response in [b"".as_slice(), b"{".as_slice()] {
        let profile = tempfile::tempdir().unwrap();
        let endpoint = EndpointPaths::prepare(profile.path()).unwrap();
        let listener = endpoint.bind_listener().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = String::new();
            BufReader::new(&mut stream).read_line(&mut request).unwrap();
            stream.write_all(response).unwrap();
            request
        });
        let result = super::request_control(&endpoint, crate::wire::ControlCommand::Status);
        let request: serde_json::Value = serde_json::from_str(&server.join().unwrap()).unwrap();
        assert_eq!(
            request,
            serde_json::json!({ "version": 1, "kind": "control", "command": "status" })
        );
        if response.is_empty() {
            assert_eq!(result.unwrap(), None);
        } else {
            assert_eq!(
                result.unwrap_err(),
                "Local App Server daemon returned an invalid control response"
            );
        }
    }
}

#[test]
fn managed_control_response_must_match_the_private_process_record() {
    let profile = tempfile::tempdir().unwrap();
    let endpoint = EndpointPaths::prepare(profile.path()).unwrap();
    let record = ProcessRecord::current(&endpoint).unwrap();
    let _record = ProcessRecordGuard::publish(&endpoint.pid, &record).unwrap();
    let valid = ControlResponse::new(
        ControlState::Running,
        record.pid,
        record.instance_id.clone(),
        schema_hash(),
    );
    let mismatched = ControlResponse::new(
        ControlState::Running,
        record.pid,
        "replacement".into(),
        schema_hash(),
    );

    assert_eq!(
        validate_managed_response(&endpoint, &valid).unwrap(),
        record
    );
    assert_eq!(
        validate_managed_response(&endpoint, &mismatched).unwrap_err(),
        "App Server daemon endpoint does not match its managed process record"
    );
}

#[test]
fn compatible_daemon_from_another_product_version_is_accepted() {
    let profile = tempfile::tempdir().unwrap();
    let endpoint = EndpointPaths::prepare(profile.path()).unwrap();
    let mut record = ProcessRecord::current(&endpoint).unwrap();
    record.daemon_version = "another-product-version".into();
    let _record = ProcessRecordGuard::publish(&endpoint.pid, &record).unwrap();
    let mut response = ControlResponse::new(
        ControlState::Running,
        record.pid,
        record.instance_id.clone(),
        "sha256:another-compatible-schema".into(),
    );
    response.daemon_version = record.daemon_version.clone();

    assert_eq!(
        validate_managed_response(&endpoint, &response).unwrap(),
        record
    );
}

#[test]
fn lifecycle_errors_include_only_the_bounded_log_tail() {
    let profile = tempfile::tempdir().unwrap();
    let endpoint = EndpointPaths::prepare(profile.path()).unwrap();
    let mut log = endpoint.open_log().unwrap();
    log.write_all(&vec![b'x'; 8192]).unwrap();
    log.write_all(b"\nuseful tail\n").unwrap();
    log.flush().unwrap();

    let error = diagnostic_error(&endpoint, "startup failed");

    assert!(error.starts_with("startup failed\n\nManaged daemon log"));
    assert!(error.ends_with("useful tail"));
    assert!(error.len() < 5000);
}

#[cfg(unix)]
#[test]
fn failed_initialization_reaps_only_the_new_backend() {
    use crate::ConnectionOptions;
    use crate::GrantSource;
    use crate::LifecycleCommand;
    use std::os::unix::fs::PermissionsExt;

    let root = tempfile::tempdir().unwrap();
    let executable = root.path().join("failed-backend");
    std::fs::write(&executable, "#!/bin/sh\nexit 23\n").unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let options = ConnectionOptions::new(root.path(), None, GrantSource::HostConfiguration, None);
    let error = super::run_lifecycle(LifecycleCommand::Start, options, &executable).unwrap_err();
    assert!(
        error.to_string().contains("exited before initialization"),
        "{error}"
    );
    let endpoint = EndpointPaths::prepare(root.path()).unwrap();
    assert!(!endpoint.pid.exists());
    assert!(!endpoint.socket.exists());
}
