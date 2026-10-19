use super::*;

#[test]
fn directory_picker_lists_names_outside_the_current_workspace() {
    let directory = tempfile::tempdir().unwrap();
    let current = directory.path().join("current");
    let other = directory.path().join("other");
    std::fs::create_dir(&current).unwrap();
    std::fs::create_dir(&other).unwrap();
    std::fs::create_dir(other.join("project")).unwrap();
    std::fs::write(other.join("private.txt"), "content").unwrap();

    let request = serde_json::json!({ "path": other }).to_string();
    let listing: WebWorkspaceListResult =
        serde_json::from_str(&list_directories(&current, &request).unwrap()).unwrap();
    assert_eq!(listing.directories.len(), 1);
    assert_eq!(listing.directories[0].name, "project");
}

fn workspace_control_fixture() -> (
    tempfile::TempDir,
    Arc<ProfileAppServerRegistry>,
    ConnectionOptions,
    Arc<AppServer>,
    Mutex<WebWorkspaceSession>,
) {
    let temporary = tempfile::tempdir().unwrap();
    let profile = temporary.path().join("profile");
    let root = temporary.path().join("first");
    std::fs::create_dir(&root).unwrap();
    let root = dunce::canonicalize(&root).unwrap();
    std::fs::create_dir(temporary.path().join("second")).unwrap();
    std::fs::write(root.join("team.ash-workspace"), "{}").unwrap();
    let options = ConnectionOptions::new(
        &profile,
        Some(root.clone()),
        GrantSource::HostConfiguration,
        None,
    );
    let registry = Arc::new(
        ProfileAppServerRegistry::open(options.clone(), ash_app_server_diff::compute).unwrap(),
    );
    let server = registry.open_web_workspace(&options).unwrap();
    let id = server.browser_workspace_id(&root).unwrap();
    let session = Mutex::new(WebWorkspaceSession {
        current: WebWorkspaceState {
            id: id.clone(),
            configuration: None,
            folders: vec![WebWorkspaceFolder {
                id,
                path: dunce::canonicalize(root)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                name: None,
            }],
        },
        pending: None,
        completed: None,
    });
    (temporary, registry, options, server, session)
}

fn update_body(root: &Path, second: &Path, transaction: &str) -> String {
    serde_json::json!({ "operation": "apply", "transaction": transaction, "configuration": url::Url::from_file_path(root.join("team.ash-workspace")).unwrap(), "folders": [{ "path": root, "name": "First" }, { "path": second, "name": "Second" }], "approved": true }).to_string()
}

#[test]
fn browser_workspace_control_requires_host_approval_and_rolls_back_without_touching_desktop() {
    let (temporary, registry, options, server, session) = workspace_control_fixture();
    let root = options.dir_root().unwrap();
    let second = dunce::canonicalize(temporary.path().join("second")).unwrap();
    let cached = registry.server_for(options.clone()).unwrap();
    cached.browser_workspace_id(root).unwrap();
    assert!(cached.resolve_file_path(root).is_ok());
    assert!(!Arc::ptr_eq(&cached, &server));
    let active = Mutex::new(true);
    let transaction = "11111111-1111-4111-8111-111111111111";
    let body = update_body(root, &second, transaction);
    let denied = update_workspace_state(&server, &session, &active, &body, |_| false).unwrap_err();
    assert_eq!(denied.kind(), io::ErrorKind::PermissionDenied);
    assert!(
        !server.web_workspace_authorizes_directory(
            &ash_file_access::Dir::open_local(&second).unwrap()
        )
    );
    let mut approvals = Vec::new();
    let next: WebWorkspaceState = serde_json::from_str(
        &update_workspace_state(&server, &session, &active, &body, |path| {
            approvals.push(path.to_path_buf());
            true
        })
        .unwrap(),
    )
    .unwrap();
    assert_eq!(approvals, [second.clone()]);
    assert_eq!(next.folders.len(), 2);
    assert_eq!(session.lock().unwrap().current.folders.len(), 1);
    assert!(cached.resolve_file_path(&second.join("file.txt")).is_err());
    let retained = server.resolve_file_path(&second.join("file.txt")).unwrap();
    let ash_app_server_protocol::protocol::fs::FsDirectoryTarget::Environment { dir_id } =
        retained.target
    else {
        panic!("root should have an environment target")
    };
    // A different transaction cannot replace unacknowledged authorization.
    let competing = update_body(root, &second, "22222222-2222-4222-8222-222222222222");
    assert_eq!(
        update_workspace_state(&server, &session, &active, &competing, |_| true)
            .unwrap_err()
            .kind(),
        io::ErrorKind::WouldBlock
    );
    let rollback =
        serde_json::json!({ "operation": "finish", "transaction": transaction, "accepted": false })
            .to_string();
    update_workspace_state(&server, &session, &active, &rollback, |_| {
        panic!("rollback does not prompt")
    })
    .unwrap();
    assert!(server.resolve_file_path(&second.join("file.txt")).is_err());
    assert!(!dir_id.is_empty());
    assert_eq!(session.lock().unwrap().current.folders.len(), 1);
    assert!(cached.resolve_file_path(root).is_ok());
    update_workspace_state(&server, &session, &active, &rollback, |_| unreachable!()).unwrap();
    let opposite =
        serde_json::json!({ "operation": "finish", "transaction": transaction, "accepted": true })
            .to_string();
    assert_eq!(
        update_workspace_state(&server, &session, &active, &opposite, |_| unreachable!())
            .unwrap_err()
            .kind(),
        io::ErrorKind::WouldBlock
    );
    server.close_web_workspace();
}

