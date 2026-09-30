#![cfg(unix)]

use ash_thread_store::ThreadStore;
use exec_server::ExecClient;
use exec_server::SshEndpoint;
use exec_server_protocol::ExecError;
use exec_server_protocol::ProcessInput;
use exec_server_protocol::ProcessRead;
use exec_server_protocol::ProcessStart;
use exec_server_protocol::ProcessState;
use exec_server_protocol::Request;
use exec_server_protocol::Response;
use exec_server_protocol::WriteCondition;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

struct LocalModel(AtomicUsize);
impl core_api::ModelService for LocalModel {
    fn invoke(
        &self,
        _: core_api::ModelSelection<'_>,
        _: &ash_protocol::ModelRequest,
        _: &ash_async_utils::CancellationToken,
    ) -> Result<ash_protocol::ModelResponse, core_api::CoreError> {
        let first = self.0.fetch_add(1, Ordering::Relaxed) == 0;
        Ok(ash_protocol::ModelResponse {
            output: if first {
                vec![ash_protocol::ResponseItem::ToolCall(
                    ash_protocol::ToolCall {
                        id: ash_protocol::ToolCallId::new("remote-write").unwrap(),
                        name: ash_protocol::ToolName::new("environment").unwrap(),
                        arguments: serde_json::json!({"environment":"project","operation":{"type":"write","path":"agent-result","content":"approved SSH write","expected_revision":null}}),
                    },
                )]
            } else {
                vec![ash_protocol::ResponseItem::Text("done".into())]
            },
            usage: None,
            billing: None,
            stop_reason: if first {
                ash_protocol::StopReason::ToolUse
            } else {
                ash_protocol::StopReason::Completed
            },
        })
    }
}

