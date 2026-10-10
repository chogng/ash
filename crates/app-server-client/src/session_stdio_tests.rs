use super::StdioAppServerCommand;
use super::request_id;
use super::response_id;
use std::path::Path;

#[test]
fn stdio_command_preserves_process_arguments_and_environment() {
    let command = StdioAppServerCommand::new("ash-remote-server")
        .with_argument("app-server")
        .with_environment_variable("ASH_WORKSPACE_ROOT", "/srv/ash");

    assert_eq!(command.executable(), Path::new("ash-remote-server"));
    assert_eq!(command.arguments_as_strings(), vec!["app-server"]);
    assert_eq!(command.environment.len(), 1);
}

#[test]
fn stdio_command_explicit_environment_policy_uses_the_last_setting() {
    let removed = StdioAppServerCommand::new("ash")
        .with_environment_variable("ASH_WORKSPACE_ROOT", "/srv/ash")
        .without_environment_variable("ASH_WORKSPACE_ROOT");
    assert!(removed.environment.is_empty());
    assert_eq!(removed.removed_environment.len(), 1);

    let restored = removed.with_environment_variable("ASH_WORKSPACE_ROOT", "/srv/next");
    assert_eq!(restored.environment.len(), 1);
    assert!(restored.removed_environment.is_empty());
}