#[test]
fn browser_workspace_close_during_host_approval_rejects_the_late_result() {
    let (temporary, _registry, options, server, session) = workspace_control_fixture();
    let body = update_body(
        options.dir_root().unwrap(),
        &temporary.path().join("second"),
        "33333333-3333-4333-8333-333333333333",
    );
    let active = Arc::new(Mutex::new(true));
    let (entered, waiting) = std::sync::mpsc::channel();
    let (release, resume) = std::sync::mpsc::channel();
    let worker_server = Arc::clone(&server);
    let worker_active = Arc::clone(&active);
    let result = std::thread::spawn(move || {
        update_workspace_state(&worker_server, &session, &worker_active, &body, |_| {
            entered.send(()).unwrap();
            resume.recv().unwrap();
            true
        })
    });
    waiting
        .recv_timeout(std::time::Duration::from_secs(10))
        .unwrap();
    *active.lock().unwrap() = false;
    server.close_web_workspace();
    release.send(()).unwrap();
    assert_eq!(
        result.join().unwrap().unwrap_err().kind(),
        io::ErrorKind::Interrupted
    );
    assert!(
        server
            .resolve_file_path(&temporary.path().join("second/file.txt"))
            .is_err()
    );
}

fn workspace_rpc(server: &AppServer, method: &str, params: serde_json::Value) -> serde_json::Value {
    let mut connection = server.connection();
    let initialize = serde_json::json!({"jsonrpc":"2.0", "id":1,"method":"initialize","params":{"clientInfo":{"name":"web-native-test","version":"1"}}});
    let initialized: serde_json::Value =
        serde_json::from_str(&server.handle_json(&mut connection, &initialize.to_string()))
            .unwrap();
    assert!(initialized.get("error").is_none(), "{initialized}");
    let request = serde_json::json!({"jsonrpc":"2.0","id":2,"method":method,"params":params});
    let result =
        serde_json::from_str(&server.handle_json(&mut connection, &request.to_string())).unwrap();
    server.close_connection(connection);
    result
}

