use super::*;
use crate::local::ProviderModelService;
use ash_core::InMemoryThreadStore;
use ash_core::ThreadController;
use ash_core_plugins::PluginActivationAuthority;
use ash_core_plugins::PluginAuthorityCommandId;
use ash_model_provider::EchoModel;
use ash_plugin::LocalPluginPackage;
use std::fs;
use std::sync::Arc;
use tempfile::tempdir;

#[test]
fn declarative_extensions_are_manageable_without_becoming_effective_on_install() {
    let source = tempdir().unwrap();
    fs::create_dir_all(source.path().join(".ash-plugin")).unwrap();
    fs::create_dir_all(source.path().join("matcher")).unwrap();
    fs::write(
        source.path().join("matcher/package.json"),
        r#"{"name":"matcher","publisher":"acme","version":"1.0.0","contributes":{}}"#,
    )
    .unwrap();
    fs::write(
        source.path().join(".ash-plugin/plugin.json"),
        r#"{
            "schemaVersion":1,"id":"acme/matcher","version":"1.0.0","displayName":"Matcher",
            "compatibility":{"ash":">=0.1.0"},
            "contributions":{"declarativeExtensions":[{"id":"matcher","path":"matcher"}]},
            "permissions":[]
        }"#,
    )
    .unwrap();
    let profile = tempdir().unwrap();
    let server = plugin_server(profile.path());
    server
        .plugin_authority()
        .unwrap()
        .install_local(
            PluginAuthorityCommandId::new("install-matcher").unwrap(),
            0,
            &LocalPluginPackage::load(source.path()).unwrap(),
        )
        .unwrap();
    let mut connection = initialized_connection(&server);
    let listed = call(
        &server,
        &mut connection,
        2,
        "plugin/list",
        serde_json::json!({}),
    );
    let package = &listed["result"]["packages"][0];
    assert_eq!(package["hasEditorExtensions"], true);
    assert_eq!(package["enabled"], false);
    assert_eq!(package["granted"], false);
    assert_eq!(package["effective"], false);
}
#[test]
fn app_server_projects_and_mutates_distinct_plugin_authority_layers() {
    let source = tempdir().unwrap();
    fs::create_dir_all(source.path().join(".ash-plugin")).unwrap();
    fs::create_dir_all(source.path().join("skills/review")).unwrap();
    fs::write(source.path().join("skills/review/SKILL.md"), "# Review").unwrap();
    fs::write(
        source.path().join(".ash-plugin/plugin.json"),
        r#"{
            "schemaVersion": 1,
            "id": "acme/review",
            "version": "1.0.0",
            "displayName": "Review",
            "compatibility": {"ash": ">=0.1.0"},
            "contributions": {"skills": [{"id": "review", "path": "skills/review"}]},
            "permissions": []
        }"#,
    )
    .unwrap();
    let profile = tempdir().unwrap();
    let authority = PluginActivationAuthority::open(profile.path()).unwrap();
    let installed = authority
        .install_local(
            PluginAuthorityCommandId::new("install-review").unwrap(),
            0,
            &LocalPluginPackage::load(source.path()).unwrap(),
        )
        .unwrap()
        .package;
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    let server = AppServer::new(
        threads,
        Arc::new(ProviderModelService::new(Arc::new(EchoModel))),
    )
    .with_plugin_authority(authority);
    let mut connection = server.connection();
    call(
        &server,
        &mut connection,
        1,
        "initialize",
        serde_json::json!({
            "clientInfo": {"name": "test", "version": "1"},
            "capabilities": {}
        }),
    );

    let initial = call(
        &server,
        &mut connection,
        2,
        "plugin/list",
        serde_json::json!({}),
    );
    assert_eq!(initial["result"]["packages"][0]["enabled"], false);
    assert_eq!(
        initial["result"]["packages"][0]["hasEditorExtensions"],
        false
    );
    assert_eq!(initial["result"]["packages"][0]["granted"], false);
    assert_eq!(initial["result"]["packages"][0]["effective"], false);
    let target = |command_id: &str, expected_revision: u64| {
        serde_json::json!({
            "commandId": command_id,
            "expectedRevision": expected_revision,
            "id": installed.id.as_str(),
            "version": installed.version.to_string(),
            "digest": installed.digest.as_str()
        })
    };
    let grant = call(
        &server,
        &mut connection,
        3,
        "plugin/grant",
        target("grant-review", 1),
    );
    assert_eq!(grant["result"]["activationGeneration"], 1);
    let enable = call(
        &server,
        &mut connection,
        4,
        "plugin/enable",
        target("enable-review", 2),
    );
    assert_eq!(enable["result"]["activationGeneration"], 2);

    let effective = call(
        &server,
        &mut connection,
        5,
        "plugin/list",
        serde_json::json!({}),
    );
    assert_eq!(effective["result"]["packages"][0]["enabled"], true);
    assert_eq!(effective["result"]["packages"][0]["granted"], true);
    assert_eq!(effective["result"]["packages"][0]["effective"], true);
}

