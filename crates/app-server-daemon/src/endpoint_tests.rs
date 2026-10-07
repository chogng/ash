use std::sync::mpsc;
use std::time::Duration;

use super::EndpointPaths;

#[test]
fn bound_endpoint_connects_through_the_private_directory_and_validates_its_peer() {
    let profile = tempfile::tempdir().unwrap();
    let endpoint = EndpointPaths::prepare(profile.path()).unwrap();
    let listener = endpoint.bind_listener().unwrap();
    let accepted = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        ash_app_server_transport::validate_local_peer(&stream).unwrap();
        stream
    });
    let stream = super::connect_existing(&endpoint.socket).unwrap().unwrap();
    ash_app_server_transport::validate_local_peer(&stream).unwrap();
    drop(accepted.join().unwrap());
    drop(stream);
}

#[cfg(windows)]
#[test]
fn existing_runtime_directory_with_inherited_permissions_is_rejected() {
    let profile = tempfile::tempdir().unwrap();
    std::fs::create_dir(profile.path().join("run")).unwrap();
    assert!(EndpointPaths::prepare(profile.path()).is_err());
}

#[test]
fn ordinary_file_at_endpoint_is_not_removed_or_replaced() {
    let profile = tempfile::tempdir().unwrap();
    let endpoint = EndpointPaths::prepare(profile.path()).unwrap();
    std::fs::write(&endpoint.socket, "keep").unwrap();
    assert!(endpoint.bind_listener().is_err());
    assert_eq!(std::fs::read_to_string(&endpoint.socket).unwrap(), "keep");
}

#[test]
fn profile_operation_lock_serializes_mutating_lifecycle_commands() {
    let profile = tempfile::tempdir().unwrap();
    let endpoint = EndpointPaths::prepare(profile.path()).unwrap();
    let first = endpoint.acquire_operation_lock().unwrap();
    let contender = endpoint.clone();
    let (acquired, receive) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let second = contender.acquire_operation_lock().unwrap();
        acquired.send(()).unwrap();
        drop(second);
    });

    assert!(receive.recv_timeout(Duration::from_millis(100)).is_err());
    drop(first);
    receive.recv_timeout(Duration::from_secs(2)).unwrap();
    worker.join().unwrap();
}

#[test]
fn abandoned_operation_lock_is_recovered_after_its_heartbeat_expires() {
    let profile = tempfile::tempdir().unwrap();
    let endpoint = EndpointPaths::prepare(profile.path()).unwrap();
    std::fs::create_dir(&endpoint.operation_lock).unwrap();
    std::fs::write(endpoint.operation_lock.join("heartbeat"), "abandoned").unwrap();
    std::thread::sleep(Duration::from_millis(300));

    let recovered = endpoint.acquire_operation_lock().unwrap();

    drop(recovered);
    assert!(!endpoint.operation_lock.exists());
}
