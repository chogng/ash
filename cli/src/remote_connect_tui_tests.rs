use std::path::Path;

use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_remote::RemoteDirPath;
use ash_remote::RemoteProfile;
use ash_remote::RemoteRuntime;
use ash_remote::SshHost;
use ash_remote::SshTarget;

use super::recovery_command;

#[test]
fn remote_recovery_command_preserves_the_verified_connection() {
    let profile = RemoteProfile::new(
        SshTarget::new(
            SshHost::parse("build-linux").unwrap(),
            RemoteDirPath::parse("/srv/project with spaces").unwrap(),
        ),
        RemoteRuntime::new_exact_executable("/srv/ash/runtime/bin/ash-remote-server").unwrap(),
    );
    let recovery = ash_tui::TuiRecoveryState::new(
        SessionId::new("session-1").unwrap(),
        ThreadId::new("thread-1").unwrap(),
    );

    assert_eq!(
        recovery_command(
            &profile,
            Some(Path::new("/opt/ssh client")),
            Some(&recovery)
        ),
        [
            "ash",
            "remote",
            "connect",
            "--host",
            "build-linux",
            "--dir",
            "/srv/project with spaces",
            "--runtime",
            "/srv/ash/runtime/bin/ash-remote-server",
            "--ssh",
            "/opt/ssh client",
            "--resume",
            "session-1",
            "thread-1",
        ]
    );
    assert_eq!(
        recovery_command(&profile, Some(Path::new("/opt/ssh client")), None),
        [
            "ash",
            "remote",
            "connect",
            "--host",
            "build-linux",
            "--dir",
            "/srv/project with spaces",
            "--runtime",
            "/srv/ash/runtime/bin/ash-remote-server",
            "--ssh",
            "/opt/ssh client"
        ]
    );
}
