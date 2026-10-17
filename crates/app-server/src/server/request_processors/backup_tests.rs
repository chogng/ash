use super::BackupRequestProcessor;
use super::ConnectionAuthority;
use super::RpcError;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_state::SqliteBackupStore;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;

#[test]
fn backup_processors_share_the_authoritative_store_without_an_app_server() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(SqliteBackupStore::open(&directory.path().join("state.db")).unwrap());
    let writer = BackupRequestProcessor::new(Arc::clone(&store));
    let recovery = BackupRequestProcessor::new(store);
    let record = writer
        .write(
            ConnectionAuthority::ProductHost,
            &json!({
                "clientId":"editor",
                "workspace":{"id":"workspace","folders":[],"configuration":null},
                "content":{"resource":"untitled:/note","format":"text.v1","content":"未保存\n草稿"},
                "expectedRevision":null
            }),
        )
        .unwrap();
    let query = json!({"clientId":"editor","workspaceId":"workspace"});
    assert_eq!(
        recovery
            .list(ConnectionAuthority::ProductHost, &query)
            .unwrap()["backups"],
        json!([record])
    );
    assert_eq!(
        recovery
            .list(
                ConnectionAuthority::ProductHost,
                &json!({"clientId":"other-editor","workspaceId":"workspace"})
            )
            .unwrap()["backups"],
        json!([])
    );
    recovery
        .discard(
            ConnectionAuthority::ProductHost,
            &json!({
                "clientId":"editor","workspaceId":"workspace",
                "resource":"untitled:/note","expectedRevision":record["revision"]
            }),
        )
        .unwrap();
    assert_eq!(
        writer
            .list(ConnectionAuthority::ProductHost, &query)
            .unwrap()["backups"],
        json!([])
    );
}

#[test]
fn backup_processor_preserves_permissions_and_unavailable_errors_for_every_rpc() {
    type Operation =
        fn(&BackupRequestProcessor, ConnectionAuthority, &Value) -> Result<Value, RpcError>;
    let directory = tempfile::tempdir().unwrap();
    let configured = BackupRequestProcessor::new(Arc::new(
        SqliteBackupStore::open(&directory.path().join("state.db")).unwrap(),
    ));
    let unavailable = BackupRequestProcessor::default();
    let requests: [(Operation, Value); 6] = [
        (
            BackupRequestProcessor::workspaces,
            json!({"clientId":"editor"}),
        ),
        (
            BackupRequestProcessor::list,
            json!({"clientId":"editor","workspaceId":"workspace"}),
        ),
        (
            BackupRequestProcessor::list_page,
            json!({"clientId":"editor","workspaceId":"workspace","afterResource":null}),
        ),
        (
            BackupRequestProcessor::write,
            json!({
                "clientId":"editor",
                "workspace":{"id":"workspace","folders":[],"configuration":null},
                "content":{"resource":"untitled:/note","format":"text.v1","content":"draft"},
                "expectedRevision":null
            }),
        ),
        (
            BackupRequestProcessor::move_records,
            json!({"clientId":"editor", "sourceWorkspaceId":"old", "workspace":{"id":"new","folders":[],"configuration":null},"backups":[]}),
        ),
        (
            BackupRequestProcessor::discard,
            json!({
                "clientId":"editor","workspaceId":"workspace",
                "resource":"untitled:/note","expectedRevision":"stale"
            }),
        ),
    ];
    for (operation, params) in requests {
        for processor in [&configured, &unavailable] {
            for authority in [ConnectionAuthority::Client, ConnectionAuthority::Browser] {
                let denied = operation(processor, authority, &params).unwrap_err();
                assert_eq!(denied.code, -32001);
                assert_eq!(denied.message, AppServerErrorName::PermissionRequired);
            }
            // Keep the existing decode-before-authorize error ordering.
            let invalid =
                operation(processor, ConnectionAuthority::Client, &Value::Null).unwrap_err();
            assert_eq!(invalid.code, -32602);
            assert_eq!(invalid.message, AppServerErrorName::InvalidParams);
        }
        let missing =
            operation(&unavailable, ConnectionAuthority::ProductHost, &params).unwrap_err();
        assert_eq!(missing.code, -32002);
        assert_eq!(missing.message, AppServerErrorName::BackupUnavailable);
    }
}

#[test]
fn backup_move_rpc_is_atomic_and_validates_reopening_uris() {
    let directory = tempfile::tempdir().unwrap();
    let processor = BackupRequestProcessor::new(Arc::new(
        SqliteBackupStore::open(&directory.path().join("state.db")).unwrap(),
    ));
    let record = processor.write(ConnectionAuthority::ProductHost, &json!({"clientId":"editor","workspace":{"id":"old","folders":[],"configuration":null},"content":{"resource":"untitled:/note","format":"text.v1","content":"draft"},"expectedRevision":null})).unwrap();
    let request = json!({"clientId":"editor","sourceWorkspaceId":"old","workspace":{"id":"new","folders":[],"configuration":"file:///team.ash-workspace"},"backups":[{"resource":"untitled:/note","revision":record["revision"]}]});
    let mut invalid = request.clone();
    invalid["workspace"]["configuration"] = json!("relative-path");
    assert_eq!(
        processor
            .move_records(ConnectionAuthority::ProductHost, &invalid)
            .unwrap_err()
            .message,
        AppServerErrorName::InvalidParams
    );
    let moved = processor
        .move_records(ConnectionAuthority::ProductHost, &request)
        .unwrap();
    assert_eq!(moved["backups"][0]["revision"], record["revision"]);
    assert_eq!(
        processor
            .list(
                ConnectionAuthority::ProductHost,
                &json!({"clientId":"editor","workspaceId":"old"})
            )
            .unwrap()["backups"],
        json!([])
    );
    assert_eq!(
        processor
            .list(
                ConnectionAuthority::ProductHost,
                &json!({"clientId":"editor","workspaceId":"new"})
            )
            .unwrap()["backups"],
        json!([record])
    );
}
