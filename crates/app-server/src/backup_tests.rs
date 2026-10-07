use super::call;
use super::initialize;
use super::server;
use serde_json::json;
use std::sync::Arc;

#[test]
fn backup_rpc_preserves_content_across_connections_and_profile_restart() {
    let profile = tempfile::tempdir().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let open = || {
        crate::open_app_server(
            crate::AppServerOptions::new(profile.path())
                .with_dir_root(directory.path())
                .with_agent_model_service(Arc::new(crate::local::ProviderModelService::new(
                    Arc::new(super::EchoModel),
                ))),
        )
        .unwrap()
    };
    let first = open();
    let mut connection = first.product_host_connection();
    initialize_product(&first, &mut connection);
    let write = call(
        &first,
        &mut connection,
        json!({"jsonrpc":"2.0", "id":2, "method":"backup/write", "params":{
            "clientId":"editor", "workspace":{"id":"empty", "folders":[], "configuration":null},
            "content":{"resource":"untitled:/note", "format":"text.v1", "content":"unsaved\n内容"}, "expectedRevision":null,
        }}),
    );
    assert!(write.get("result").is_some(), "{write}");
    first.close_connection(connection);
    drop(first);
    let restarted = open();
    let mut connection = restarted.product_host_connection();
    initialize_product(&restarted, &mut connection);
    let list = call(
        &restarted,
        &mut connection,
        json!({"jsonrpc":"2.0", "id":3, "method":"backup/list", "params":{"clientId":"editor", "workspaceId":"empty"}}),
    );
    assert_eq!(list["result"]["backups"], json!([write["result"]]));
    let workspaces = call(
        &restarted,
        &mut connection,
        json!({"jsonrpc":"2.0", "id":4, "method":"backup/workspaces", "params":{"clientId":"editor"}}),
    );
    assert_eq!(
        workspaces["result"]["workspaces"],
        json!([{"id":"empty", "folders":[], "configuration":null, "remoteAuthority":null}])
    );
    restarted.close_connection(connection);
}

#[test]
fn backup_rpc_rejects_untrusted_readers_invalid_uris_and_stale_deletes() {
    let directory = tempfile::tempdir().unwrap();
    let server = server().with_backup_store(Arc::new(
        ash_state::SqliteBackupStore::open(&directory.path().join("state.db")).unwrap(),
    ));
    let mut untrusted = server.connection();
    initialize(&server, &mut untrusted);
    let denied = call(
        &server,
        &mut untrusted,
        json!({"jsonrpc":"2.0", "id":2, "method":"backup/list", "params":{"clientId":"editor", "workspaceId":"empty"}}),
    );
    assert_eq!(denied["error"]["data"]["kind"], "PermissionRequired");
    let mut trusted = server.product_host_connection();
    initialize(&server, &mut trusted);
    let mut request = json!({"jsonrpc":"2.0", "id":3, "method":"backup/write", "params":{
        "clientId":"editor", "workspace":{"id":"empty", "folders":[], "configuration":null},
        "content":{"resource":"invalid URI", "format":"text.v1", "content":"draft"}, "expectedRevision":null,
    }});
    assert_eq!(
        call(&server, &mut trusted, request.clone())["error"]["data"]["kind"],
        "InvalidParams"
    );
    request["params"]["content"]["resource"] = json!("untitled:/note");
    request["id"] = json!(4);
    let response = call(&server, &mut trusted, request.clone());
    assert!(response.get("result").is_some(), "{response}");
    let initial = response["result"].clone();
    request["params"]["expectedRevision"] = initial["revision"].clone();
    request["params"]["content"]["content"] = json!("newer");
    request["id"] = json!(5);
    let latest = call(&server, &mut trusted, request)["result"].clone();
    let stale = call(
        &server,
        &mut trusted,
        json!({"jsonrpc":"2.0", "id":6, "method":"backup/discard", "params":{
            "clientId":"editor", "workspaceId":"empty", "resource":"untitled:/note", "expectedRevision":initial["revision"],
        }}),
    );
    assert_eq!(stale["error"]["data"]["kind"], "BackupRevisionConflict");
    let list = call(
        &server,
        &mut trusted,
        json!({"jsonrpc":"2.0", "id":7, "method":"backup/list", "params":{"clientId":"editor", "workspaceId":"empty"}}),
    );
    assert_eq!(list["result"]["backups"], json!([latest]));
    server.close_connection(trusted);
    server.close_connection(untrusted);
}

fn initialize_product(server: &crate::AppServer, connection: &mut crate::ConnectionState) {
    let response = call(
        server,
        connection,
        json!({"jsonrpc":"2.0", "id":1, "method":"initialize", "params":{"clientInfo":{"name":"backup-test", "version":"1"}, "capabilities":{}}}),
    );
    assert!(response.get("result").is_some(), "{response}");
}
