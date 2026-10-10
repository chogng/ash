use std::thread;
use std::time::Duration;
use std::time::Instant;

use ash_app_server_client::AppServerEvent;
use ash_app_server_client::AppServerEvents;
use ash_app_server_client::AppServerSession;
use ash_app_server_client::ConnectionCloseReason;
use ash_app_server_client::StdioAppServerCommand;
use ash_app_server_protocol::protocol::common::ClientCapabilities;
use ash_app_server_protocol::protocol::common::ClientInfo;
use ash_app_server_protocol::protocol::environment::EnvDirsSetParams;
use ash_app_server_protocol::protocol::fs::FsReadFileParams;
use ash_app_server_protocol::protocol::fs::FsWriteFileParams;
#[cfg(unix)]
use ash_app_server_protocol::protocol::terminal::TerminalAttachParams;
use ash_app_server_protocol::protocol::terminal::TerminalCloseParams;
use ash_app_server_protocol::protocol::terminal::TerminalCreateParams;
use ash_app_server_protocol::protocol::terminal::TerminalLifecycle;
use ash_app_server_protocol::protocol::terminal::TerminalProfileSelection;
use ash_app_server_protocol::protocol::terminal::TerminalReadParams;
use ash_app_server_protocol::protocol::terminal::TerminalWriteParams;
use base64::Engine;
use tempfile::tempdir;

#[test]
fn remote_directories_share_a_backend_with_separate_authorities() {
    let root = tempdir().unwrap();
    let profile = root.path().join("profile");
    let first_dir = root.path().join("first");
    let second_dir = root.path().join("second");
    for (dir, content) in [(&first_dir, "first"), (&second_dir, "second")] {
        std::fs::create_dir(dir).unwrap();
        std::fs::write(dir.join("file.txt"), content).unwrap();
    }
    let connect = |dir: Option<&std::path::Path>| {
        let mut command = StdioAppServerCommand::new(env!("CARGO_BIN_EXE_ash-remote-server"))
            .with_argument("connect")
            .with_environment_variable("ASH_HOME", profile.clone().into_os_string())
            .with_environment_variable("ASH_LOCAL_APP_SERVER_IDLE_TIMEOUT_MILLIS", "200")
            .without_environment_variable("ASH_WORKSPACE_ROOT");
        if let Some(dir) = dir {
            command = command.with_environment_variable("ASH_WORKSPACE_ROOT", dir.as_os_str());
        }
        AppServerSession::start_stdio(
            command,
            ClientInfo {
                name: "remote-profile-test".into(),
                version: "1".into(),
            },
            ClientCapabilities::default(),
        )
        .unwrap()
    };
    let backend = std::env::var_os("ASH_APP_SERVER_PATH")
        .expect("the targeted test runner must prepare the packaged App Server executable");
    let status = || {
        ash_app_server_daemon::run_lifecycle(
            ash_app_server_daemon::LifecycleCommand::Version,
            ash_app_server_daemon::ConnectionOptions::new(
                &profile,
                None,
                ash_app_server_daemon::GrantSource::HostConfiguration,
                None,
            ),
            std::path::Path::new(&backend),
        )
        .unwrap()
    };
    let first = connect(Some(&first_dir));
    let initial = status();
    let second = connect(Some(&second_dir));
    let empty = connect(None);
    let shared = status();
    assert!(initial.pid.is_some());
    assert_eq!(shared.pid, initial.pid);
    assert_eq!(shared.instance_id, initial.instance_id);

    let read = |path: std::path::PathBuf| FsReadFileParams {
        dir_id: None,
        session_directory: None,
        path,
    };
    let mut first_client = first.client();
    let mut second_client = second.client();
    assert_eq!(
        first_client
            .read_file(read("file.txt".into()))
            .unwrap()
            .content,
        "first"
    );
    assert_eq!(
        second_client
            .read_file(read("file.txt".into()))
            .unwrap()
            .content,
        "second"
    );
    assert!(
        first_client
            .read_file(read(second_dir.join("file.txt")))
            .is_err()
    );
    assert!(
        empty
            .client()
            .read_file(read(first_dir.join("file.txt")))
            .is_err()
    );

    // The shared process must preserve exact-revision save conflicts across connections.
    let same_dir = connect(Some(&first_dir));
    let before = first_client.read_file(read("file.txt".into())).unwrap();
    same_dir
        .client()
        .write_file(FsWriteFileParams {
            dir_id: None,
            session_directory: None,
            path: "file.txt".into(),
            content: "changed externally".into(),
            expected_revision: Some(before.revision.clone()),
        })
        .unwrap();
    assert!(
        first_client
            .write_file(FsWriteFileParams {
                dir_id: None,
                session_directory: None,
                path: "file.txt".into(),
                content: "unsaved editor text".into(),
                expected_revision: Some(before.revision),
            })
            .is_err()
    );
    assert_eq!(
        std::fs::read_to_string(first_dir.join("file.txt")).unwrap(),
        "changed externally"
    );

    first.shutdown().unwrap();
    assert_eq!(status().pid, initial.pid);
    assert_eq!(
        second_client
            .read_file(read("file.txt".into()))
            .unwrap()
            .content,
        "second"
    );
    same_dir.shutdown().unwrap();
    empty.shutdown().unwrap();
    second.shutdown().unwrap();
    ash_app_server_daemon::run_lifecycle(
        ash_app_server_daemon::LifecycleCommand::Stop,
        ash_app_server_daemon::ConnectionOptions::new(
            &profile,
            None,
            ash_app_server_daemon::GrantSource::HostConfiguration,
            None,
        ),
        std::path::Path::new(&backend),
    )
    .unwrap();
}

