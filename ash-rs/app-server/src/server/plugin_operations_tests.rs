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
