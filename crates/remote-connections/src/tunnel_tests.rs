use std::num::NonZeroU16;
use std::path::Path;
#[cfg(any(unix, windows))]
use std::time::Duration;
#[cfg(any(unix, windows))]
use std::time::Instant;

use super::SshTunnelError;
use super::SshTunnelOptions;
#[cfg(any(unix, windows))]
use super::SshTunnelReadiness;
use super::select_available_loopback_port;
use ash_remote::SshHost;

fn host() -> SshHost {
    SshHost::parse("work-server").unwrap()
}

#[test]
fn tunnel_command_binds_only_to_loopback_and_enables_forward_failure_detection() {
    let command = SshTunnelOptions::new(
        host(),
        NonZeroU16::new(49152).unwrap(),
        NonZeroU16::new(3000).unwrap(),
    )
    .with_remote_host("localhost")
    .unwrap()
    .with_ssh_executable("/usr/bin/ssh")
    .command();

    assert_eq!(command.executable(), Path::new("/usr/bin/ssh"));
    assert_eq!(
        command.arguments(),
        [
            "-N",
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "ExitOnForwardFailure=yes",
            "-o",
            "ConnectTimeout=10",
            "-S",
            "none",
            "-o",
            "PermitLocalCommand=yes",
            "-o",
            "LocalCommand=echo ash-ssh-forward-ready",
            "-L",
            "127.0.0.1:49152:localhost:3000",
            "work-server",
        ]
    );
}

#[test]
fn tunnel_remote_host_rejects_shell_and_option_syntax() {
    let options = SshTunnelOptions::new(
        host(),
        NonZeroU16::new(49152).unwrap(),
        NonZeroU16::new(3000).unwrap(),
    );
    assert!(matches!(
        options.clone().with_remote_host("127.0.0.1;id"),
        Err(SshTunnelError::InvalidRemoteHost)
    ));
    assert!(matches!(
        options.with_remote_host("-oProxyCommand=evil"),
        Err(SshTunnelError::InvalidRemoteHost)
    ));
}

#[test]
fn automatic_local_port_is_non_zero_and_released_for_openssh() {
    let port = select_available_loopback_port().unwrap();

    let listener = std::net::TcpListener::bind(("127.0.0.1", port.get())).unwrap();
    assert_eq!(listener.local_addr().unwrap().port(), port.get());
}

#[cfg(any(unix, windows))]
#[test]
fn an_occupied_port_does_not_confirm_a_pending_ssh_forward() {
    let directory = tempfile::tempdir().unwrap();
    let executable = ssh_fixture(directory.path(), "pending", "", "");
    let other_listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = NonZeroU16::new(other_listener.local_addr().unwrap().port()).unwrap();
    let mut tunnel = SshTunnelOptions::new(host(), port, NonZeroU16::new(3000).unwrap())
        .with_ssh_executable(executable)
        .start()
        .unwrap();

    assert_eq!(
        tunnel.poll_readiness().unwrap(),
        SshTunnelReadiness::Pending
    );
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(
        tunnel.poll_readiness().unwrap(),
        SshTunnelReadiness::Pending
    );
    tunnel.stop().unwrap();
}

#[cfg(any(unix, windows))]
#[test]
fn readiness_requires_confirmation_from_the_live_ssh_child() {
    let directory = tempfile::tempdir().unwrap();
    let live = ssh_fixture(
        directory.path(),
        "ready",
        "echo ash-ssh-forward-ready\n",
        "echo ash-ssh-forward-ready\r\n",
    );
    let local_port = select_available_loopback_port().unwrap();
    let mut tunnel = SshTunnelOptions::new(host(), local_port, NonZeroU16::new(3_000).unwrap())
        .with_ssh_executable(&live)
        .start()
        .unwrap();
    assert_eq!(
        wait_for_outcome(&mut tunnel).unwrap(),
        SshTunnelReadiness::Ready
    );
    assert_eq!(tunnel.poll_readiness().unwrap(), SshTunnelReadiness::Ready);
    tunnel.stop().unwrap();
}

#[cfg(any(unix, windows))]
#[test]
fn ssh_exit_before_confirmation_is_reported() {
    let directory = tempfile::tempdir().unwrap();
    let executable = ssh_fixture(directory.path(), "failure", "exit 17\n", "exit /b 17\r\n");
    let failure = SshTunnelOptions::new(
        host(),
        select_available_loopback_port().unwrap(),
        NonZeroU16::new(3_000).unwrap(),
    )
    .with_ssh_executable(executable)
    .start();
    let status = match failure {
        Err(SshTunnelError::ProcessExited(status)) => status,
        Ok(mut tunnel) => match wait_for_outcome(&mut tunnel) {
            Err(SshTunnelError::ProcessExited(status)) => status,
            result => panic!("unexpected startup result: {result:?}"),
        },
        Err(error) => panic!("unexpected startup error: {error}"),
    };
    assert_eq!(status.code(), Some(17));
}

#[cfg(any(unix, windows))]
fn wait_for_outcome(tunnel: &mut super::SshTunnel) -> Result<SshTunnelReadiness, SshTunnelError> {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match tunnel.poll_readiness()? {
            SshTunnelReadiness::Ready => return Ok(SshTunnelReadiness::Ready),
            SshTunnelReadiness::Pending if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            SshTunnelReadiness::Pending => panic!("SSH tunnel did not become ready"),
        }
    }
}

#[cfg(any(unix, windows))]
fn ssh_fixture(directory: &Path, name: &str, unix: &str, windows: &str) -> std::path::PathBuf {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let _ = windows;
        let executable = directory.join(name);
        std::fs::write(&executable, format!("#!/bin/sh\n{unix}exec sleep 30\n")).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        executable
    }
    #[cfg(windows)]
    {
        let _ = unix;
        let executable = directory.join(format!("{name}.cmd"));
        std::fs::write(
            &executable,
            format!("@echo off\r\n{windows}:pending\r\ngoto pending\r\n"),
        )
        .unwrap();
        executable
    }
}
