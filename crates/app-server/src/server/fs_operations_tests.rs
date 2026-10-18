use super::*;
use crate::AppServer;
use ash_file_access::Dir;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::Permissions;
use serde_json::json;
use std::fs;
use std::sync::Arc;

fn server(root: &std::path::Path) -> AppServer {
    AppServer::new(
        Arc::new(ash_core::ThreadController::with_store(Arc::new(
            ash_core::InMemoryThreadStore::default(),
        ))),
        Arc::new(crate::local::ProviderModelService::new(Arc::new(
            ash_model_provider::EchoModel,
        ))),
    )
    .with_ephemeral_env_state()
    .with_file_system(Arc::new(LocalFileSystem::new(Grant::for_environment(
        Dir::open_local(root).unwrap(),
        GrantSource::ExplicitUser,
        Permissions::new([Permission::ReadFiles, Permission::WriteFiles]),
    ))))
}

#[test]
fn editor_encoding_requests_write_exact_bytes_and_protect_revisions() {
    let dir = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
    let server = server(dir.path());
    let connection = server.connection();
    for encoding in ["utf8bom", "utf16le", "utf16be", "gbk", "shiftjis"] {
        let text = "中文";
        let written = server.fs_processor().fs_write_file(&connection, &json!({"path":"text", "content":text, "encoding":encoding,"options":{"mode":"createOrReplace"}})).unwrap_or_else(|error| panic!("{error}"));
        let bytes = fs::read(dir.path().join("text")).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(bytes, encode_text(text, encoding).unwrap());
        assert_eq!(written["revision"], file_revision(&bytes));
        let read = server
            .fs_processor()
            .fs_read_file(0, &json!({"path":"text","encoding":encoding}))
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(read["content"], text);
        assert_eq!(read["encoding"], encoding);
        assert_eq!(read["revision"], written["revision"]);
        fs::write(dir.path().join("text"), b"external").unwrap_or_else(|error| panic!("{error}"));
        let stale = server.fs_processor().fs_write_file(&connection, &json!({"path":"text","content":"overwrite","encoding":encoding,"options":{"mode":"replace","expectedRevision":read["revision"]}}));
        assert!(stale.is_err());
        assert_eq!(fs::read(dir.path().join("text")).unwrap(), b"external");
    }
}

#[test]
fn encoding_failures_do_not_publish_and_legacy_reads_remain_compatible() {
    let dir = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
    let server = server(dir.path());
    let connection = server.connection();
    fs::write(dir.path().join("text"), b"original").unwrap_or_else(|error| panic!("{error}"));
    let error = server
        .fs_processor()
        .fs_write_file(
            &connection,
            &json!({"path":"text","content":"🦀","encoding":"gbk"}),
        )
        .unwrap_err();
    assert_eq!(
        error.message,
        AppServerErrorName::FileSystemEncodingUnmappable
    );
    assert_eq!(fs::read(dir.path().join("text")).unwrap(), b"original");
    fs::write(dir.path().join("text"), b"\xef\xbb\xbfhello")
        .unwrap_or_else(|error| panic!("{error}"));
    let legacy = server
        .fs_processor()
        .fs_read_file(0, &json!({"path":"text"}))
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(legacy["content"], "\u{feff}hello");
    assert!(legacy.get("encoding").is_none());
    let editor = server
        .fs_processor()
        .fs_read_file(0, &json!({"path":"text","encoding":"auto"}))
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(editor["content"], "hello");
    assert_eq!(editor["encoding"], "utf8bom");
    fs::write(dir.path().join("text"), b"\x00\xff").unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(
        server
            .fs_processor()
            .fs_read_file(0, &json!({"path":"text","encoding":"auto"}))
            .unwrap_err()
            .message,
        AppServerErrorName::FileSystemInvalidText
    );
}

#[test]
fn encoded_write_options_keep_unlock_authorization_and_creation_policy() {
    let dir = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
    let server = server(dir.path());
    let connection = server.connection();
    fs::write(dir.path().join("text"), b"original").unwrap_or_else(|error| panic!("{error}"));
    assert!(server.fs_processor().fs_write_file(&connection, &json!({"path":"text","content":"new","encoding":"utf16le","options":{"mode":"create"}})).is_err());
    let error = server.fs_processor().fs_write_file(&connection, &json!({"path":"text","content":"new","encoding":"utf16le","options":{"mode":"replace","unlock":true,"expectedRevision":"stale"}})).unwrap_err();
    assert_eq!(error.message, AppServerErrorName::PermissionRequired);
    assert_eq!(fs::read(dir.path().join("text")).unwrap(), b"original");
}

