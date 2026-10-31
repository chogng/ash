use std::sync::mpsc;
use std::time::Duration;

use super::EndpointPaths;

#[cfg(windows)]
#[test]
fn long_profile_directories_use_bounded_private_endpoints_and_remain_isolated() {
    use std::io::Read;
    use std::io::Write;

    let temporary = tempfile::tempdir().unwrap();
    let parent = temporary.path().join("long-profile-component-".repeat(5));
    let mut runtime_directories = Vec::new();
    for name in ["first", "second"] {
        let profile = parent.join(name);
        let endpoint = EndpointPaths::prepare(&profile).unwrap();
        assert!(endpoint.socket.as_os_str().as_encoded_bytes().len() > 108);
        assert!(
            endpoint
                .socket
                .starts_with(&std::fs::canonicalize(&profile).unwrap())
        );
        assert_eq!(
            EndpointPaths::prepare(&profile).unwrap().socket,
            endpoint.socket
        );
        let other = parent.join(if name == "first" { "second" } else { "first" });
        assert_ne!(
            EndpointPaths::prepare(&other).unwrap().socket,
            endpoint.socket
        );
        let listener = endpoint.bind_listener().unwrap();
        let server = std::thread::spawn(move || {
            let (mut peer, _) = listener.accept().unwrap();
            ash_app_server_transport::validate_local_peer(&peer).unwrap();
            peer.write_all(b"ok").unwrap();
        });
        let mut client = super::connect_existing(&endpoint.socket).unwrap().unwrap();
        ash_app_server_transport::validate_local_peer(&client).unwrap();
        let mut reply = [0; 2];
        client.read_exact(&mut reply).unwrap();
        assert_eq!(&reply, b"ok");
        drop(client);
        server.join().unwrap();
        assert!(!endpoint.socket.exists());
        let runtime = endpoint.socket.parent().unwrap().to_owned();
        drop(endpoint);
        runtime_directories.push(runtime);
    }
    for runtime in runtime_directories {
        std::fs::remove_dir(runtime).unwrap();
    }
}

#[test]
fn diagnostic_process_logs_include_only_the_selected_profile_and_numeric_rotations() {
    let profile = tempfile::tempdir().unwrap();
    let endpoint = EndpointPaths::prepare(profile.path()).unwrap();
    std::fs::write(&endpoint.log, b"current process\n").unwrap();
    std::fs::write(endpoint.log.with_extension("log.1"), b"previous process\n").unwrap();
    std::fs::write(endpoint.log.with_extension("log.old"), b"unrelated\n").unwrap();
    std::fs::write(
        endpoint.log.with_extension("log.01"),
        b"not a canonical rotation\n",
    )
    .unwrap();
    let (logs, omitted) = super::read_process_logs(profile.path()).unwrap();
    assert_eq!(omitted, 0);
    assert_eq!(
        logs.iter()
            .map(|log| (&*log.name, log.bytes.as_slice(), log.truncated))
            .collect::<Vec<_>>(),
        vec![
            ("app-server.log", b"current process\n".as_slice(), false),
            ("app-server.log.1", b"previous process\n".as_slice(), false),
        ]
    );
    assert_eq!(std::fs::read(&endpoint.log).unwrap(), b"current process\n");
}

#[test]
fn diagnostic_process_logs_bound_reads_without_truncating_the_producer_file() {
    let profile = tempfile::tempdir().unwrap();
    let endpoint = EndpointPaths::prepare(profile.path()).unwrap();
    let size = 16 * 1024 * 1024 + 1;
    std::fs::write(&endpoint.log, vec![b'x'; size]).unwrap();
    let (logs, _) = super::read_process_logs(profile.path()).unwrap();
    assert_eq!(logs[0].bytes.len(), size - 1);
    assert!(logs[0].truncated);
    assert_eq!(std::fs::metadata(&endpoint.log).unwrap().len(), size as u64);
}

#[test]
fn diagnostic_process_logs_report_omitted_rotations() {
    let profile = tempfile::tempdir().unwrap();
    let endpoint = EndpointPaths::prepare(profile.path()).unwrap();
    std::fs::write(&endpoint.log, b"current\n").unwrap();
    for rotation in 1..=32 {
        std::fs::write(
            endpoint.log.with_extension(format!("log.{rotation}")),
            b"previous\n",
        )
        .unwrap();
    }
    let (logs, omitted) = super::read_process_logs(profile.path()).unwrap();
    assert_eq!(logs.len(), 32);
    assert_eq!(omitted, 1);
    assert_eq!(logs.last().unwrap().name, "app-server.log.31");
}

#[test]
fn diagnostic_process_logs_bound_the_combined_snapshot_before_resource_allocation() {
    let profile = tempfile::tempdir().unwrap();
    let endpoint = EndpointPaths::prepare(profile.path()).unwrap();
    for rotation in 0..5 {
        let path = if rotation == 0 {
            endpoint.log.clone()
        } else {
            endpoint.log.with_extension(format!("log.{rotation}"))
        };
        std::fs::File::create(path)
            .unwrap()
            .set_len(16 * 1024 * 1024)
            .unwrap();
    }
    let (logs, omitted) = super::read_process_logs(profile.path()).unwrap();
    assert_eq!(
        logs.iter().map(|log| log.bytes.len()).sum::<usize>(),
        64 * 1024 * 1024
    );
    assert_eq!(logs.len(), 4);
    assert_eq!(omitted, 1);
}

#[cfg(unix)]
#[test]
fn diagnostic_process_logs_reject_symlinks() {
    let profile = tempfile::tempdir().unwrap();
    let endpoint = EndpointPaths::prepare(profile.path()).unwrap();
    let outside = tempfile::NamedTempFile::new().unwrap();
    std::os::unix::fs::symlink(outside.path(), &endpoint.log).unwrap();
    assert!(super::read_process_logs(profile.path()).is_err());
}

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
    #[cfg(unix)]
    assert!(endpoint.bind_listener().is_err());
    #[cfg(windows)]
    let _listener = endpoint.bind_listener().unwrap();
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
