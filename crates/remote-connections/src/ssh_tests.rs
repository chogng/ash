#[cfg(unix)]
use std::fs;
use std::num::NonZeroU16;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use super::RemoteConnectionFailureKind;
use super::RemoteRuntimeProbe;
use super::SshAppServerConnectionOptions;
use super::remote_app_server_command;
use super::ssh::RuntimeProbeOutput;
use super::ssh::parse_runtime_probe_output;
#[cfg(unix)]
use ash_app_server_protocol::protocol::common::ClientCapabilities;
#[cfg(unix)]
use ash_app_server_protocol::protocol::common::ClientInfo;
#[cfg(unix)]
use ash_app_server_protocol::protocol::initialize::APP_SERVER_PROTOCOL_MAJOR;
#[cfg(unix)]
use ash_app_server_protocol::protocol::initialize::ServerCapabilities;
use ash_remote::RemoteDirPath;
use ash_remote::RemoteProfile;
use ash_remote::RemoteRuntime;
use ash_remote::SshHost;
use ash_remote::SshTarget;

fn profile() -> RemoteProfile {
    RemoteProfile::new(
        SshTarget::new(
            SshHost::parse("build-linux").unwrap(),
            RemoteDirPath::parse("/srv/ash/project with spaces").unwrap(),
        ),
        RemoteRuntime::new("/opt/ash/bin/ash-remote-server").unwrap(),
    )
}

#[test]
fn ssh_connection_starts_a_non_interactive_stdio_channel() {
    let command = SshAppServerConnectionOptions::new(profile())
        .with_ssh_executable("/usr/bin/ssh")
        .with_connect_timeout_seconds(NonZeroU16::new(15).unwrap())
        .stdio_command();

    assert_eq!(command.executable(), Path::new("/usr/bin/ssh"));
    assert_eq!(
        command.arguments_as_strings(),
        vec![
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=15",
            "build-linux",
            "'env' 'ASH_WORKSPACE_ROOT=/srv/ash/project with spaces' '/opt/ash/bin/ash-remote-server' 'connect'",
        ]
    );
}

#[test]
fn remote_command_quotes_the_dir_and_runtime_as_independent_arguments() {
    let profile = RemoteProfile::new(
        SshTarget::new(
            SshHost::parse("build-linux").unwrap(),
            RemoteDirPath::parse("/srv/o'reilly").unwrap(),
        ),
        RemoteRuntime::new("/opt/ash remote/bin/server").unwrap(),
    );

    assert_eq!(
        remote_app_server_command(&profile),
        "'env' 'ASH_WORKSPACE_ROOT=/srv/o'\\''reilly' '/opt/ash remote/bin/server' 'connect'"
    );
}

#[test]
fn remote_runtime_probe_is_shell_quoted_and_reports_a_resolved_executable() {
    let profile = RemoteProfile::new(
        SshTarget::new(
            SshHost::parse("build-linux").unwrap(),
            RemoteDirPath::parse("/srv/ash").unwrap(),
        ),
        RemoteRuntime::new("/opt/ash's/bin/ash-remote-server").unwrap(),
    );
    let options = SshAppServerConnectionOptions::new(profile);

    assert_eq!(
        super::ssh::remote_runtime_probe_command(options.profile().runtime().executable()),
        "if command -v '/opt/ash'\\''s/bin/ash-remote-server' >/dev/null 2>&1; then printf '%s%s\\n' '__ASH_REMOTE_RUNTIME_FOUND__:' \"$(command -v '/opt/ash'\\''s/bin/ash-remote-server')\"; else printf '%s\\n' '__ASH_REMOTE_RUNTIME_MISSING__'; exit 127; fi"
    );

    let probe = RemoteRuntimeProbe {
        requested_runtime: RemoteRuntime::new("/opt/ash/bin/ash-remote-server").unwrap(),
        resolved_runtime: RemoteRuntime::new("/opt/ash/bin/ash-remote-server").unwrap(),
    };
    assert_eq!(
        probe.requested_executable(),
        "/opt/ash/bin/ash-remote-server"
    );
    assert_eq!(
        probe.resolved_executable(),
        "/opt/ash/bin/ash-remote-server"
    );
    assert_eq!(
        parse_runtime_probe_output(
            "login banner\n__ASH_REMOTE_RUNTIME_FOUND__:/usr/bin/ash-remote-server\n"
        ),
        Some(RuntimeProbeOutput::Found(
            "/usr/bin/ash-remote-server".into()
        ))
    );
    assert_eq!(
        parse_runtime_probe_output("__ASH_REMOTE_RUNTIME_MISSING__\n"),
        Some(RuntimeProbeOutput::Missing)
    );
    assert_eq!(parse_runtime_probe_output("unexpected output\n"), None);
}

#[test]
fn remote_connection_errors_keep_stable_failure_categories() {
    let stopping = super::RemoteConnectionError::from_client_error(
        ash_app_server_client::ClientError::ServerShuttingDown,
    );
    let transport = super::RemoteConnectionError::from_client_error(
        ash_app_server_client::ClientError::Transport("ssh failed".into()),
    );
    let protocol = super::RemoteConnectionError::from_client_error(
        ash_app_server_client::ClientError::Protocol("protocol major mismatch".into()),
    );
    let server = super::RemoteConnectionError::from_client_error(
        ash_app_server_client::ClientError::Server {
            code: -32001,
            message: "unsupported".into(),
        },
    );

    assert_eq!(transport.kind(), RemoteConnectionFailureKind::Transport);
    assert_eq!(stopping.kind(), RemoteConnectionFailureKind::Transport);
    assert_eq!(
        protocol.kind(),
        RemoteConnectionFailureKind::ProtocolIncompatible
    );
    assert_eq!(server.kind(), RemoteConnectionFailureKind::ServerRejected);
}