#[test]
fn automatic_encoding_read_uses_backend_bytes_and_validates_options() {
    let directory = tempfile::tempdir().unwrap();
    let server = server(directory.path());
    let text = "一般中文\n";
    std::fs::write(
        directory.path().join("text"),
        encode_text(text, "cp950").unwrap(),
    )
    .unwrap();
    let read = server.fs_processor().fs_read_file(0, &json!({"path":"text", "encoding":"utf8", "autoGuessEncoding":true, "candidateGuessEncodings":["utf8","cp950"]})).unwrap();
    assert_eq!(read["content"], text);
    assert_eq!(read["encoding"], "cp950");
    assert!(
        server
            .fs_processor()
            .fs_read_file(
                0,
                &json!({"path":"text", "encoding":"utf8", "autoGuessEncoding":false})
            )
            .is_err()
    );
    assert!(
        server
            .fs_processor()
            .fs_read_file(0, &json!({"path":"text", "autoGuessEncoding":true}))
            .is_err()
    );
    assert!(server.fs_processor().fs_read_file(0, &json!({"path":"text", "encoding":"utf8", "autoGuessEncoding":true,"candidateGuessEncodings":["unknown"]})).is_err());
    std::fs::write(
        directory.path().join("text"),
        encode_text("hello", "utf16be").unwrap(),
    )
    .unwrap();
    let read = server
        .fs_processor()
        .fs_read_file(
            0,
            &json!({"path":"text", "encoding":"windows1252", "autoGuessEncoding":false}),
        )
        .unwrap();
    assert_eq!(read["encoding"], "utf16be");
    assert_eq!(read["content"], "hello");
}

#[cfg(unix)]
#[test]
fn editor_forwarded_reads_keep_the_agent_proof_at_the_filesystem_rpc_boundary() {
    use ash_async_utils::CancellationSource;
    use ash_file_access::PathAccess;
    use ash_file_access::PathAccessPolicy;
    use ash_file_access::PathAccessRule;
    use ash_file_system::AuthorizedTextDocuments;
    use ash_file_system::TextDocumentEditor;
    use ash_tools::TextDocumentEditorProvider;
    use core_api::TurnReceipt;
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let root = dir.canonical_path();
    fs::create_dir(root.join("visible")).unwrap();
    fs::create_dir(root.join("restricted")).unwrap();
    fs::write(root.join("visible/file"), "public").unwrap();
    fs::write(root.join("restricted/file"), "secret").unwrap();
    let server = server(root);
    let connection = server.connection();
    let owner = connection.connection_id;
    let outbound = crate::server::notification_queue::NotificationQueue::default();
    server.client_host.register(owner, true, outbound.clone());
    let thread = ash_protocol::ThreadId::new("scoped-reader").unwrap();
    let turn = ash_protocol::TurnId::new("read-turn").unwrap();
    server
        .client_host
        .submit_turn(
            &thread,
            Some(owner),
            crate::client_host::TextDocumentMode::Client,
            || {
                Ok(TurnReceipt {
                    turn_id: turn.clone(),
                    sequence: 1,
                })
            },
        )
        .unwrap();
    // The editor's ordinary filesystem grant covers the whole tree. Only the current
    // document operation adds the Agent's denied subtree, beyond the directory grant.
    let grant = Grant::for_environment(
        dir.clone(),
        GrantSource::ExplicitUser,
        Permissions::new([Permission::ReadFiles]),
    );
    let documents = AuthorizedTextDocuments::new(
        grant.authorize(Permission::ReadFiles).unwrap(),
        server
            .text_document_host
            .for_turn(&thread, &turn)
            .unwrap()
            .unwrap(),
        [],
    );
    let path = root.join("visible/file");
    let worker_path = path.clone();
    let policy = PathAccessPolicy::new(
        PathAccess::ReadWrite,
        vec![PathAccessRule {
            pattern: "restricted".into(),
            access: PathAccess::Denied,
        }],
    )
    .unwrap();
    let worker = std::thread::spawn(move || {
        documents.read_with_policy(&worker_path, &policy, &CancellationSource::new().token())
    });
    let listener = outbound.listener();
    assert!(listener.wait());
    let request = listener.drain().into_iter().next().unwrap();
    let params =
        json!({"path":path, "readAccess":request["params"]["readAccess"], "encoding":"utf8"});
    assert_eq!(
        server.fs_processor().fs_read_file(owner, &params).unwrap()["content"],
        "public"
    );
    assert!(
        server
            .fs_processor()
            .fs_read_file(owner + 1, &params)
            .is_err()
    );
    let mut other = params.clone();
    other["path"] = json!(root.join("restricted/file"));
    assert!(server.fs_processor().fs_read_file(owner, &other).is_err());
    other = params.clone();
    other["dirId"] = json!("editor");
    assert!(server.fs_processor().fs_read_file(owner, &other).is_err());
    fs::rename(root.join("visible"), root.join("old")).unwrap();
    std::os::unix::fs::symlink("restricted", root.join("visible")).unwrap();
    assert_eq!(
        server
            .fs_processor()
            .fs_read_file(owner, &json!({"path":"visible/file"}))
            .unwrap()["content"],
        "secret"
    );
    assert!(server.fs_processor().fs_read_file(owner, &params).is_err());
    server
        .client_host
        .handle_response(
            owner,
            json!({"jsonrpc":"2.0", "id":request["id"],
        "result":{"kind":"failed", "message":"denied"}}),
        )
        .unwrap();
    assert!(worker.join().unwrap().is_err());
    assert!(server.fs_processor().fs_read_file(owner, &params).is_err());
}
