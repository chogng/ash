use std::num::NonZeroU16;
use std::path::Path;
#[cfg(unix)]
use std::time::Duration;
#[cfg(unix)]
use std::time::Instant;

use super::SshTunnelError;
use super::SshTunnelOptions;
#[cfg(unix)]
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

#[cfg(unix)]
#[test]
fn listener_readiness_distinguishes_a_live_tunnel_from_an_early_exit() {
    use std::os::unix::fs::PermissionsExt;

    let directory = tempfile::tempdir().unwrap();
    let live = directory.path().join("live-ssh");
    std::fs::write(&live, "#!/bin/sh\nsleep 0.1\n").unwrap();
    let mut permissions = std::fs::metadata(&live).unwrap().permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&live, permissions).unwrap();
    let local_port = select_available_loopback_port().unwrap();
    let listener = std::net::TcpListener::bind(("127.0.0.1", local_port.get())).unwrap();
    let mut tunnel = SshTunnelOptions::new(host(), local_port, NonZeroU16::new(3_000).unwrap())
        .with_ssh_executable(&live)
        .start()
        .unwrap();
    wait_until_ready(&mut tunnel, Duration::from_secs(1)).unwrap();
    tunnel.stop().unwrap();
    drop(listener);

    let failure = SshTunnelOptions::new(
        host(),
        NonZeroU16::new(49_153).unwrap(),
        NonZeroU16::new(3_000).unwrap(),
    )
    .with_ssh_executable("/usr/bin/false")
    .start();
    let status = match failure {
        Err(SshTunnelError::ProcessExited(status)) => status,
        Ok(mut tunnel) => loop {
            match tunnel.poll_readiness() {
                Err(SshTunnelError::ProcessExited(status)) => break status,
                Ok(SshTunnelReadiness::Pending) => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                result => panic!("unexpected startup result: {result:?}"),
            }
        },
        Err(error) => panic!("unexpected startup error: {error}"),
    };
    assert!(!status.success());
}

#[cfg(unix)]
fn wait_until_ready(
    tunnel: &mut super::SshTunnel,
    timeout: Duration,
) -> Result<(), SshTunnelError> {
    let deadline = Instant::now() + timeout;
    loop {
        match tunnel.poll_readiness()? {
            SshTunnelReadiness::Ready => return Ok(()),
            SshTunnelReadiness::Pending if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            SshTunnelReadiness::Pending => panic!("SSH tunnel did not become ready"),
        }
    }
}