#[cfg(unix)]
#[test]
fn runtime_probe_distinguishes_available_and_missing_runtime() {
    let directory = tempfile::tempdir().unwrap();
    let executable = directory.path().join("fake-ssh");
    fs::write(
        &executable,
        "#!/bin/sh\ncase \"$*\" in\n  *missing-runtime*) printf '%s\\n' '__ASH_REMOTE_RUNTIME_MISSING__'; exit 127 ;;\n  *) printf '%s%s\\n' '__ASH_REMOTE_RUNTIME_FOUND__:' '/usr/bin/ash-remote-server' ;;\nesac\n",
    )
    .unwrap();
    let mut permissions = fs::metadata(&executable).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&executable, permissions).unwrap();

    let available = SshAppServerConnectionOptions::new(profile())
        .with_ssh_executable(&executable)
        .probe_runtime()
        .unwrap();
    assert_eq!(
        available.requested_executable(),
        "/opt/ash/bin/ash-remote-server"
    );
    assert_eq!(
        available.resolved_executable(),
        "/usr/bin/ash-remote-server"
    );

    let missing_profile = RemoteProfile::new(
        SshTarget::new(
            SshHost::parse("build-linux").unwrap(),
            RemoteDirPath::parse("/srv/ash/project").unwrap(),
        ),
        RemoteRuntime::new("missing-runtime").unwrap(),
    );
    let error = SshAppServerConnectionOptions::new(missing_profile)
        .with_ssh_executable(executable)
        .probe_runtime()
        .unwrap_err();
    assert_eq!(
        error.kind(),
        RemoteConnectionFailureKind::RuntimeUnavailable
    );
}

#[cfg(unix)]
#[test]
fn compatibility_probe_requires_matching_protocol_and_generated_schema() {
    let directory = tempfile::tempdir().unwrap();
    let compatible = directory.path().join("compatible-ssh");
    let schema_hash = ash_app_server_protocol::schema_hash();
    write_initialize_server(&compatible, APP_SERVER_PROTOCOL_MAJOR, &schema_hash);

    let initialization = SshAppServerConnectionOptions::new(profile())
        .with_ssh_executable(&compatible)
        .probe_compatibility(client_info(), ClientCapabilities::default())
        .unwrap();
    assert_eq!(initialization.schema_hash.0, schema_hash);
    assert_initialize_server_closed(&compatible);

    for (name, major, hash) in [
        (
            "wrong-major",
            APP_SERVER_PROTOCOL_MAJOR + 1,
            schema_hash.as_str(),
        ),
        (
            "wrong-schema",
            APP_SERVER_PROTOCOL_MAJOR,
            "different-schema",
        ),
    ] {
        let incompatible = directory.path().join(name);
        write_initialize_server(&incompatible, major, hash);
        let error = SshAppServerConnectionOptions::new(profile())
            .with_ssh_executable(&incompatible)
            .probe_compatibility(client_info(), ClientCapabilities::default())
            .unwrap_err();
        assert_eq!(
            error.kind(),
            RemoteConnectionFailureKind::ProtocolIncompatible
        );
        assert_initialize_server_closed(&incompatible);
    }
}

#[cfg(unix)]
fn client_info() -> ClientInfo {
    ClientInfo {
        name: "remote-connection-test".into(),
        version: "1".into(),
    }
}

#[cfg(unix)]
fn write_initialize_server(path: &Path, protocol_major: u32, server_schema_hash: &str) {
    let mut capabilities = ServerCapabilities {
        sessions: true,
        threads: true,
        turns: true,
        ..ServerCapabilities::default()
    };
    capabilities.advertise_contracts();
    let response = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "result": {
            "serverInfo": { "name": "fake-remote", "version": "1" },
            "protocolVersion": {
                "major": protocol_major,
            },
            "schemaHash": server_schema_hash,
            "capabilities": capabilities,
            "slashCommands": []
        }
    })
    .to_string();
    fs::write(
        path,
        format!(
            "#!/bin/sh\nexec 9>\"$0.held\"\nprintf '%s' \"$$\" > \"$0.pid\"\nIFS= read -r request || exit 65\nprintf '%s\\n' '{response}'\nwhile IFS= read -r request; do :; done\nexec 9>&-\nprintf closed > \"$0.eof\"\n"
        ),
    )
    .unwrap();
    let mut permissions = fs::metadata(path).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).unwrap();
}

#[cfg(unix)]
fn assert_initialize_server_closed(path: &Path) {
    use std::process::Command;
    let filename = path.to_str().unwrap();
    assert_eq!(
        fs::read_to_string(format!("{filename}.eof")).unwrap(),
        "closed"
    );
    let pid = fs::read_to_string(format!("{filename}.pid")).unwrap();
    let process = Command::new("/bin/kill")
        .args(["-0", &pid])
        .output()
        .unwrap();
    assert!(
        !process.status.success(),
        "SSH compatibility process {pid} survived: {process:?}"
    );
    let handles = Command::new("lsof")
        .args(["-t", "--", &format!("{filename}.held")])
        .output()
        .unwrap();
    assert_eq!(handles.status.code(), Some(1), "{handles:?}");
    assert!(
        handles.stdout.is_empty() && handles.stderr.is_empty(),
        "{handles:?}"
    );
}
