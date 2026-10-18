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
            ash_app_server_diff::compute,
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

#[test]
fn backup_rpc_pages_recovery_and_keeps_the_product_host_boundary() {
    let directory = tempfile::tempdir().unwrap();
    let store =
        Arc::new(ash_state::SqliteBackupStore::open(&directory.path().join("state.db")).unwrap());
    let workspace = ash_state::BackupWorkspace {
        id: "workspace".into(),
        folders: vec![],
        configuration: None,
        remote_authority: None,
    };
    for index in 0..3 {
        store
            .write(
                "editor",
                &workspace,
                &ash_state::BackupContent {
                    resource: format!("untitled:/note-{index}"),
                    format: "text.v1".into(),
                    content: "\0".repeat(4 * 1024 * 1024),
                },
                None,
            )
            .unwrap();
    }
    let server = server().with_backup_store(store);
    let mut untrusted = server.connection();
    initialize(&server, &mut untrusted);
    let mut request = json!({"jsonrpc":"2.0", "id":2, "method":"backup/listPage", "params":{"clientId":"editor", "workspaceId":"workspace", "afterResource":null}});
    let denied = call(&server, &mut untrusted, request.clone());
    assert_eq!(denied["error"]["data"]["kind"], "PermissionRequired");
    let mut trusted = server.product_host_connection();
    initialize_product(&server, &mut trusted);
    let mut resources = Vec::new();
    loop {
        let response = call(&server, &mut trusted, request.clone());
        assert!(response.get("error").is_none(), "{response}");
        assert!(serde_json::to_vec(&response).unwrap().len() < 50 * 1024 * 1024);
        let backups = response["result"]["backups"].as_array().unwrap();
        assert_eq!(backups.len(), 1);
        resources.push(backups[0]["content"]["resource"].clone());
        let cursor = response["result"]["nextResource"].clone();
        if cursor.is_null() {
            break;
        }
        request["params"]["afterResource"] = cursor;
        request["id"] = json!(request["id"].as_u64().unwrap() + 1);
    }
    assert_eq!(
        resources,
        vec![
            json!("untitled:/note-0"),
            json!("untitled:/note-1"),
            json!("untitled:/note-2")
        ]
    );
    server.close_connection(trusted);
    server.close_connection(untrusted);
}

#[test]
fn backup_rpc_move_routes_only_product_hosts_and_retires_the_old_catalog() {
    let directory = tempfile::tempdir().unwrap();
    let server = server().with_backup_store(Arc::new(
        ash_state::SqliteBackupStore::open(&directory.path().join("state.db")).unwrap(),
    ));
    let mut trusted = server.product_host_connection();
    initialize(&server, &mut trusted);
    let record = call(&server, &mut trusted, json!({"jsonrpc":"2.0","id":2,"method":"backup/write","params":{"clientId":"editor","workspace":{"id":"old","folders":[],"configuration":null},"content":{"resource":"untitled:/note","format":"text.v1","content":"draft"},"expectedRevision":null}}))["result"].clone();
    let request = json!({"jsonrpc":"2.0","id":3,"method":"backup/move","params":{"clientId":"editor","sourceWorkspaceId":"old","workspace":{"id":"new","folders":[],"configuration":null},"backups":[{"resource":"untitled:/note","revision":record["revision"]}]}});
    let mut untrusted = server.connection();
    initialize(&server, &mut untrusted);
    assert_eq!(
        call(&server, &mut untrusted, request.clone())["error"]["data"]["kind"],
        "PermissionRequired"
    );
    let moved = call(&server, &mut trusted, request);
    assert_eq!(
        moved["result"]["backups"],
        json!([{"resource":"untitled:/note","revision":record["revision"]}])
    );
    let catalog = call(
        &server,
        &mut trusted,
        json!({"jsonrpc":"2.0","id":4,"method":"backup/workspaces","params":{"clientId":"editor"}}),
    );
    assert_eq!(
        catalog["result"]["workspaces"],
        json!([{"id":"new","folders":[],"configuration":null,"remoteAuthority":null}])
    );
    server.close_connection(trusted);
    server.close_connection(untrusted);
}
