#[cfg(unix)]
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use ash_app_server_client::AppServerEvent;
use ash_app_server_client::AppServerSession;
use ash_app_server_client::ClientError;
use ash_app_server_client::ConnectionCloseReason;
use ash_app_server_client::StdioAppServerCommand;
use ash_app_server_protocol::protocol::common::ClientCapabilities;
use ash_app_server_protocol::protocol::common::ClientInfo;
#[cfg(unix)]
use ash_app_server_protocol::protocol::terminal::TerminalAttachParams;
#[cfg(unix)]
use ash_app_server_protocol::protocol::terminal::TerminalCloseParams;
#[cfg(unix)]
use ash_app_server_protocol::protocol::terminal::TerminalCreateParams;
#[cfg(unix)]
use ash_app_server_protocol::protocol::terminal::TerminalLifecycle;
#[cfg(unix)]
use ash_app_server_protocol::protocol::terminal::TerminalProfileSelection;
#[cfg(unix)]
use ash_remote::RemoteDirPath;
#[cfg(unix)]
use ash_remote::RemoteProfile;
#[cfg(unix)]
use ash_remote::RemoteRuntime;
#[cfg(unix)]
use ash_remote::SshHost;
#[cfg(unix)]
use ash_remote::SshTarget;
#[cfg(unix)]
use ash_remote_connections::SshAppServerConnectionOptions;

