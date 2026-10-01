// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

use super::*;

#[test]
fn exit_observation_keeps_the_leader_owned_until_wait_finishes() {
    let child = Command::new("sh")
        .args(["-c", "exit 17"])
        .process_group(0)
        .spawn()
        .unwrap();
    let mut process = BubblewrapSandboxProcess::new(BwrapChild {
        child: Arc::new(Mutex::new(child)),
        stdin: None,
        stdout: None,
        stderr: None,
        stdout_canceller: None,
        stderr_canceller: None,
        group: true,
        proxy: UnixProxyCoordinator::new(),
        proxy_network: None,
        fw_manager: None,
        monitor: None,
        timeout: Some(Duration::from_secs(10)),
    });

    let deadline = Instant::now() + Duration::from_secs(10);
    while process.try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline, "leader did not exit");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        wxc_common::sandbox_process::poll_child_exit(&process.inner.lock_child()).unwrap(),
        Some(17),
        "observing exit must not release the PID before process-tree cleanup"
    );
    assert_eq!(process.wait().unwrap(), 17);
    assert_eq!(process.try_wait().unwrap(), Some(17));
    process.kill().unwrap();
    assert_eq!(process.wait().unwrap(), 17);
}
