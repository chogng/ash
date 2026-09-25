use super::AppServer;
use super::ConnectionState;
use crate::local::ProviderModelService;
use ash_core::InMemoryThreadStore;
use ash_core::ThreadController;
use ash_file_access::Dir;
use ash_file_access::DirId;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::Permission;
use ash_file_access::Permissions;
use ash_model_provider::EchoModel;
use ash_protocol::CommandId;
use ash_protocol::ContentDigest;
use ash_utils_path_uri::PathUri;
use core_api::StartThreadRequest;
use std::str::FromStr;
use std::sync::Arc;

#[test]
fn project_rpc_keeps_catalog_associations_separate_from_directory_authority() {
    let fixture = Fixture::new();
    let root_thread = fixture.start_root("project-root-thread");
    let source = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(source.path()).unwrap();
    fixture.grant(&root_thread.session_id, dir.clone());
    let grant_revision = fixture
        .server
        .env_runtime
        .read()
        .unwrap()
        .dir_grants
        .revision(&root_thread.session_id);

    let mut renderer = fixture.server.connection();
    initialize(&fixture.server, &mut renderer);
    let denied = call(
        &fixture.server,
        &mut renderer,
        2,
        "project/list",
        serde_json::json!({}),
    );
    assert_eq!(denied["error"]["message"], "PermissionRequired");

    let mut host = fixture.server.product_host_connection();
    initialize(&fixture.server, &mut host);
    let notifications = fixture.server.connection_notifications(&host);
    let created = call(
        &fixture.server,
        &mut host,
        4,
        "project/create",
        serde_json::json!({
            "commandId": "create-project-rpc",
            "projectId": "project-rpc",
            "name": "Ash",
            "description": "long-lived multi-root entry"
        }),
    );
    assert_eq!(created["result"]["project"]["revision"], 1);
    assert_eq!(notifications.drain().len(), 1);

    let forged = call(
        &fixture.server,
        &mut host,
        5,
        "project/root/add",
        serde_json::json!({
            "commandId": "forged-project-root",
            "projectId": "project-rpc",
            "expectedRevision": 1,
            "sessionId": root_thread.session_id,
            "dirId": DirId::from_str(ContentDigest::sha256(b"forged").as_str()).unwrap(),
            "name": "forged",
            "purpose": "must be rejected"
        }),
    );
    assert_eq!(forged["error"]["message"], "InvalidParams");

    let params = serde_json::json!({
        "commandId": "add-project-root",
        "projectId": "project-rpc",
        "expectedRevision": 1,
        "sessionId": root_thread.session_id,
        "dirId": dir.id(),
        "name": "source",
        "purpose": "primary source root"
    });
    let added = call(
        &fixture.server,
        &mut host,
        6,
        "project/root/add",
        params.clone(),
    );
    assert_eq!(added["result"]["disposition"], "committed");
    assert_eq!(
        added["result"]["project"]["roots"][0]["dirId"],
        dir.id().as_str()
    );
    let root_uri: PathUri =
        serde_json::from_value(added["result"]["project"]["roots"][0]["path"].clone()).unwrap();
    assert_eq!(
        root_uri.to_host_path().unwrap().as_path(),
        dir.canonical_path()
    );
    assert_eq!(
        fixture
            .server
            .env_runtime
            .read()
            .unwrap()
            .dir_grants
            .revision(&root_thread.session_id),
        grant_revision
    );

    let replayed = call(&fixture.server, &mut host, 7, "project/root/add", params);
    assert_eq!(replayed["result"]["disposition"], "replayed");
    let changed = notifications.drain();
    assert_eq!(changed.len(), 1);
    let changed: serde_json::Value = serde_json::from_str(&changed[0]).unwrap();
    assert_eq!(changed["method"], "project/changed");
    assert_eq!(
        changed["params"]["project"]["roots"][0]["path"],
        root_uri.to_string()
    );

    fixture
        .server
        .env_runtime
        .read()
        .unwrap()
        .dir_grants
        .remove_dir(&root_thread.session_id, dir.canonical_path());
    let read = call(
        &fixture.server,
        &mut host,
        8,
        "project/read",
        serde_json::json!({"projectId": "project-rpc"}),
    );
    assert_eq!(
        read["result"]["project"]["roots"].as_array().unwrap().len(),
        1
    );
    assert_eq!(
        read["result"]["project"]["roots"][0]["path"],
        root_uri.to_string()
    );
    assert!(
        fixture
            .server
            .env_runtime
            .read()
            .unwrap()
            .dir_grants
            .authorize(
                &root_thread.session_id,
                dir.canonical_path(),
                Permission::InspectRepository,
            )
            .unwrap()
            .is_none()
    );
}

struct Fixture {
    _directory: tempfile::TempDir,
    server: AppServer,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.sqlite3");
        let threads = Arc::new(ThreadController::with_store(Arc::new(
            InMemoryThreadStore::default(),
        )));
        let server = AppServer::new(
            Arc::clone(&threads),
            Arc::new(ProviderModelService::new(Arc::new(EchoModel))),
        )
        .with_local_projects(&path)
        .unwrap();
        Self {
            _directory: directory,
            server,
        }
    }

    fn start_root(&self, command_id: &str) -> ash_core::ThreadSnapshot {
        self.server
            .start_thread(StartThreadRequest {
                branch_name: None,
                agent_id: None,
                agent: None,
                command_id: CommandId::new(command_id).unwrap(),
                title: command_id.into(),
            })
            .unwrap()
    }

    fn grant(&self, session_id: &ash_protocol::SessionId, dir: Dir) {
        self.server
            .env_runtime
            .read()
            .unwrap()
            .dir_grants
            .add_dir(
                session_id.clone(),
                Grant::for_session_tree(
                    session_id.clone(),
                    dir,
                    GrantSource::HostConfiguration,
                    Permissions::new([
                        Permission::ExecuteCommands,
                        Permission::InspectRepository,
                        Permission::MutateRepository,
                    ]),
                ),
            )
            .unwrap();
    }
}

fn initialize(server: &AppServer, connection: &mut ConnectionState) {
    let initialized = call(
        server,
        connection,
        1,
        "initialize",
        serde_json::json!({
            "clientInfo": {"name": "project-test", "version": "1"},
            "capabilities": {}
        }),
    );
    assert!(initialized.get("result").is_some());
}

fn call(
    server: &AppServer,
    connection: &mut ConnectionState,
    id: u64,
    method: &str,
    params: serde_json::Value,
) -> serde_json::Value {
    serde_json::from_str(
        &server.handle_json(
            connection,
            &serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": method,
                "params": params
            })
            .to_string(),
        ),
    )
    .unwrap()
}
