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
    assert!(error.contains("exited before initialization"), "{error}");
    let endpoint = EndpointPaths::prepare(root.path()).unwrap();
    assert!(!endpoint.pid.exists());
    assert!(!endpoint.socket.exists());
}
