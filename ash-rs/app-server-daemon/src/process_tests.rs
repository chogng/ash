use std::fs;

use super::resolve_backend_executable;

#[test]
fn resolves_the_selected_backend_in_its_package_directory() {
    let root = tempfile::tempdir().unwrap();
    let binary_directory = root.path().join("package").join("bin");
    fs::create_dir_all(&binary_directory).unwrap();
    let daemon = binary_directory.join(if cfg!(windows) {
        "ash-app-server.exe"
    } else {
        "ash-app-server"
    });
    fs::copy(std::env::current_exe().unwrap(), &daemon).unwrap();

    let resolved = resolve_backend_executable(&daemon).unwrap();
    let canonical_binary_directory = dunce::canonicalize(&binary_directory).unwrap();

    assert_eq!(resolved.path, dunce::canonicalize(&daemon).unwrap());
    assert_eq!(
        resolved.path.parent(),
        Some(canonical_binary_directory.as_path())
    );
}

#[test]
fn malformed_package_identity_cannot_select_a_daemon_generation() {
    let root = tempfile::tempdir().unwrap();
    let binary_directory = root.path().join("package/bin");
    fs::create_dir_all(&binary_directory).unwrap();
    let daemon = binary_directory.join(if cfg!(windows) {
        "ash-app-server.exe"
    } else {
        "ash-app-server"
    });
    fs::copy(std::env::current_exe().unwrap(), &daemon).unwrap();
    fs::write(root.path().join("package/ash-package.json"), "{}").unwrap();

    assert!(resolve_backend_executable(&daemon).is_err());
}

#[test]
fn stale_records_cannot_remove_a_successor_generation() {
    use super::ProcessRecord;
    use super::ProcessRecordGuard;
    use super::read_process_record;
    use super::remove_matching_process_record;
    use crate::endpoint::EndpointPaths;

    let root = tempfile::tempdir().unwrap();
    let endpoint = EndpointPaths::prepare(root.path()).unwrap();
    let old = ProcessRecord::current(&endpoint).unwrap();
    let old_guard = ProcessRecordGuard::publish(&endpoint.pid, &old).unwrap();
    let mut successor = old.clone();
    successor.instance_id = "successor".into();
    let successor_guard = ProcessRecordGuard::publish(&endpoint.pid, &successor).unwrap();
    remove_matching_process_record(&endpoint.pid, &old).unwrap();
    drop(old_guard);
    assert_eq!(read_process_record(&endpoint.pid).unwrap(), Some(successor));
    drop(successor_guard);
    assert!(read_process_record(&endpoint.pid).unwrap().is_none());
}

#[test]
fn an_active_record_is_not_discarded_as_stale() {
    use super::ProcessRecord;
    use super::ProcessRecordGuard;
    use super::read_process_record;
    use super::remove_stale_process_record;
    use crate::endpoint::EndpointPaths;

    let root = tempfile::tempdir().unwrap();
    let endpoint = EndpointPaths::prepare(root.path()).unwrap();
    let record = ProcessRecord::current(&endpoint).unwrap();
    let _guard = ProcessRecordGuard::publish(&endpoint.pid, &record).unwrap();
    assert!(remove_stale_process_record(&endpoint.pid).is_err());
    assert_eq!(read_process_record(&endpoint.pid).unwrap(), Some(record));
}

#[cfg(unix)]
#[test]
fn dropping_an_unready_child_terminates_and_reaps_it() {
    use super::process_start_identity;
    use super::spawn_backend;
    use crate::ConnectionOptions;
    use crate::GrantSource;
    use crate::endpoint::EndpointPaths;
    use std::os::unix::fs::PermissionsExt;

    let root = tempfile::tempdir().unwrap();
    let executable = root.path().join("unready");
    fs::write(&executable, "#!/bin/sh\nexec sleep 60\n").unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let options = ConnectionOptions::new(root.path(), None, GrantSource::HostConfiguration, None);
    let endpoint = EndpointPaths::prepare(root.path()).unwrap();
    let child = spawn_backend(&endpoint, &options, &executable).unwrap();
    let pid = child.child.as_ref().unwrap().id();
    assert!(process_start_identity(pid).unwrap().is_some());
    drop(child);
    assert!(process_start_identity(pid).unwrap().is_none());
}

#[test]
fn an_unverifiable_record_is_not_silently_removed() {
    use super::ProcessRecord;
    use super::ProcessRecordGuard;
    use super::read_process_record;
    use super::remove_stale_process_record;
    use crate::endpoint::EndpointPaths;

    let root = tempfile::tempdir().unwrap();
    let endpoint = EndpointPaths::prepare(root.path()).unwrap();
    let mut record = ProcessRecord::current(&endpoint).unwrap();
    record.process_start_identity = None;
    let _guard = ProcessRecordGuard::publish(&endpoint.pid, &record).unwrap();
    assert!(remove_stale_process_record(&endpoint.pid).is_err());
    assert_eq!(read_process_record(&endpoint.pid).unwrap(), Some(record));
}