#[test]
fn empty_remote_connection_has_no_directory_authority() {
    let targets = if cfg!(unix) {
        vec![vec!["app-server", "--listen", "stdio://"], vec!["connect"]]
    } else {
        vec![vec!["app-server", "--listen", "stdio://"]]
    };
    for arguments in targets {
        let root = tempdir().unwrap();
        let mut command = StdioAppServerCommand::new(env!("CARGO_BIN_EXE_ash-remote-server"))
            .without_environment_variable("ASH_WORKSPACE_ROOT")
            .with_environment_variable("ASH_HOME", root.path().join("profile").into_os_string())
            .with_environment_variable("ASH_LOCAL_APP_SERVER_IDLE_TIMEOUT_MILLIS", "200");
        for argument in arguments {
            command = command.with_argument(argument);
        }
        let session = AppServerSession::start_stdio(
            command,
            ClientInfo {
                name: "empty-remote-test".into(),
                version: "1".into(),
            },
            ClientCapabilities::default(),
        )
        .unwrap();
        assert!(
            session
                .client()
                .set_env_dirs(EnvDirsSetParams { dirs: vec![] })
                .unwrap()
                .dirs
                .is_empty()
        );
        let outside = root.path().join("outside.txt");
        std::fs::write(&outside, "requires a folder grant").unwrap();
        assert!(
            session
                .client()
                .read_file(FsReadFileParams {
                    dir_id: None,
                    session_directory: None,
                    path: outside,
                })
                .is_err()
        );
        session.shutdown().unwrap();
    }
}

#[test]
fn remote_server_serves_a_schema_checked_stdio_session() {
    let root = tempdir().unwrap();
    let dir = root.path().join("dir");
    let profile = root.path().join("profile");
    std::fs::create_dir(&dir).unwrap();

    let command = StdioAppServerCommand::new(env!("CARGO_BIN_EXE_ash-remote-server"))
        .with_argument("app-server")
        .with_argument("--listen")
        .with_argument("stdio://")
        .with_environment_variable("ASH_WORKSPACE_ROOT", dir.into_os_string())
        .with_environment_variable("ASH_HOME", profile.into_os_string());
    let mut session = AppServerSession::start_stdio(
        command,
        ClientInfo {
            name: "remote-server-test".into(),
            version: "1".into(),
        },
        ClientCapabilities::default(),
    )
    .unwrap();
    let mut client = session.client();
    let events = session.take_events().unwrap();

    assert!(client.list_sessions().unwrap().sessions.is_empty());

    session.shutdown().unwrap();
    assert_shutdown_event(&events);
}

#[test]
fn remote_server_forwards_the_terminal_lifecycle_over_stdio() {
    let root = tempdir().unwrap();
    let dir = root.path().join("dir");
    let profile = root.path().join("profile");
    std::fs::create_dir(&dir).unwrap();

    let command = StdioAppServerCommand::new(env!("CARGO_BIN_EXE_ash-remote-server"))
        .with_argument("app-server")
        .with_argument("--listen")
        .with_argument("stdio://")
        .with_environment_variable("ASH_WORKSPACE_ROOT", dir.into_os_string())
        .with_environment_variable("ASH_HOME", profile.into_os_string());
    let mut session = AppServerSession::start_stdio(
        command,
        ClientInfo {
            name: "remote-terminal-test".into(),
            version: "1".into(),
        },
        ClientCapabilities::default(),
    )
    .unwrap();
    let events = session.take_events().unwrap();
    let mut client = session.client();
    let created = client
        .terminal_create(TerminalCreateParams {
            dir_id: None,
            rows: 24,
            cols: 80,
            profile: TerminalProfileSelection::Default,
            lifecycle: TerminalLifecycle::ConnectionOwned,
            env: None,
        })
        .unwrap();
    #[cfg(windows)]
    let input = "echo ash-remote-terminal-ready\r\nexit\r\n";
    #[cfg(not(windows))]
    let input = "printf 'ash-remote-terminal-ready\\n'\nexit\n";
    client
        .terminal_write(TerminalWriteParams {
            dir_id: None,
            terminal_id: created.terminal_id.clone(),
            data: input.into(),
        })
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(5);
    let mut after_sequence = 0;
    let mut after_command_sequence = 0;
    let mut output = Vec::new();
    let mut exit_code = None;
    while Instant::now() < deadline {
        let read = client
            .terminal_read(TerminalReadParams {
                dir_id: None,
                terminal_id: created.terminal_id.clone(),
                after_sequence,
                after_command_sequence,
                max_chunks: 128,
            })
            .unwrap();
        after_sequence = read.next_sequence;
        after_command_sequence = read.next_command_sequence;
        for chunk in read.chunks {
            output.extend(
                base64::engine::general_purpose::STANDARD
                    .decode(chunk.data_base64)
                    .unwrap(),
            );
        }
        if read.exited {
            exit_code = read.exit_code;
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }

    assert_eq!(exit_code, Some(0));
    assert!(String::from_utf8_lossy(&output).contains("ash-remote-terminal-ready"));
    client
        .terminal_close(TerminalCloseParams {
            dir_id: None,
            terminal_id: created.terminal_id,
        })
        .unwrap();

    session.shutdown().unwrap();
    assert_shutdown_event(&events);
}

fn assert_shutdown_event(events: &AppServerEvents) {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .expect("connection must close within two seconds");
        match events.recv_timeout(remaining).unwrap() {
            // Notifications queued before shutdown remain ahead of the terminal event.
            AppServerEvent::Notification(_) => {}
            AppServerEvent::ConnectionClosed(reason) => {
                assert_eq!(reason, ConnectionCloseReason::Shutdown);
                return;
            }
        }
    }
}