#[test]
fn local_agent_uses_ssh_after_approval_and_keeps_history_local() {
    let host = Host::open();
    let local = tempfile::tempdir().unwrap();
    let store =
        Arc::new(ash_state::SqliteThreadStore::open(local.path().join("state.sqlite3")).unwrap());
    let model = Arc::new(LocalModel(AtomicUsize::new(0)));
    let server = ash_app_server::AppServer::new(
        Arc::new(ash_core::ThreadController::with_store(store.clone())),
        model.clone(),
    )
    .with_ephemeral_env_state()
    .with_execution_environments(vec![exec_server::ExecutionEnvironment::Remote(
        host.client(),
    )])
    .unwrap();
    let mut connection = server.connection();
    let rpc = |connection: &mut ash_app_server::ConnectionState, request: serde_json::Value| {
        let value: serde_json::Value =
            serde_json::from_str(&server.handle_json(connection, &request.to_string())).unwrap();
        assert!(value.get("error").is_none(), "{value}");
        value
    };
    rpc(
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"local-agent-test","version":"1"},"capabilities":{"agentInteractions":{"version":1,"kinds":["approval"]}}}}),
    );
    let created = rpc(
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"session/create","params":{"commandId":"create-local-session","title":"SSH execution","executionTarget":null}}),
    );
    let session = created["result"]["session"]["sessionId"].as_str().unwrap();
    let created = rpc(
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":3,"method":"session/request","params":{"commandId":"create-local-thread","sessionId":session,"request":{"type":"createThread","title":"root"}}}),
    );
    let thread = created["result"]["value"]["threadId"].as_str().unwrap();
    let thread_id = ash_protocol::ThreadId::new(thread).unwrap();
    let started = rpc(
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":4,"method":"session/request","params":{"commandId":"start-local-turn","sessionId":session,"request":{"type":"startTurn","expectedSequence":1,"threadId":thread,"input":[{"type":"text","text":"write the remote file"}]}}}),
    );
    let turn = started["result"]["value"]["turnId"].as_str().unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    let (sequence, request_id) = loop {
        let snapshot = server.threads().read_thread(&thread_id).unwrap();
        if let Some(interaction) = snapshot.turns[0].pending_interaction.as_ref() {
            break (snapshot.sequence, interaction.request_id.to_string());
        }
        assert!(
            Instant::now() < deadline,
            "approval never appeared: {snapshot:?}"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    assert!(!host.files.join("agent-result").exists());
    rpc(
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":5,"method":"session/request","params":{"commandId":"approve-ssh-write","sessionId":session,"request":{"type":"resolveInteraction","expectedSequence":sequence,"threadId":thread,"turnId":turn,"requestId":request_id,"response":{"type":"approval","response":{"decision":"approveOnce"}}}}}),
    );
    loop {
        let snapshot = server.threads().read_thread(&thread_id).unwrap();
        if snapshot.turns[0].status == ash_protocol::TurnStatus::Completed {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "local turn did not complete: {snapshot:?}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(model.0.load(Ordering::Relaxed), 2);
    assert_eq!(
        fs::read_to_string(host.files.join("agent-result")).unwrap(),
        "approved SSH write"
    );
    assert!(!local.path().join("agent-result").exists());
    assert!(store.list_thread_ids().unwrap().contains(&thread_id));
    assert!(!store.load(&thread_id).unwrap().is_empty());
    let remote_store =
        ash_state::SqliteThreadStore::open(host.profile.join("state.sqlite3")).unwrap();
    assert!(
        remote_store.list_thread_ids().unwrap().is_empty(),
        "execution must not create remote Agent history"
    );
    let reloaded = ash_core::ThreadController::with_store(store);
    assert_eq!(
        reloaded.read_thread(&thread_id).unwrap().turns[0].status,
        ash_protocol::TurnStatus::Completed
    );
}

#[test]
fn history_handoff_crosses_ssh_and_process_boundaries_then_remote_restarts_execution_only() {
    use std::io::Write;
    use std::process::Command;
    use std::process::Stdio;

    let host = Host::open();
    let connected = host.client();
    let source =
        Arc::new(ash_state::SqliteThreadStore::open(host.profile.join("state.sqlite3")).unwrap());
    let controller = ash_core::ThreadController::with_store(source.clone());
    let mut originals = Vec::new();
    for (name, root) in [
        ("known-history", Some("/recorded/project")),
        ("unknown-history", None),
    ] {
        let thread = controller
            .create_thread(ash_core::CreateThreadRequest {
                agent_id: ash_protocol::AgentId::new(format!("agent-{name}")).unwrap(),
                origin: ash_protocol::ThreadOrigin::Root,
                agent: None,
                session_id: ash_protocol::SessionId::new(name).unwrap(),
                thread_id: ash_protocol::ThreadId::new(name).unwrap(),
                title: name.into(),
                execution_target: root
                    .map(|root| ash_protocol::SessionExecutionTarget::Local { root: root.into() }),
            })
            .unwrap();
        originals.push((
            thread.thread_id.clone(),
            source.load(&thread.thread_id).unwrap(),
        ));
    }
    let local = tempfile::tempdir().unwrap();
    let backend = PathBuf::from(std::env::var_os("ASH_APP_SERVER_PATH").unwrap());
    let identity = Command::new(&backend)
        .arg("history-identity")
        .env("ASH_HOME", local.path())
        .output()
        .unwrap();
    assert!(
        identity.status.success(),
        "{}",
        String::from_utf8_lossy(&identity.stderr)
    );
    let identity = String::from_utf8(identity.stdout).unwrap();
    let export = || {
        // The selected command directory intentionally differs from the directory recorded in
        // history. Migration must never annotate every old Session with a window's directory.
        Command::new(&host.ssh)
            .args(["-T", "build"])
            .arg(format!(
                "env ASH_WORKSPACE_ROOT=/remote/project '{}' history-export '{}'",
                host.runtime.display(),
                identity.trim()
            ))
            .output()
            .unwrap()
    };
    let archive = export();
    assert!(
        archive.status.success(),
        "{}",
        String::from_utf8_lossy(&archive.stderr)
    );
    drop(connected);
    let import = |bytes: &[u8]| {
        let mut child = Command::new(&backend)
            .args(["history-import", "build"])
            .env("ASH_HOME", local.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(bytes).unwrap();
        child.wait_with_output().unwrap()
    };
    let incomplete = import(&archive.stdout[..archive.stdout.len() - 1]);
    assert!(!incomplete.status.success());
    let local_store =
        Arc::new(ash_state::SqliteThreadStore::open(local.path().join("state.sqlite3")).unwrap());
    assert!(local_store.list_thread_ids().unwrap().is_empty());
    let imported = import(&archive.stdout);
    assert!(
        imported.status.success(),
        "{}",
        String::from_utf8_lossy(&imported.stderr)
    );
    for (thread, original) in &originals {
        assert_eq!(local_store.load(thread).unwrap(), *original);
        assert_eq!(source.load(thread).unwrap(), *original);
    }
    let local_controller = ash_core::ThreadController::with_store(local_store.clone());
    let known = local_controller.read_thread(&originals[0].0).unwrap();
    assert_eq!(
        known.execution_target,
        Some(ash_protocol::SessionExecutionTarget::Ssh {
            host: "build".into(),
            root: "/recorded/project".into()
        })
    );
    assert!(
        local_controller
            .read_thread(&originals[1].0)
            .unwrap()
            .execution_target
            .is_none()
    );
    let bound = Command::new(&backend)
        .args(["history-bind", "unknown-history", "/chosen/project"])
        .env("ASH_HOME", local.path())
        .output()
        .unwrap();
    assert!(
        bound.status.success(),
        "{}",
        String::from_utf8_lossy(&bound.stderr)
    );
    assert_eq!(
        local_controller
            .read_thread(&originals[1].0)
            .unwrap()
            .execution_target,
        Some(ash_protocol::SessionExecutionTarget::Ssh {
            host: "build".into(),
            root: "/chosen/project".into()
        })
    );
    let repeated = export();
    assert!(repeated.status.success());
    assert_eq!(repeated.stdout, archive.stdout);
    assert!(import(&repeated.stdout).status.success());
    let old_agent = Command::new(env!("CARGO_BIN_EXE_ash-remote-server"))
        .args(["app-server", "--listen", "stdio://"])
        .env("ASH_HOME", &host.profile)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        !old_agent.status.success(),
        "frozen profile reopened an Agent writer"
    );
    assert!(old_agent.stdout.is_empty());
    let execution = host.client();
    let Response::File(file) = execution
        .request(Request::FileRead {
            path: "content".into(),
            offset: 0,
            expected_revision: None,
        })
        .unwrap()
    else {
        panic!("expected remote file")
    };
    assert_eq!(file.bytes, b"remote bytes");
    execution
        .write_file(
            "write-1",
            "content",
            &(b"execution remains available".to_vec()),
            WriteCondition::ExpectedRevision(file.revision),
            &ash_async_utils::CancellationSource::new().token(),
        )
        .unwrap();
    for (thread, original) in originals {
        assert_eq!(source.load(&thread).unwrap(), original);
    }
    assert!(source.history_receiver().unwrap().is_some());
}

struct Host {
    _temporary: tempfile::TempDir,
    profile: PathBuf,
    files: PathBuf,
    ssh: PathBuf,
    runtime: PathBuf,
}

impl Host {
    fn open() -> Self {
        Self::with_idle_timeout(5000)
    }

    fn with_idle_timeout(idle_timeout: u64) -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let profile = temporary.path().join("profile");
        let files = temporary.path().join("files");
        fs::create_dir(&files).unwrap();
        let other_files = temporary.path().join("other-files");
        fs::create_dir(&other_files).unwrap();
        fs::write(files.join("content"), "remote bytes").unwrap();
        let ssh = temporary.path().join("ssh");
        let runtime = temporary.path().join("runtime");
        let backend =
            std::env::var_os("ASH_APP_SERVER_PATH").expect("prepared App Server executable");
        fs::write(&ssh, "#!/bin/sh\nfor argument in \"$@\"; do command=$argument; done\nexec /bin/sh -c \"$command\"\n").unwrap();
        fs::write(&runtime, format!(
            "#!/bin/sh\ncase \"$ASH_WORKSPACE_ROOT\" in\n/remote/project) export ASH_WORKSPACE_ROOT='{}';;\n/remote/other) export ASH_WORKSPACE_ROOT='{}';;\n*) exit 66;;\nesac\nexport ASH_HOME='{}'\nexport ASH_APP_SERVER_PATH='{}'\nexport ASH_LOCAL_APP_SERVER_IDLE_TIMEOUT_MILLIS={idle_timeout}\nexec '{}' \"$@\"\n",
            files.display(), other_files.display(), profile.display(), PathBuf::from(backend).display(), env!("CARGO_BIN_EXE_ash-remote-server"),
        )).unwrap();
        for path in [&ssh, &runtime] {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        Self {
            _temporary: temporary,
            profile,
            files,
            ssh,
            runtime,
        }
    }

    fn client(&self) -> ExecClient {
        let result = ExecClient::connect_ssh(
            SshEndpoint::new(
                "build",
                "/remote/project",
                self.runtime.to_str().unwrap(),
                "project",
            )
            .unwrap()
            .with_executable(self.ssh.clone()),
        );
        match result {
            Ok(client) => client,
            Err(error) => {
                let stopped = self.stop();
                let log = fs::read_to_string(&stopped.log_path);
                panic!("execution connection failed: {error}\nmanaged log: {log:?}");
            }
        }
    }

    fn stop(&self) -> ash_app_server_daemon::LifecycleOutput {
        ash_app_server_daemon::run_lifecycle(
            ash_app_server_daemon::LifecycleCommand::Stop,
            ash_app_server_daemon::ConnectionOptions::new(
                &self.profile,
                None,
                ash_app_server_daemon::GrantSource::HostConfiguration,
                None,
            ),
            &PathBuf::from(std::env::var_os("ASH_APP_SERVER_PATH").unwrap()),
        )
        .unwrap()
    }
}

#[test]
fn ssh_environment_cannot_be_rebound_to_another_root() {
    let host = Host::open();
    let _original = host.client();
    let result = ExecClient::connect_ssh(
        SshEndpoint::new(
            "build",
            "/remote/other",
            host.runtime.to_str().unwrap(),
            "project",
        )
        .unwrap()
        .with_executable(host.ssh.clone()),
    );
    assert!(
        matches!(result, Err(exec_server::Error::Remote(ExecError::Conflict))),
        "{result:?}"
    );
}

#[test]
fn stopping_host_cancels_commands_and_old_clients_cannot_mutate_a_new_incarnation() {
    let host = Host::open();
    let client = host.client();
    let original = client.info().incarnation.clone();
    client
        .request(Request::ProcessStart(ProcessStart {
            operation_id: "stop".into(),
            program: "/bin/sh".into(),
            arguments: vec!["-c".into(), "sleep 3; printf escaped > escaped".into()],
            cwd: ".".into(),
            timeout_millis: 10000,
            input: ProcessInput::Closed,
        }))
        .unwrap();
    host.stop();
    assert!(!host.files.join("escaped").exists());
    let replacement = host.client();
    assert_ne!(replacement.info().incarnation, original);
    assert!(matches!(
        client.write_file(
            "write-2",
            "unexpected",
            &(b"must not write".to_vec()),
            WriteCondition::MissingOrEmpty,
            &ash_async_utils::CancellationSource::new().token()
        ),
        Err(exec_server::Error::Remote(ExecError::StaleEnvironment))
    ));
    assert!(!host.files.join("unexpected").exists());
}

impl Drop for Host {
    fn drop(&mut self) {
        let options = ash_app_server_daemon::ConnectionOptions::new(
            &self.profile,
            None,
            ash_app_server_daemon::GrantSource::HostConfiguration,
            None,
        );
        let _ = ash_app_server_daemon::run_lifecycle(
            ash_app_server_daemon::LifecycleCommand::Stop,
            options,
            &PathBuf::from(std::env::var_os("ASH_APP_SERVER_PATH").unwrap()),
        );
    }
}

#[test]
fn ssh_execution_survives_disconnect_and_never_restarts_a_command() {
    let host = Host::with_idle_timeout(100);
    let client = host.client();
    let incarnation = client.info().incarnation.clone();
    assert_eq!(
        PathBuf::from(&client.info().root),
        fs::canonicalize(&host.files).unwrap()
    );
    client
        .request(Request::ProcessStart(ProcessStart {
            operation_id: "once".into(),
            program: "/bin/sh".into(),
            arguments: vec![
                "-c".into(),
                "printf x >> count; printf started; sleep 1; printf done".into(),
            ],
            cwd: ".".into(),
            timeout_millis: 10000,
            input: ProcessInput::Closed,
        }))
        .unwrap();
    drop(client);
    // Exceed the host's idle timeout while its only live resource is the command.
    std::thread::sleep(Duration::from_millis(300));
    let replacement = host.client();
    assert_eq!(replacement.info().incarnation, incarnation);
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let Response::Process(snapshot) = replacement
            .request(Request::ProcessRead(ProcessRead {
                operation_id: "once".into(),
                stdout_cursor: 0,
                stderr_cursor: 0,
                wait_millis: 100,
            }))
            .unwrap()
        else {
            panic!("expected process snapshot");
        };
        if snapshot.state != ProcessState::Running {
            assert_eq!(
                snapshot.state,
                ProcessState::Exited { code: Some(0) },
                "{snapshot:?}"
            );
            assert_eq!(snapshot.stdout.text, "starteddone");
            break;
        }
        assert!(Instant::now() < deadline, "process did not finish");
    }
    assert_eq!(fs::read(host.files.join("count")).unwrap(), b"x");
}

#[test]
fn ssh_files_enforce_root_and_revision_and_cancel_is_explicit() {
    let host = Host::open();
    let client = host.client();
    let Response::File(file) = client
        .request(Request::FileRead {
            path: "content".into(),
            offset: 0,
            expected_revision: None,
        })
        .unwrap()
    else {
        panic!("expected file");
    };
    assert_eq!(file.bytes, b"remote bytes");
    client
        .write_file(
            "write-3",
            "content",
            &(b"edited".to_vec()),
            WriteCondition::ExpectedRevision(file.revision.clone()),
            &ash_async_utils::CancellationSource::new().token(),
        )
        .unwrap();
    assert!(matches!(
        client.write_file(
            "write-4",
            "content",
            &(b"stale".to_vec()),
            WriteCondition::ExpectedRevision(file.revision),
            &ash_async_utils::CancellationSource::new().token()
        ),
        Err(exec_server::Error::Remote(ExecError::Conflict))
    ));
    assert!(matches!(
        client.request(Request::FileRead {
            path: "../escape".into(),
            offset: 0,
            expected_revision: None
        }),
        Err(exec_server::Error::Remote(ExecError::InvalidInput))
    ));
    client
        .request(Request::ProcessStart(ProcessStart {
            operation_id: "cancel".into(),
            program: "/bin/sh".into(),
            arguments: vec!["-c".into(), "sleep 30".into()],
            cwd: ".".into(),
            timeout_millis: 40000,
            input: ProcessInput::Closed,
        }))
        .unwrap();
    client
        .request(Request::ProcessCancel {
            operation_id: "cancel".into(),
        })
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let Response::Process(snapshot) = client
            .request(Request::ProcessRead(ProcessRead {
                operation_id: "cancel".into(),
                stdout_cursor: 0,
                stderr_cursor: 0,
                wait_millis: 100,
            }))
            .unwrap()
        else {
            panic!("expected process");
        };
        if snapshot.state != ProcessState::Running {
            assert_eq!(snapshot.state, ProcessState::Cancelled);
            break;
        }
        assert!(Instant::now() < deadline, "cancellation did not finish");
    }
    assert_eq!(fs::read(host.files.join("content")).unwrap(), b"edited");
}

#[test]
fn ssh_transfers_large_binary_files_in_bounded_frames() {
    let host = Host::open();
    let client = host.client();
    let bytes: Vec<u8> = (0..1024 * 1024 + 7)
        .map(|index| (index % 256) as u8)
        .collect();
    let cancellation = ash_async_utils::CancellationSource::new().token();
    client
        .write_file(
            "large-upload",
            "large",
            &bytes,
            WriteCondition::MissingOrEmpty,
            &cancellation,
        )
        .unwrap();
    let file = client.read_file("large", &cancellation).unwrap();
    assert_eq!(file.bytes, bytes);
    assert_eq!(fs::read(host.files.join("large")).unwrap(), bytes);
    client
        .write_file(
            "large-replace",
            "large",
            b"replaced",
            WriteCondition::ExpectedRevision(file.revision),
            &cancellation,
        )
        .unwrap();
    assert_eq!(fs::read(host.files.join("large")).unwrap(), b"replaced");
}
