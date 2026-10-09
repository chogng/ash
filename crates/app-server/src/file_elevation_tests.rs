use super::call;
use super::initialize;
use super::server;
use ash_file_access::Dir;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::Permission;
use ash_file_access::Permissions;
use ash_file_system::LocalFileSystem;
use std::sync::Arc;

#[test]
fn elevated_file_cancellation_is_connection_scoped_and_prevents_starting_a_write() {
    let root = tempfile::tempdir().unwrap();
    let files = LocalFileSystem::new(Grant::for_environment(
        Dir::open_local(root.path()).unwrap(),
        GrantSource::ExplicitUser,
        Permissions::new([Permission::ReadFiles]),
    ));
    let server = server().with_file_system(Arc::new(files));
    let mut first = server.product_host_connection();
    let mut second = server.product_host_connection();
    initialize(&server, &mut first);
    initialize(&server, &mut second);
    let cancelled = call(
        &server,
        &mut first,
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"fs/writeFileElevated/cancel","params":{"operationId":"save-1"}}),
    );
    assert!(cancelled.get("result").is_some());
    let save = serde_json::json!({"jsonrpc":"2.0","id":3,"method":"fs/writeFileElevated","params":{"operationId":"save-1","path":"file.txt","dataBase64":"ZWRpdA=="}});
    let first_result = call(&server, &mut first, save.clone());
    let second_result = call(&server, &mut second, save);
    assert_eq!(first_result["error"]["data"]["kind"], "RequestCancelled");
    // The other connection reaches its own directory grant gate; cancellation never grants writes.
    assert_eq!(
        second_result["error"]["data"]["kind"],
        "FileSystemOperationFailed"
    );
    assert!(!root.path().join("file.txt").exists());
}

#[test]
fn general_rpc_connections_cannot_request_system_elevation() {
    let server = server();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    for (id, method, params) in [
        (
            2,
            "fs/writeFileElevated",
            serde_json::json!({"operationId":"save", "path":"../outside", "dataBase64":"ZWRpdA=="}),
        ),
        (
            3,
            "fs/writeFileElevated/cancel",
            serde_json::json!({"operationId":"save"}),
        ),
    ] {
        let response = call(
            &server,
            &mut connection,
            serde_json::json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}),
        );
        assert_eq!(response["error"]["data"]["kind"], "PermissionRequired");
    }
}

#[cfg(unix)]
#[test]
fn readonly_system_files_produce_a_distinct_permission_error_for_the_save_retry_entry() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("file.txt");
    std::fs::write(&target, b"original").unwrap();
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o444)).unwrap();
    let files = LocalFileSystem::new(Grant::for_environment(
        Dir::open_local(root.path()).unwrap(),
        GrantSource::ExplicitUser,
        Permissions::new([Permission::ReadFiles, Permission::WriteFiles]),
    ));
    let server = server().with_file_system(Arc::new(files));
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let written = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"fs/writeFile","params":{"path":"file.txt","content":"editor"}}),
    );
    assert_eq!(written["error"]["code"], -32050);
    assert_eq!(written["error"]["data"]["kind"], "FileSystemWriteLocked");
    assert_eq!(std::fs::read(&target).unwrap(), b"original");
}

#[test]
fn explicit_unlock_requires_an_editor_connection_and_a_file_revision() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("file.txt");
    std::fs::write(&target, b"old").unwrap();
    let mut permissions = std::fs::metadata(&target).unwrap().permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(&target, permissions).unwrap();
    let files = LocalFileSystem::new(Grant::for_environment(
        Dir::open_local(root.path()).unwrap(),
        GrantSource::ExplicitUser,
        Permissions::new([Permission::ReadFiles, Permission::WriteFiles]),
    ));
    let server = server().with_file_system(Arc::new(files));
    let mut general = server.connection();
    let mut product = server.product_host_connection();
    initialize(&server, &mut general);
    initialize(&server, &mut product);
    let mut request = serde_json::json!({"jsonrpc":"2.0", "id":2, "method":"fs/writeBinaryFile", "params":{"path":"file.txt", "dataBase64":"bmV3", "options":{"mode":"replace", "unlock":true, "expectedRevision":ash_file_system::file_revision(b"old")}}});
    assert_eq!(
        call(&server, &mut general, request.clone())["error"]["data"]["kind"],
        "PermissionRequired"
    );
    let mut invalid = request.clone();
    invalid["params"]["options"]
        .as_object_mut()
        .unwrap()
        .remove("expectedRevision");
    assert_eq!(
        call(&server, &mut product, invalid)["error"]["data"]["kind"],
        "InvalidParams"
    );
    assert!(std::fs::metadata(&target).unwrap().permissions().readonly());
    request["id"] = serde_json::json!(3);
    let saved = call(&server, &mut product, request);
    assert!(saved.get("result").is_some(), "{saved}");
    assert_eq!(std::fs::read(&target).unwrap(), b"new");
    assert!(!std::fs::metadata(&target).unwrap().permissions().readonly());
}