#[test]
fn sdk_package_installation_is_retry_safe_and_requires_separate_enablement_and_grant() {
    let workspace = tempdir().unwrap();
    write_sdk_package(&workspace.path().join("extension"));
    let profile = tempdir().unwrap();
    let server = plugin_server(profile.path());
    server.env_runtime.write().unwrap().selected_grant =
        Some(ash_file_access::Grant::for_environment(
            ash_file_access::Dir::open_local(workspace.path()).unwrap(),
            ash_file_access::GrantSource::ExplicitUser,
            ash_file_access::Permissions::new([ash_file_access::Permission::ReadFiles]),
        ));
    let mut connection = initialized_connection(&server);
    let params =
        serde_json::json!({"commandId":"install-sdk","expectedRevision":0,"path":"extension"});
    let installed = call(
        &server,
        &mut connection,
        2,
        "plugin/installLocal",
        params.clone(),
    );
    assert_eq!(installed["result"]["id"], "acme/sdk");
    assert_eq!(installed["result"]["command"]["revision"], 1);
    let replay = call(&server, &mut connection, 3, "plugin/installLocal", params);
    assert_eq!(replay["result"]["command"]["disposition"], "replayed");
    assert_eq!(replay["result"]["digest"], installed["result"]["digest"]);
    let list = call(
        &server,
        &mut connection,
        4,
        "plugin/list",
        serde_json::json!({}),
    );
    assert_eq!(
        list["result"]["packages"],
        serde_json::json!([{
            "id":"acme/sdk", "version":"1.0.0", "digest":installed["result"]["digest"],
            "displayName":"SDK fixture", "permissions":[{"type":"directory","access":"read"}],
            "hasEditorExtensions":true, "enabled":false, "granted":false, "effective":false, "revoked":false
        }])
    );
    let target = |command: &str, revision: u64| {
        serde_json::json!({
            "commandId":command,"expectedRevision":revision,"id":"acme/sdk","version":"1.0.0","digest":installed["result"]["digest"]
        })
    };
    let enable = call(
        &server,
        &mut connection,
        5,
        "plugin/enable",
        target("enable-sdk", 1),
    );
    assert_eq!(enable["result"]["activationGeneration"], 1);
    let grant = call(
        &server,
        &mut connection,
        6,
        "plugin/grant",
        target("grant-sdk", 2),
    );
    assert_eq!(grant["result"]["activationGeneration"], 2);
    let persisted = PluginActivationAuthority::open(profile.path()).unwrap();
    assert_eq!(persisted.snapshot().activation().packages().len(), 1);
    let disable = call(
        &server,
        &mut connection,
        7,
        "plugin/disable",
        target("disable-sdk", 3),
    );
    assert_eq!(disable["result"]["activationGeneration"], 3);
    let revoke = call(
        &server,
        &mut connection,
        8,
        "plugin/revokeGrant",
        target("revoke-sdk", 4),
    );
    assert_eq!(revoke["result"]["revision"], 5, "{revoke}");
    let removed = call(
        &server,
        &mut connection,
        9,
        "plugin/uninstall",
        target("uninstall-sdk", 5),
    );
    assert_eq!(removed["result"]["revision"], 6, "{removed}");
    assert!(
        PluginActivationAuthority::open(profile.path())
            .unwrap()
            .snapshot()
            .installed()
            .is_empty()
    );
}