#[cfg(unix)]
#[test]
fn shared_backend_preserves_a_reconnectable_terminal_between_stdio_clients() {
    let root = tempdir().unwrap();
    let dir = root.path().join("dir");
    let profile = root.path().join("profile");
    std::fs::create_dir(&dir).unwrap();

    let command = || {
        StdioAppServerCommand::new(env!("CARGO_BIN_EXE_ash-remote-server"))
            .with_argument("connect")
            .with_environment_variable("ASH_WORKSPACE_ROOT", dir.clone().into_os_string())
            .with_environment_variable("ASH_HOME", profile.clone().into_os_string())
            .with_environment_variable("ASH_LOCAL_APP_SERVER_IDLE_TIMEOUT_MILLIS", "200")
    };
    let client_info = || ClientInfo {
        name: "remote-terminal-reconnect-test".into(),
        version: "1".into(),
    };

    let first_session =
        AppServerSession::start_stdio(command(), client_info(), ClientCapabilities::default())
            .unwrap();
    let mut first_client = first_session.client();
    let created = first_client
        .terminal_create(TerminalCreateParams {
            dir_id: None,
            rows: 24,
            cols: 80,
            profile: TerminalProfileSelection::Default,
            lifecycle: TerminalLifecycle::Reconnectable,
            env: None,
        })
        .unwrap();
    let lease = created.reconnect.unwrap();
    first_client
        .terminal_write(TerminalWriteParams {
            dir_id: None,
            terminal_id: created.terminal_id.clone(),
            data: "printf 'ash-reconnected-terminal\\n'\n".into(),
        })
        .unwrap();
    first_session.shutdown().unwrap();
    thread::sleep(Duration::from_millis(500));

    let second_session =
        AppServerSession::start_stdio(command(), client_info(), ClientCapabilities::default())
            .unwrap();
    let mut second_client = second_session.client();
    let attach_deadline = Instant::now() + Duration::from_secs(2);
    let attached = loop {
        match second_client.terminal_attach(TerminalAttachParams {
            dir_id: None,
            terminal_id: created.terminal_id.clone(),
            reconnect_token: lease.reconnect_token.clone(),
            rows: 30,
            cols: 100,
        }) {
            Ok(attached) => break attached,
            Err(error) if Instant::now() < attach_deadline => {
                let _ = error;
                thread::sleep(Duration::from_millis(20));
            }
            Err(error) => panic!("terminal did not become attachable: {error}"),
        }
    };
    assert_ne!(attached.reconnect.reconnect_token, lease.reconnect_token);

    let read_deadline = Instant::now() + Duration::from_secs(5);
    let mut after_sequence = 0;
    let mut after_command_sequence = 0;
    let mut output = Vec::new();
    while Instant::now() < read_deadline {
        let read = second_client
            .terminal_read(TerminalReadParams {
                dir_id: None,
                terminal_id: created.terminal_id.clone(),
                after_sequence,
                after_command_sequence,
                max_chunks: 128,
            })
            .unwrap();
        after_sequence = read.next_sequence;
        after_command_sequence = read.next_command_sequence;
        for chunk in read.chunks {
            output.extend(
                base64::engine::general_purpose::STANDARD
                    .decode(chunk.data_base64)
                    .unwrap(),
            );
        }
        if String::from_utf8_lossy(&output).contains("ash-reconnected-terminal") {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    assert!(String::from_utf8_lossy(&output).contains("ash-reconnected-terminal"));

    second_client
        .terminal_close(TerminalCloseParams {
            dir_id: None,
            terminal_id: created.terminal_id,
        })
        .unwrap();
    second_session.shutdown().unwrap();
    thread::sleep(Duration::from_millis(500));
}
