use std::fs;

use super::PackageDigest;
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

    let resolved = resolve_backend_executable(&daemon, PackageDigest::NotProvided).unwrap();
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

    assert!(resolve_backend_executable(&daemon, PackageDigest::NotProvided).is_err());
}

#[test]
fn selected_backend_verifies_the_package_digest_with_its_generation_identity() {
    use sha2::Digest;

    let root = tempfile::tempdir().unwrap();
    let executable = root.path().join("backend");
    fs::write(&executable, b"signed backend").unwrap();
    let digest = format!("{:x}", sha2::Sha256::digest(b"signed backend"));

    assert!(resolve_backend_executable(&executable, PackageDigest::Expected(&digest)).is_ok());
    fs::write(&executable, b"changed backend").unwrap();
    assert!(resolve_backend_executable(&executable, PackageDigest::Expected(&digest)).is_err());
    assert!(resolve_backend_executable(&executable, PackageDigest::Expected("invalid")).is_err());
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
    let backend =
        super::resolve_backend_executable(&executable, super::PackageDigest::NotProvided).unwrap();
    let child = spawn_backend(&endpoint, &options, &backend).unwrap();
    let pid = child.child.as_ref().unwrap().id();
    assert!(process_start_identity(pid).unwrap().is_some());
    drop(child);
    assert!(process_start_identity(pid).unwrap().is_none());
}

#[cfg(unix)]
#[test]
fn managed_backend_receives_the_selected_product_services_path() {
    use super::spawn_backend;
    use crate::ConnectionOptions;
    use crate::GrantSource;
    use crate::endpoint::EndpointPaths;
    use std::os::unix::fs::PermissionsExt;
    use std::thread;
    use std::time::Duration;
    use std::time::Instant;

    let root = tempfile::tempdir().unwrap();
    let executable = root.path().join("managed-backend");
    let output = root.path().join("selected-product-services-path");
    fs::write(
        &executable,
        format!(
            "#!/bin/sh\nprintf '%s' \"$ASH_PRODUCT_SERVICES_PATH\" > '{}'\nexec sleep 60\n",
            output.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let product_services = root.path().join("selected-product-services.json");
    let options = ConnectionOptions::new(
        root.path(),
        None,
        GrantSource::HostConfiguration,
        Some(product_services.clone()),
    );
    let endpoint = EndpointPaths::prepare(root.path()).unwrap();
    let backend =
        super::resolve_backend_executable(&executable, super::PackageDigest::NotProvided).unwrap();
    let child = spawn_backend(&endpoint, &options, &backend).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while !output.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }

    assert_eq!(
        fs::read_to_string(&output).unwrap(),
        product_services.display().to_string()
    );
    drop(child);
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

#[cfg(unix)]
struct TerminationTestChild(std::process::Child);

#[cfg(unix)]
impl TerminationTestChild {
    fn spawn() -> Self {
        Self(
            std::process::Command::new("sleep")
                .arg("60")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap(),
        )
    }

    fn record(&self) -> super::ProcessRecord {
        super::ProcessRecord {
            pid: self.0.id(),
            instance_id: "owned-termination-test".into(),
            process_start_identity: super::process_start_identity(self.0.id()).unwrap(),
            daemon_version: "test".into(),
            executable_identity: None,
        }
    }
}

#[cfg(unix)]
impl Drop for TerminationTestChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[cfg(unix)]
#[test]
fn force_termination_accepts_a_child_that_exited_after_the_stop_poll() {
    let mut child = TerminationTestChild(
        std::process::Command::new("sh")
            .args(["-c", "read -r unused"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    let record = child.record();
    assert!(super::record_is_active(&record).unwrap());
    drop(child.0.stdin.take());
    child.0.wait().unwrap();
    // Reproduces the race deterministically: the poll observed the exact
    // generation, but force termination observes its already-completed exit.
    super::force_terminate(&record).unwrap();
    super::force_terminate(&record).unwrap();
}

#[cfg(unix)]
#[test]
fn force_termination_rejects_a_stale_identity_without_killing_a_live_child() {
    let mut child = TerminationTestChild::spawn();
    let mut record = child.record();
    record
        .process_start_identity
        .as_mut()
        .unwrap()
        .push_str("-stale");
    assert_eq!(
        super::force_terminate(&record).unwrap_err(),
        "refusing to terminate a reused or stale daemon pid"
    );
    assert!(child.0.try_wait().unwrap().is_none());
}

#[cfg(unix)]
#[test]
fn force_termination_rejects_a_live_successor_pid_and_still_terminates_the_owned_generation() {
    let mut original = TerminationTestChild::spawn();
    let record = original.record();
    // The Unix process-start contract has one-second timestamp precision.
    std::thread::sleep(std::time::Duration::from_secs(1));
    let mut successor = TerminationTestChild::spawn();
    let successor_record = successor.record();
    assert_ne!(
        record.process_start_identity,
        successor_record.process_start_identity
    );
    let stale = super::ProcessRecord {
        pid: successor.0.id(),
        ..record.clone()
    };
    assert_eq!(
        super::force_terminate(&stale).unwrap_err(),
        "refusing to terminate a reused or stale daemon pid"
    );
    assert!(successor.0.try_wait().unwrap().is_none());
    assert!(original.0.try_wait().unwrap().is_none());
    super::force_terminate(&record).unwrap();
    assert!(!original.0.wait().unwrap().success());
    assert!(successor.0.try_wait().unwrap().is_none());
}
