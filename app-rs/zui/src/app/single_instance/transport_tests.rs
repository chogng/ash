use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::sync::mpsc;
use std::time::Duration;

use super::Acquisition;
use super::DispatchQueue;
use super::EndpointPaths;
use super::acquire_at;
use crate::app::SecondInstance;

#[test]
fn secondary_invocations_queue_before_runtime_attachment() {
    let secondary_event = SecondInstance::new(
        ["sample-app", "sample-app://open/settings"],
        PathBuf::from("/secondary"),
    )
    .with_additional_data([1, 2, 3]);

    let dispatch = DispatchQueue::default();
    assert!(dispatch.deliver(secondary_event.clone()));
    let (sender, receiver) = mpsc::channel();
    dispatch.attach(Arc::new(move |event| sender.send(event).is_ok()));
    assert_eq!(
        receiver.recv_timeout(Duration::from_secs(1)).unwrap(),
        secondary_event
    );
}

#[test]
fn released_identity_can_be_acquired_again() {
    let temporary = tempfile::tempdir().unwrap();
    let paths = EndpointPaths {
        lock: temporary.path().join("released.lock"),
        socket: temporary.path().join("released.sock"),
    };
    let event = SecondInstance::new(["primary"], PathBuf::from("/primary"));
    let Acquisition::Primary(primary) =
        acquire_at(paths.clone(), &event, Duration::from_secs(1)).unwrap()
    else {
        panic!("first invocation must become primary");
    };

    drop(primary);
    let Acquisition::Primary(reacquired) =
        acquire_at(paths, &event, Duration::from_secs(1)).unwrap()
    else {
        panic!("released identity must be acquirable again");
    };
    drop(reacquired);
}

#[test]
fn secondary_process_invocation_crosses_the_operating_system_boundary() {
    let temporary = tempfile::tempdir().unwrap();
    let paths = EndpointPaths {
        lock: temporary.path().join("process.lock"),
        socket: temporary.path().join("process.sock"),
    };
    let primary_event = SecondInstance::new(["primary"], PathBuf::from("/primary"));
    let Acquisition::Primary(primary) =
        acquire_at(paths.clone(), &primary_event, Duration::from_secs(1)).unwrap()
    else {
        panic!("parent invocation must become primary");
    };

    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "app::single_instance::transport::tests::secondary_process_helper",
            "--nocapture",
        ])
        .env("ZUI_TEST_INSTANCE_LOCK", &paths.lock)
        .env("ZUI_TEST_INSTANCE_SOCKET", &paths.socket)
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "secondary helper failed:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let (sender, receiver) = mpsc::channel();
    primary.attach(move |event| sender.send(event).is_ok());
    assert_eq!(
        receiver.recv_timeout(Duration::from_secs(1)).unwrap(),
        SecondInstance::new(
            ["secondary", "sample-app://open/from-child"],
            PathBuf::from("/secondary-process"),
        )
        .with_additional_data([9, 8, 7])
    );
}

#[test]
fn secondary_process_helper() {
    let Some(lock) = std::env::var_os("ZUI_TEST_INSTANCE_LOCK") else {
        return;
    };
    let socket = std::env::var_os("ZUI_TEST_INSTANCE_SOCKET").unwrap();
    let paths = EndpointPaths {
        lock: PathBuf::from(lock),
        socket: PathBuf::from(socket),
    };
    let event = SecondInstance::new(
        ["secondary", "sample-app://open/from-child"],
        PathBuf::from("/secondary-process"),
    )
    .with_additional_data([9, 8, 7]);

    assert!(matches!(
        acquire_at(paths, &event, Duration::from_secs(2)).unwrap(),
        Acquisition::Forwarded
    ));
}