#[test]
fn sdk_installation_rejects_missing_authority_escapes_and_stale_revisions() {
    let workspace = tempdir().unwrap();
    write_sdk_package(&workspace.path().join("extension"));
    let profile = tempdir().unwrap();
    let server = plugin_server(profile.path());
    let mut connection = initialized_connection(&server);
    let params = |path: &str| serde_json::json!({"commandId":"install-sdk","expectedRevision":0,"path":path});
    let missing = call(
        &server,
        &mut connection,
        2,
        "plugin/installLocal",
        params("extension"),
    );
    assert_eq!(missing["error"]["data"]["kind"], "InvalidParams");
    let grant = ash_file_access::Grant::for_environment(
        ash_file_access::Dir::open_local(workspace.path()).unwrap(),
        ash_file_access::GrantSource::ExplicitUser,
        ash_file_access::Permissions::new([ash_file_access::Permission::ReadFiles]),
    );
    server.env_runtime.write().unwrap().selected_grant = Some(grant.clone());
    for (index, path) in [
        "",
        "../extension",
        "extension/../extension",
        workspace.path().to_str().unwrap(),
    ]
    .into_iter()
    .enumerate()
    {
        let rejected = call(
            &server,
            &mut connection,
            3 + index as u64,
            "plugin/installLocal",
            params(path),
        );
        assert_eq!(
            rejected["error"]["data"]["kind"], "InvalidParams",
            "{rejected}"
        );
    }
    let unknown_directory = call(
        &server,
        &mut connection,
        7,
        "plugin/installLocal",
        serde_json::json!({"commandId":"install-sdk","expectedRevision":0,"path":"extension","dirId":"unknown"}),
    );
    assert_eq!(unknown_directory["error"]["data"]["kind"], "InvalidParams");
    let stale = call(
        &server,
        &mut connection,
        8,
        "plugin/installLocal",
        serde_json::json!({"commandId":"install-sdk","expectedRevision":99,"path":"extension"}),
    );
    assert_eq!(stale["error"]["data"]["kind"], "PluginRevisionConflict");
    grant.revoke();
    let revoked = call(
        &server,
        &mut connection,
        9,
        "plugin/installLocal",
        params("extension"),
    );
    assert_eq!(revoked["error"]["data"]["kind"], "PermissionRequired");
    assert!(
        server
            .plugin_authority()
            .unwrap()
            .snapshot()
            .installed()
            .is_empty()
    );
}

#[cfg(unix)]
#[test]
fn sdk_installation_rejects_a_package_link_outside_the_authorized_directory() {
    let workspace = tempdir().unwrap();
    let outside = tempdir().unwrap();
    write_sdk_package(&outside.path().join("extension"));
    std::os::unix::fs::symlink(
        outside.path().join("extension"),
        workspace.path().join("extension"),
    )
    .unwrap();
    let profile = tempdir().unwrap();
    let server = plugin_server(profile.path());
    server.env_runtime.write().unwrap().selected_grant =
        Some(ash_file_access::Grant::for_environment(
            ash_file_access::Dir::open_local(workspace.path()).unwrap(),
            ash_file_access::GrantSource::ExplicitUser,
            ash_file_access::Permissions::new([ash_file_access::Permission::ReadFiles]),
        ));
    let mut connection = initialized_connection(&server);
    let rejected = call(
        &server,
        &mut connection,
        2,
        "plugin/installLocal",
        serde_json::json!({"commandId":"install-sdk","expectedRevision":0,"path":"extension"}),
    );
    assert_eq!(rejected["error"]["data"]["kind"], "InvalidParams");
    assert!(
        server
            .plugin_authority()
            .unwrap()
            .snapshot()
            .installed()
            .is_empty()
    );
}

fn write_sdk_package(root: &std::path::Path) {
    fs::create_dir_all(root.join(".ash-plugin")).unwrap();
    fs::write(root.join("extension.js"), "export function activate() {}\n").unwrap();
    fs::write(root.join(".ash-plugin/plugin.json"), r#"{
        "schemaVersion":1,"id":"acme/sdk","version":"1.0.0","displayName":"SDK fixture",
        "compatibility":{"ash":">=0.1.0"},
        "contributions":{"editorExtensions":[{"id":"inspect","runtime":"javascript","entrypoint":"extension.js","runtimeApiVersion":1,"activationEvents":[{"type":"onCommand","id":"acme.inspect"}],"capabilities":["command"]}]},
        "permissions":[{"type":"directory","access":"read"}]
    }"#).unwrap();
}

fn plugin_server(profile: &std::path::Path) -> AppServer {
    AppServer::new(
        Arc::new(ThreadController::with_store(Arc::new(
            InMemoryThreadStore::default(),
        ))),
        Arc::new(ProviderModelService::new(Arc::new(EchoModel))),
    )
    .with_plugin_authority(PluginActivationAuthority::open(profile).unwrap())
}

fn initialized_connection(server: &AppServer) -> crate::server::ConnectionState {
    let mut connection = server.connection();
    assert!(
        call(
            server,
            &mut connection,
            1,
            "initialize",
            serde_json::json!({"clientInfo":{"name":"test","version":"1"},"capabilities":{}})
        )["result"]
            .is_object()
    );
    connection
}

fn call(
    server: &AppServer,
    connection: &mut crate::server::ConnectionState,
    id: u64,
    method: &str,
    params: Value,
) -> Value {
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    serde_json::from_str(&server.handle_json(connection, &request.to_string())).unwrap()
}
