use ash_app_server_client::AppServerSession;
use ash_app_server_client::ClientError;
use ash_app_server_client::StdioAppServerCommand;
use ash_app_server_protocol::protocol::common::ClientCapabilities;
use ash_app_server_protocol::protocol::common::ClientInfo;
use tempfile::tempdir;

#[test]
fn app_server_serves_an_explicit_dir_over_stdio() {
    let root = tempdir().unwrap();
    let dir = root.path().join("dir");
    let profile = root.path().join("profile");
    std::fs::create_dir(&dir).unwrap();
    let command = StdioAppServerCommand::new(env!("CARGO_BIN_EXE_ash-app-server"))
        .with_argument("--listen")
        .with_argument("stdio://")
        .with_environment_variable("ASH_WORKSPACE_ROOT", dir.into_os_string())
        .with_environment_variable("ASH_HOME", profile.into_os_string());
    let session = AppServerSession::start_stdio(
        command,
        ClientInfo {
            name: "ash-app-server-test".into(),
            version: "1".into(),
        },
        ClientCapabilities::default(),
    )
    .unwrap();
    let mut client = session.client();

    assert!(client.list_sessions().unwrap().sessions.is_empty());
    session.shutdown().unwrap();
}

#[test]
fn app_server_without_dir_does_not_inherit_its_current_directory() {
    let root = tempdir().unwrap();
    let profile = root.path().join("profile");
    let command = StdioAppServerCommand::new(env!("CARGO_BIN_EXE_ash-app-server"))
        .with_argument("--listen")
        .with_argument("stdio://")
        .without_environment_variable("ASH_WORKSPACE_ROOT")
        .with_environment_variable("ASH_HOME", profile.into_os_string());
    let session = AppServerSession::start_stdio(
        command,
        ClientInfo {
            name: "ash-app-server-empty-dir-test".into(),
            version: "1".into(),
        },
        ClientCapabilities::default(),
    )
    .unwrap();
    let mut client = session.client();

    assert_eq!(
        client.git_status().unwrap_err(),
        ClientError::Server {
            code: -32060,
            message: "GitUnavailable".into(),
        }
    );
    session.shutdown().unwrap();
}

#[test]
fn memories_round_trip_through_a_real_process_and_survive_restart() {
    use ash_app_server_protocol::protocol::memory::*;
    use ash_protocol::CommandId;
    let root = tempdir().unwrap();
    let profile = root.path().join("memory-profile");
    let start = || {
        AppServerSession::start_stdio(
            StdioAppServerCommand::new(env!("CARGO_BIN_EXE_ash-app-server"))
                .with_argument("--listen")
                .with_argument("stdio://")
                .without_environment_variable("ASH_WORKSPACE_ROOT")
                .with_environment_variable("ASH_HOME", profile.clone().into_os_string()),
            ClientInfo {
                name: "memory-process-test".into(),
                version: "1".into(),
            },
            ClientCapabilities::default(),
        )
        .unwrap()
    };
    let first = start();
    assert!(first.process_id().is_some());
    let mut client = first.client();
    let scope = memories::MemoryScope::Profile;
    let initial = client
        .memory_scopes(MemoryScopesParams { thread_id: None })
        .unwrap();
    assert_eq!(initial.scopes.len(), 1);
    assert_eq!(
        initial.scopes[0].policy,
        memories::MemoryPolicy::disabled(scope.clone())
    );
    let added = client
        .add_memory(MemoryAddParams {
            command_id: CommandId::new("add").unwrap(),
            memory_id: memories::MemoryId::new("process-memory").unwrap(),
            scope: scope.clone(),
            title: "Rust process test".into(),
            body: "Persist this Rust memory across restarts".into(),
        })
        .unwrap();
    let updated = client
        .update_memory(MemoryUpdateParams {
            command_id: CommandId::new("edit").unwrap(),
            memory_id: added.memory.memory_id.clone(),
            scope: scope.clone(),
            expected_revision: 1,
            title: "Rust process test".into(),
            body: "Edited Rust memory 跨进程".into(),
        })
        .unwrap();
    client
        .update_memory_policy(MemoryPolicyUpdateParams {
            command_id: CommandId::new("consent").unwrap(),
            scope: scope.clone(),
            expected_revision: 0,
            automatic_read: memories::MemoryReadMode::FirstInvocation,
            model_write: memories::MemoryWriteMode::Enabled,
        })
        .unwrap();
    first.shutdown().unwrap();
    let second = start();
    let mut client = second.client();
    assert_eq!(
        client
            .read_memory(MemoryReadParams {
                memory_id: updated.memory.memory_id.clone(),
                scope: scope.clone()
            })
            .unwrap(),
        updated.memory
    );
    let policy = client
        .read_memory_policy(MemoryPolicyReadParams {
            scope: scope.clone(),
        })
        .unwrap();
    assert_eq!(policy.model_write, memories::MemoryWriteMode::Enabled);
    let hit = client
        .search_memories(MemorySearchParams {
            scope: scope.clone(),
            query: "跨进程".into(),
            cursor: None,
            limit: None,
        })
        .unwrap()
        .matches
        .remove(0);
    assert_eq!(
        client
            .read_memory_citation(MemoryCitationReadParams {
                citation: hit.citation.clone()
            })
            .unwrap()
            .body,
        hit.excerpt
    );
    client
        .delete_memory(MemoryDeleteParams {
            command_id: CommandId::new("delete").unwrap(),
            scope: scope.clone(),
            memory_id: updated.memory.memory_id,
            expected_revision: 2,
        })
        .unwrap();
    assert!(matches!(
        client.read_memory_citation(MemoryCitationReadParams {
            citation: hit.citation
        }),
        Err(ClientError::Server { code: -32131, .. })
    ));
    second.shutdown().unwrap();
}