#[test]
fn ash_code_cli_serves_the_remote_stdio_contract() {
    let root = test_root("stdio");
    let dir = root.join("dir");
    let profile = root.join("profile");
    std::fs::create_dir_all(&dir).unwrap();

    let command = StdioAppServerCommand::new(env!("CARGO_BIN_EXE_ash"))
        .with_argument("app-server")
        .with_argument("--listen")
        .with_argument("stdio://")
        .with_environment_variable("ASH_WORKSPACE_ROOT", dir.into_os_string())
        .with_environment_variable("ASH_HOME", profile.into_os_string());
    #[cfg(unix)]
    let command = lifecycle::stdio_command(command, &root);
    let mut session = AppServerSession::start_stdio(
        command,
        ClientInfo {
            name: "ash-code-remote-test".into(),
            version: "1".into(),
        },
        ClientCapabilities::default(),
    )
    .unwrap();
    assert!(session.process_id().is_some());
    #[cfg(unix)]
    let transport_pid = session.process_id().unwrap();
    #[cfg(unix)]
    let server_processes = lifecycle::stdio_processes(&root);
    let events = session.take_events().unwrap();
    let mut client = session.client();

    assert!(client.list_sessions().unwrap().sessions.is_empty());

    session.shutdown().unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match events
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap()
        {
            AppServerEvent::Notification(_) => {}
            event => {
                assert_eq!(
                    event,
                    AppServerEvent::ConnectionClosed(ConnectionCloseReason::Shutdown)
                );
                break;
            }
        }
    }
    #[cfg(unix)]
    lifecycle::assert_stdio_closed(&root, transport_pid, &server_processes);
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn ash_code_cli_forwards_app_server_output_and_exit_status() {
    let root = test_root("forward-exit");
    fs::create_dir_all(&root).unwrap();
    let backend = root.join("ash-app-server-test");
    fs::write(
        &backend,
        "#!/bin/sh\nprintf 'forwarded:%s\\n' \"$1\"\nexit 17\n",
    )
    .unwrap();
    let mut permissions = fs::metadata(&backend).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&backend, permissions).unwrap();

    let output = std::process::Command::new(env!("CARGO_BIN_EXE_ash"))
        .args(["app-server", "--listen", "stdio://"])
        .env("ASH_APP_SERVER_PATH", &backend)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(17));
    assert_eq!(output.stdout, b"forwarded:--listen\n");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn ash_code_app_server_without_dir_does_not_inherit_its_current_directory() {
    let root = test_root("empty-dir");
    let profile = root.join("profile");
    let command = StdioAppServerCommand::new(env!("CARGO_BIN_EXE_ash"))
        .with_argument("app-server")
        .with_argument("--listen")
        .with_argument("stdio://")
        .without_environment_variable("ASH_WORKSPACE_ROOT")
        .with_environment_variable("ASH_HOME", profile.into_os_string());
    #[cfg(unix)]
    let command = lifecycle::stdio_command(command, &root);
    let session = AppServerSession::start_stdio(
        command,
        ClientInfo {
            name: "ash-code-empty-dir-test".into(),
            version: "1".into(),
        },
        ClientCapabilities::default(),
    )
    .unwrap();
    #[cfg(unix)]
    let transport_pid = session.process_id().unwrap();
    #[cfg(unix)]
    let server_processes = lifecycle::stdio_processes(&root);
    let mut client = session.client();

    assert_eq!(
        client.git_status().unwrap_err(),
        ClientError::Server {
            code: -32060,
            message: "GitUnavailable".into(),
        }
    );

    session.shutdown().unwrap();
    #[cfg(unix)]
    lifecycle::assert_stdio_closed(&root, transport_pid, &server_processes);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn dropping_cli_stdio_session_releases_the_backend_profile() {
    let root = test_root("drop-stdio");
    let command = StdioAppServerCommand::new(env!("CARGO_BIN_EXE_ash"))
        .with_argument("app-server")
        .with_argument("--listen")
        .with_argument("stdio://")
        .without_environment_variable("ASH_WORKSPACE_ROOT")
        .with_environment_variable("ASH_HOME", root.join("profile"));
    #[cfg(unix)]
    let command = lifecycle::stdio_command(command, &root);
    let session = AppServerSession::start_stdio(
        command,
        ClientInfo {
            name: "ash-code-drop-stdio-test".into(),
            version: "1".into(),
        },
        ClientCapabilities::default(),
    )
    .unwrap();
    #[cfg(unix)]
    let transport_pid = session.process_id().unwrap();
    #[cfg(unix)]
    let server_processes = lifecycle::stdio_processes(&root);
    let mut client = session.client();
    assert!(client.list_sessions().unwrap().sessions.is_empty());

    drop(session);

    assert!(matches!(
        client.list_sessions(),
        Err(ClientError::Transport(_))
    ));
    #[cfg(unix)]
    lifecycle::assert_stdio_closed(&root, transport_pid, &server_processes);
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn remote_runtime_preserves_a_terminal_between_real_connections() {
    let root = test_root("shared-backend");
    let dir = root.join("dir");
    let profile = root.join("profile");
    std::fs::create_dir_all(&dir).unwrap();
    let mut backend = lifecycle::ManagedBackend::start(&root);
    let command = || {
        StdioAppServerCommand::new(remote::executable())
            .with_argument("connect")
            .with_environment_variable("ASH_WORKSPACE_ROOT", dir.clone().into_os_string())
            .with_environment_variable("ASH_HOME", profile.clone().into_os_string())
            .with_environment_variable("HOME", root.join("home"))
            .with_environment_variable("CODEX_HOME", root.join("codex"))
            .with_environment_variable("ZCODE_DATA_BASE_DIR", root.join("zcode"))
    };
    let client_info = || ClientInfo {
        name: "ash-code-remote-backend-test".into(),
        version: "1".into(),
    };

    let first_session =
        AppServerSession::start_stdio(command(), client_info(), ClientCapabilities::default())
            .unwrap();
    let mut first_client = first_session.client();
    let first_pid = first_session.process_id().unwrap();
    let created = first_client
        .terminal_create(TerminalCreateParams {
            dir_id: None,
            rows: 24,
            cols: 80,
            profile: TerminalProfileSelection::Default,
            lifecycle: TerminalLifecycle::Reconnectable,
            env: None,
            cwd: None,
            execution: None,
        })
        .unwrap();
    let first_lease = created.reconnect.unwrap();
    first_session.shutdown().unwrap();
    lifecycle::assert_process_exited(first_pid);
    backend.assert_running();

    let second_session =
        AppServerSession::start_stdio(command(), client_info(), ClientCapabilities::default())
            .unwrap();
    let mut second_client = second_session.client();
    let second_pid = second_session.process_id().unwrap();
    let attached = second_client
        .terminal_attach(TerminalAttachParams {
            dir_id: None,
            terminal_id: created.terminal_id.clone(),
            reconnect_token: first_lease.reconnect_token.clone(),
            rows: 30,
            cols: 100,
        })
        .expect("terminal did not survive the CLI connection");

    assert_ne!(
        attached.reconnect.reconnect_token,
        first_lease.reconnect_token
    );
    second_client
        .terminal_close(TerminalCloseParams {
            dir_id: None,
            terminal_id: created.terminal_id,
        })
        .unwrap();
    second_session.shutdown().unwrap();
    lifecycle::assert_process_exited(second_pid);
    backend.stop();
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn shared_ssh_options_reach_the_real_ash_remote_server_entrypoint() {
    let root = test_root("ssh-transport");
    let dir = root.join("dir");
    let profile_root = root.join("profile");
    let fake_ssh = root.join("fake-ssh");
    fs::create_dir_all(&dir).unwrap();
    let mut backend = lifecycle::ManagedBackend::start(&root);
    assert!(!profile_root.to_string_lossy().contains('\''));
    fs::write(
        &fake_ssh,
        format!(
            "#!/bin/sh\nexport ASH_HOME={} HOME={} CODEX_HOME={} ZCODE_DATA_BASE_DIR={}\ncommand=''\nfor argument in \"$@\"; do command=$argument; done\nexec /bin/sh -c \"$command\"\n",
            lifecycle::quote(profile_root.to_str().unwrap()),
            lifecycle::quote(root.join("home").to_str().unwrap()),
            lifecycle::quote(root.join("codex").to_str().unwrap()),
            lifecycle::quote(root.join("zcode").to_str().unwrap()),
        ),
    )
    .unwrap();
    let mut permissions = fs::metadata(&fake_ssh).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&fake_ssh, permissions).unwrap();
    let remote_profile = RemoteProfile::new(
        SshTarget::new(
            SshHost::parse("local-ssh-double").unwrap(),
            RemoteDirPath::parse(dir.to_str().unwrap()).unwrap(),
        ),
        RemoteRuntime::new_exact_executable(remote::executable()).unwrap(),
    );
    let connection =
        SshAppServerConnectionOptions::new(remote_profile).with_ssh_executable(&fake_ssh);

    let session = connection
        .connect(
            ClientInfo {
                name: "ash-code-local-ssh-test".into(),
                version: "1".into(),
            },
            ClientCapabilities::default(),
        )
        .unwrap();
    let mut client = session.client();
    let transport_pid = session.process_id().unwrap();

    assert!(client.list_sessions().unwrap().sessions.is_empty());

    session.shutdown().unwrap();
    lifecycle::assert_process_exited(transport_pid);
    backend.assert_running();
    backend.stop();
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn openssh_shutdown_reaps_transport_and_remote_runtime() {
    verify_openssh_close(SshClose::Shutdown);
}

#[cfg(unix)]
#[test]
fn openssh_drop_reaps_transport_and_remote_runtime() {
    verify_openssh_close(SshClose::Drop);
}

#[cfg(unix)]
enum SshClose {
    Shutdown,
    Drop,
}

#[cfg(unix)]
fn verify_openssh_close(close: SshClose) {
    let root = test_root("openssh-close");
    let dir = root.join("dir");
    fs::create_dir_all(&dir).unwrap();
    let mut backend = lifecycle::ManagedBackend::start(&root);
    let ssh = ssh::SshDaemon::start(&root);
    let runtime = root.join("remote-runtime");
    fs::write(&runtime, format!(
        "#!/bin/sh\nexport ASH_HOME={} HOME={} CODEX_HOME={} ZCODE_DATA_BASE_DIR={}\nunset ASH_PRODUCT_SERVICES_PATH ASH_APP_SERVER_SHA256\nprintf '%s' \"$$\" > {}\nexec {} \"$@\"\n",
        lifecycle::quote(root.join("profile").to_str().unwrap()),
        lifecycle::quote(root.join("home").to_str().unwrap()),
        lifecycle::quote(root.join("codex").to_str().unwrap()),
        lifecycle::quote(root.join("zcode").to_str().unwrap()),
        lifecycle::quote(root.join("remote.pid").to_str().unwrap()),
        lifecycle::quote(remote::executable()),
    )).unwrap();
    fs::set_permissions(&runtime, fs::Permissions::from_mode(0o755)).unwrap();
    let profile = RemoteProfile::new(
        SshTarget::new(
            SshHost::parse("ash-loopback").unwrap(),
            RemoteDirPath::parse(dir.to_str().unwrap()).unwrap(),
        ),
        RemoteRuntime::new_exact_executable(runtime.to_str().unwrap()).unwrap(),
    );
    let session = SshAppServerConnectionOptions::new(profile)
        .with_ssh_executable(ssh.executable())
        .connect(
            ClientInfo {
                name: "ash-code-openssh-close-test".into(),
                version: "1".into(),
            },
            ClientCapabilities::default(),
        )
        .unwrap();
    let transport_pid = session.process_id().unwrap();
    let remote_pid = fs::read_to_string(root.join("remote.pid"))
        .unwrap()
        .parse()
        .unwrap();
    let connection_processes = ssh.connection_processes();
    let mut client = session.client();
    assert!(client.list_sessions().unwrap().sessions.is_empty());
    match close {
        SshClose::Shutdown => session.shutdown().unwrap(),
        SshClose::Drop => drop(session),
    }
    assert!(matches!(
        client.list_sessions(),
        Err(ClientError::Transport(_))
    ));
    lifecycle::assert_process_exited(transport_pid);
    lifecycle::assert_process_exited(remote_pid);
    // EOF closes the connection carrier; the separately owned profile service must
    // survive it. Only the explicit management command ends that service lifetime.
    backend.assert_running();
    backend.stop();
    ssh.stop(&connection_processes);
    lifecycle::assert_no_open_files(&root);
    fs::remove_dir_all(root).unwrap();
}

fn test_root(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "ash-cli-remote-{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ))
}
#[cfg(unix)]
#[path = "support/lifecycle.rs"]
mod lifecycle;
#[cfg(unix)]
#[path = "support/remote.rs"]
mod remote;
#[cfg(unix)]
#[path = "support/ssh.rs"]
mod ssh;