#[test]
fn stdio_driver_accepts_only_positive_numeric_request_and_response_ids() {
    assert_eq!(
        request_id(r#"{"jsonrpc":"2.0","id":7,"method":"initialize","params":{}}"#).unwrap(),
        7
    );
    assert_eq!(
        response_id(r#"{"jsonrpc":"2.0","id":7,"result":{}}"#).unwrap(),
        7
    );
    assert!(
        request_id(r#"{"jsonrpc":"2.0","id":"seven","method":"initialize","params":{}}"#).is_err()
    );
    assert!(response_id(r#"{"jsonrpc":"2.0","id":0,"result":{}}"#).is_err());
}

#[cfg(any(unix, windows))]
mod lifecycle {
    use super::StdioAppServerCommand;
    use crate::AppServerSession;
    use crate::ClientError;
    use ash_app_server_protocol::protocol::common::ClientCapabilities;
    use ash_app_server_protocol::protocol::common::ClientInfo;
    use ash_app_server_protocol::protocol::common::SchemaHash;
    use ash_app_server_protocol::protocol::common::ServerInfo;
    use ash_app_server_protocol::protocol::initialize::InitializeResult;
    use ash_app_server_protocol::protocol::initialize::ProtocolVersion;
    use ash_app_server_protocol::protocol::initialize::ServerCapabilities;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicU64;
    use std::sync::atomic::Ordering;
    use std::time::SystemTime;
    use std::time::UNIX_EPOCH;

    struct Fixture {
        root: PathBuf,
        command: StdioAppServerCommand,
    }

    impl Fixture {
        fn new(response: serde_json::Value) -> Self {
            // Windows clock samples can coincide across parallel tests. Allocate a
            // unique suffix before creating the directory instead of retrying creation.
            static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);
            let root = std::env::temp_dir().join(format!(
                "ash-stdio-eof-{}-{}-{}",
                std::process::id(),
                NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir(&root).unwrap();
            let command = server_command()
                .with_environment_variable("ASH_STDIO_TEST_FILE", root.join("held"))
                .with_environment_variable("ASH_STDIO_TEST_EOF", root.join("eof"))
                .with_environment_variable("ASH_STDIO_TEST_PID", root.join("pid"))
                .with_environment_variable("ASH_STDIO_TEST_RESPONSE", response.to_string());
            Self { root, command }
        }

        fn start(&self) -> Result<AppServerSession, ClientError> {
            let result = AppServerSession::start_stdio(
                self.command.clone(),
                ClientInfo {
                    name: "stdio-lifecycle-test".into(),
                    version: "1".into(),
                },
                ClientCapabilities::default(),
            );
            #[cfg(unix)]
            if result.is_ok() {
                let held = std::process::Command::new("lsof")
                    .args(["-t", "--"])
                    .arg(self.root.join("held"))
                    .output()
                    .unwrap();
                assert!(
                    held.status.success(),
                    "fixture did not hold its file: {held:?}"
                );
            }
            result
        }

        fn assert_closed(self) {
            assert_eq!(
                std::fs::read_to_string(self.root.join("eof")).unwrap(),
                "closed"
            );
            #[cfg(unix)]
            {
                let pid = std::fs::read_to_string(self.root.join("pid")).unwrap();
                let process = std::process::Command::new("/bin/kill")
                    .args(["-0", &pid])
                    .output()
                    .unwrap();
                assert!(
                    !process.status.success(),
                    "stdio process {pid} survived shutdown"
                );
                let handles = std::process::Command::new("lsof")
                    .args(["-t", "--"])
                    .arg(self.root.join("held"))
                    .output()
                    .unwrap();
                assert_eq!(handles.status.code(), Some(1), "{handles:?}");
                assert!(
                    handles.stdout.is_empty() && handles.stderr.is_empty(),
                    "{handles:?}"
                );
            }
            // Unix unlink alone permits open handles; the checks above precede deletion.
            std::fs::remove_dir_all(self.root).unwrap();
        }
    }

    #[cfg(windows)]
    fn server_command() -> StdioAppServerCommand {
        let powershell = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        // The marker proves that the server observed EOF and ran cleanup. Reaping a
        // forcibly killed process can release its file, but cannot produce this marker.
        StdioAppServerCommand::new(powershell)
            .with_argument("-NoLogo")
            .with_argument("-NoProfile")
            .with_argument("-NonInteractive")
            .with_argument("-Command")
            .with_argument(
                r#"$ErrorActionPreference = 'Stop'
$held = [System.IO.File]::Open($env:ASH_STDIO_TEST_FILE, 'Create', 'ReadWrite', 'None')
$null = [Console]::ReadLine()
[Console]::WriteLine($env:ASH_STDIO_TEST_RESPONSE)
while ($null -ne [Console]::ReadLine()) {}
$held.Dispose()
[System.IO.File]::WriteAllText($env:ASH_STDIO_TEST_EOF, 'closed')"#,
            )
    }

    #[cfg(unix)]
    fn server_command() -> StdioAppServerCommand {
        StdioAppServerCommand::new("/bin/sh")
            .with_argument("-c")
            .with_argument(
                r#"exec 9>"$ASH_STDIO_TEST_FILE"
printf '%s' "$$" > "$ASH_STDIO_TEST_PID"
IFS= read -r request || exit 65
printf '%s\n' "$ASH_STDIO_TEST_RESPONSE"
while IFS= read -r request; do :; done
exec 9>&-
printf 'closed' > "$ASH_STDIO_TEST_EOF""#,
            )
    }

    fn initialization() -> InitializeResult {
        InitializeResult {
            server_info: ServerInfo {
                name: "stdio-fixture".into(),
                version: "1".into(),
                operating_system: None,
                user_home: None,
            },
            protocol_version: ProtocolVersion::current(),
            schema_hash: SchemaHash(ash_app_server_protocol::schema_hash()),
            capabilities: ServerCapabilities {
                sessions: true,
                threads: true,
                turns: true,
                ..ServerCapabilities::default()
            },
            slash_commands: Vec::new(),
        }
    }

    #[test]
    fn shutdown_waits_for_server_eof_cleanup_with_surviving_client() {
        let fixture =
            Fixture::new(serde_json::json!({"jsonrpc":"2.0", "id":1, "result":initialization()}));
        let session = fixture.start().unwrap();
        let mut client = session.client();
        session.shutdown().unwrap();
        assert!(matches!(
            client.list_sessions(),
            Err(ClientError::Transport(_))
        ));
        fixture.assert_closed();
    }

    #[test]
    fn dropping_stdio_session_waits_for_server_eof_cleanup() {
        let fixture =
            Fixture::new(serde_json::json!({"jsonrpc":"2.0", "id":1, "result":initialization()}));
        let session = fixture.start().unwrap();
        let _client = session.client();
        drop(session);
        fixture.assert_closed();
    }

    #[test]
    fn incompatible_initialization_waits_for_server_eof_cleanup() {
        let mut result = initialization();
        result.protocol_version.major += 1;
        let fixture = Fixture::new(serde_json::json!({"jsonrpc":"2.0", "id":1, "result":result}));
        assert!(
            matches!(fixture.start(), Err(ClientError::Protocol(message)) if message.contains("protocol major mismatch"))
        );
        fixture.assert_closed();
    }

    #[test]
    fn rejected_initialization_preserves_error_and_waits_for_server_eof_cleanup() {
        let fixture = Fixture::new(
            serde_json::json!({"jsonrpc":"2.0", "id":1, "error":{"code":-32001, "message":"NotInitialized"}}),
        );
        assert!(
            matches!(fixture.start(), Err(ClientError::Server { code: -32001, message }) if message == "NotInitialized")
        );
        fixture.assert_closed();
    }
}
