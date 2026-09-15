use std::thread;
use std::time::Duration;
use std::time::Instant;

use ash_app_server_client::AppServerEvent;
use ash_app_server_client::AppServerSession;
use ash_app_server_client::ConnectionCloseReason;
use ash_app_server_client::StdioAppServerCommand;
use ash_app_server_protocol::protocol::common::ClientCapabilities;
use ash_app_server_protocol::protocol::common::ClientInfo;
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
    assert_eq!(
        events.recv_timeout(Duration::from_secs(2)).unwrap(),
        AppServerEvent::ConnectionClosed(ConnectionCloseReason::Shutdown)
    );
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
    assert_eq!(
        events.recv_timeout(Duration::from_secs(2)).unwrap(),
        AppServerEvent::ConnectionClosed(ConnectionCloseReason::Shutdown)
    );
}

#[cfg(unix)]
#[test]
fn broker_preserves_a_reconnectable_terminal_between_stdio_clients() {
    let root = tempdir().unwrap();
    let dir = root.path().join("dir");
    let profile = root.path().join("profile");
    std::fs::create_dir(&dir).unwrap();

    let command = || {
        StdioAppServerCommand::new(env!("CARGO_BIN_EXE_ash-remote-server"))
            .with_argument("connect")
            .with_environment_variable("ASH_WORKSPACE_ROOT", dir.clone().into_os_string())
            .with_environment_variable("ASH_HOME", profile.clone().into_os_string())
            .with_environment_variable("ASH_REMOTE_SERVER_IDLE_TIMEOUT_MILLIS", "200")
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