#[test]
fn native_web_approval_grants_session_file_writes_without_persisting_trust() {
    let (temporary, registry, options, server, session) = workspace_control_fixture();
    let second = dunce::canonicalize(temporary.path().join("second")).unwrap();
    let body = update_body(
        options.dir_root().unwrap(),
        &second,
        "44444444-4444-4444-8444-444444444444",
    );
    update_workspace_state(&server, &session, &Mutex::new(true), &body, |_| true).unwrap();
    let route = server.resolve_file_path(&second.join("saved.txt")).unwrap();
    let ash_app_server_protocol::protocol::fs::FsDirectoryTarget::Environment { dir_id } =
        route.target
    else {
        panic!("native root must have an environment proof")
    };
    let write = workspace_rpc(
        &server,
        "fs/writeFile",
        serde_json::json!({"dirId":dir_id,"path":"saved.txt","content":"native approval"}),
    );
    assert!(write.get("error").is_none(), "{write}");
    assert_eq!(
        std::fs::read(second.join("saved.txt")).unwrap(),
        b"native approval"
    );
    let config = server.config.as_ref().unwrap().read_snapshot().unwrap();
    assert!(
        config
            .values
            .directory_grants
            .explicit_permissions_for(&ash_file_access::Dir::open_local(&second).unwrap().id())
            .is_none()
    );
    let cached = registry
        .server_for(ConnectionOptions::new(
            options.profile_root(),
            Some(second.clone()),
            GrantSource::UserConfig,
            None,
        ))
        .unwrap();
    assert!(
        workspace_rpc(
            &cached,
            "fs/writeFile",
            serde_json::json!({"path":"desktop.txt","content":"no session grant"})
        )
        .get("error")
        .is_some()
    );
    server.close_web_workspace();
    assert!(
        workspace_rpc(
            &server,
            "fs/writeFile",
            serde_json::json!({"dirId":dir_id,"path":"closed.txt","content":"closed"})
        )
        .get("error")
        .is_some()
    );
}

#[test]
fn native_web_open_installs_only_the_approved_proof_before_startup() {
    let (temporary, registry, options, server, _session) = workspace_control_fixture();
    let second = dunce::canonicalize(temporary.path().join("second")).unwrap();
    let directory = ash_file_access::Dir::open_local(&second).unwrap();
    let grant = server.approve_web_directory(directory).unwrap();
    let selected = ConnectionOptions::new(
        options.profile_root(),
        Some(second.clone()),
        GrantSource::UserConfig,
        None,
    );
    let revision = server
        .config
        .as_ref()
        .unwrap()
        .read_snapshot()
        .unwrap()
        .revision;
    let opened = registry
        .open_native_web_workspace(&selected, grant, revision)
        .unwrap();
    let id = opened.browser_workspace_id(&second).unwrap();
    let permissions = workspace_rpc(&opened, "env/dir/read", serde_json::json!({"dirId":id}));
    assert!(
        permissions["result"]["permissions"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("writeFiles"))
    );
    assert!(
        !permissions["result"]["permissions"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("executeCommands"))
    );
    let saved = workspace_rpc(
        &opened,
        "fs/writeFile",
        serde_json::json!({"dirId":id,"path":"opened.txt","content":"native open"}),
    );
    assert!(saved.get("error").is_none(), "{saved}");
    assert_eq!(
        std::fs::read(second.join("opened.txt")).unwrap(),
        b"native open"
    );
    assert!(
        opened
            .config
            .as_ref()
            .unwrap()
            .read_snapshot()
            .unwrap()
            .values
            .directory_grants
            .entries
            .is_empty()
    );
    opened.close_web_workspace();
    let directory = ash_file_access::Dir::open_local(&second).unwrap();
    let stale = server.approve_web_directory(directory.clone()).unwrap();
    let config = server.config.as_ref().unwrap();
    let readonly = config
        .apply(ash_config::ConfigCommandRequest {
            command_id: ash_protocol::CommandId::new("open-readonly").unwrap(),
            expected_revision: revision,
            command: ash_config::UserConfigCommand::SetDirectoryGrant {
                dir: directory.id(),
                permissions: ash_file_access::Permissions::new([
                    ash_file_access::Permission::ReadFiles,
                    ash_file_access::Permission::BrowseFiles,
                ]),
                display_path: None,
            },
        })
        .unwrap();
    config
        .apply(ash_config::ConfigCommandRequest {
            command_id: ash_protocol::CommandId::new("open-forget").unwrap(),
            expected_revision: readonly.revision,
            command: ash_config::UserConfigCommand::ForgetDirectoryGrant {
                dir: directory.id(),
            },
        })
        .unwrap();
    let opened = registry
        .open_native_web_workspace(&selected, stale, revision)
        .unwrap();
    let saved = workspace_rpc(
        &opened,
        "fs/writeFile",
        serde_json::json!({"path":"stale-open.txt","content":"must not revive consent"}),
    );
    assert!(saved.get("error").is_some(), "{saved}");
    assert!(!second.join("stale-open.txt").exists());
    opened.close_web_workspace();
}
