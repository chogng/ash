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
            .fs_read_file(&json!({"path":"text","encoding":encoding}))
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
        .fs_read_file(&json!({"path":"text"}))
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(legacy["content"], "\u{feff}hello");
    assert!(legacy.get("encoding").is_none());
    let editor = server
        .fs_processor()
        .fs_read_file(&json!({"path":"text","encoding":"auto"}))
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(editor["content"], "hello");
    assert_eq!(editor["encoding"], "utf8bom");
    fs::write(dir.path().join("text"), b"\x00\xff").unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(
        server
            .fs_processor()
            .fs_read_file(&json!({"path":"text","encoding":"auto"}))
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
    let read = server.fs_processor().fs_read_file(&json!({"path":"text", "encoding":"utf8", "autoGuessEncoding":true, "candidateGuessEncodings":["utf8","cp950"]})).unwrap();
    assert_eq!(read["content"], text);
    assert_eq!(read["encoding"], "cp950");
    assert!(
        server
            .fs_processor()
            .fs_read_file(&json!({"path":"text", "encoding":"utf8", "autoGuessEncoding":false}))
            .is_err()
    );
    assert!(
        server
            .fs_processor()
            .fs_read_file(&json!({"path":"text", "autoGuessEncoding":true}))
            .is_err()
    );
    assert!(server.fs_processor().fs_read_file(&json!({"path":"text", "encoding":"utf8", "autoGuessEncoding":true,"candidateGuessEncodings":["unknown"]})).is_err());
    std::fs::write(
        directory.path().join("text"),
        encode_text("hello", "utf16be").unwrap(),
    )
    .unwrap();
    let read = server
        .fs_processor()
        .fs_read_file(&json!({"path":"text", "encoding":"windows1252", "autoGuessEncoding":false}))
        .unwrap();
    assert_eq!(read["encoding"], "utf16be");
    assert_eq!(read["content"], "hello");
}
