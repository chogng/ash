use std::str::FromStr;

use lsp_types::Uri;
use serde_json::{Value, json};
use tokio::io::{AsyncWrite, BufReader};
use tokio::sync::mpsc;

use super::*;
use crate::protocol::{
    DEFAULT_MAX_HEADER_BYTES, DEFAULT_MAX_MESSAGE_BYTES, read_frame, write_frame,
};

#[test]
fn router_validates_server_and_language_routes() {
    assert!(LanguageServerName::new("").is_err());
    let name = LanguageServerName::new("rust-analyzer").expect("server name");
    assert!(LanguageServerRoute::new(name.clone(), Vec::<String>::new()).is_err());
    assert!(LanguageServerRoute::new(name, [" rust"]).is_err());
}

#[tokio::test]
async fn router_binds_revisions_and_replays_documents_on_replacement() {
    let sync = json!({
        "openClose": true,
        "change": 1,
        "save": { "includeText": true }
    });
    let (original, mut original_events, original_task) = fake_language_server(sync.clone()).await;
    let (replacement, mut replacement_events, replacement_task) = fake_language_server(sync).await;
    let server_name = LanguageServerName::new("rust-analyzer").expect("server name");
    let route = LanguageServerRoute::new(server_name.clone(), ["rust"]).expect("server route");
    let mut router = LanguageServerDocumentRouter::default();
    router.register(route, original).expect("register server");
    let uri = Uri::from_str("file:///workspace/src/main.rs").expect("document URI");

    let opened = router
        .open_document(snapshot(&uri, 7, "fn main() {}"))
        .await
        .expect("open routed document");
    assert_eq!(opened.editor_revision(), EditorDocumentRevision::new(7));
    assert_eq!(
        opened.server_incarnation(),
        LanguageServerIncarnation::INITIAL
    );
    assert_eq!(opened.server_version(), DocumentVersion::INITIAL);
    let open_event = next_method(&mut original_events, "textDocument/didOpen").await;
    assert_eq!(open_event["params"]["textDocument"]["version"], 1);

    let updated = router
        .update_document(snapshot(&uri, 8, "fn main() { println!(\"ok\"); }"))
        .await
        .expect("update routed document");
    assert_eq!(updated.server_version().value(), 2);
    let change_event = next_method(&mut original_events, "textDocument/didChange").await;
    assert_eq!(change_event["params"]["textDocument"]["version"], 2);
    assert_eq!(
        change_event["params"]["contentChanges"][0]["text"],
        "fn main() { println!(\"ok\"); }"
    );

    let stale = router
        .update_document(snapshot(&uri, 8, "stale"))
        .await
        .expect_err("equal editor revision must be rejected");
    assert!(matches!(
        stale,
        LanguageServerRouterError::StaleEditorRevision { .. }
    ));

    let (incompatible, _incompatible_events, incompatible_task) =
        fake_language_server(Value::Null).await;
    let failed_replacement = router
        .replace_server(&server_name, incompatible)
        .await
        .expect_err("replacement without document sync must fail");
    assert!(matches!(
        failed_replacement,
        LanguageServerRouterError::Runtime(LanguageServerError::UnsupportedDocumentOperation(_))
    ));
    incompatible_task
        .await
        .expect("incompatible replacement task");
    let unchanged = router
        .document_version(&uri)
        .expect("original binding remains current");
    assert_eq!(unchanged.server_incarnation().value(), 1);
    assert_eq!(unchanged.server_version().value(), 2);

    router
        .update_document(snapshot(&uri, 9, "fn main() { println!(\"final\"); }"))
        .await
        .expect("old route remains usable after failed replacement");
    assert_eq!(
        next_method(&mut original_events, "textDocument/didChange").await["params"]["textDocument"]
            ["version"],
        3
    );

    let replaced = router
        .replace_server(&server_name, replacement)
        .await
        .expect("replace server");
    assert_eq!(replaced.incarnation.value(), 2);
    assert_eq!(replaced.replayed_documents, 1);
    assert_eq!(
        replaced.previous_shutdown,
        LanguageServerPreviousShutdown::Clean
    );
    original_task.await.expect("original server task");
    let replay = next_method(&mut replacement_events, "textDocument/didOpen").await;
    assert_eq!(replay["params"]["textDocument"]["version"], 1);
    assert_eq!(
        replay["params"]["textDocument"]["text"],
        "fn main() { println!(\"final\"); }"
    );
    let rebound = router
        .document_version(&uri)
        .expect("rebound document version");
    assert_eq!(rebound.editor_revision(), EditorDocumentRevision::new(9));
    assert_eq!(rebound.server_incarnation().value(), 2);
    assert_eq!(rebound.server_version().value(), 1);

    router.save_document(&uri).await.expect("save document");
    let save = next_method(&mut replacement_events, "textDocument/didSave").await;
    assert_eq!(save["params"]["text"], "fn main() { println!(\"final\"); }");
    router.close_document(&uri).await.expect("close document");
    assert_eq!(
        next_method(&mut replacement_events, "textDocument/didClose").await["method"],
        "textDocument/didClose"
    );
    assert!(router.shutdown().await.is_empty());
    replacement_task.await.expect("replacement server task");
}

#[tokio::test]
async fn disconnected_server_removal_discards_stale_bindings_before_fresh_replay() {
    let sync = json!({ "openClose": true, "change": 1 });
    let (original, mut original_events, original_task) = fake_language_server(sync.clone()).await;
    let server_name = LanguageServerName::new("rust-analyzer").expect("server name");
    let mut router = LanguageServerDocumentRouter::default();
    router
        .register(
            LanguageServerRoute::new(server_name.clone(), ["rust"]).expect("route"),
            original,
        )
        .expect("register original");
    let uri = Uri::from_str("file:///workspace/src/main.rs").expect("document URI");
    router
        .open_document(snapshot(&uri, 1, "old text"))
        .await
        .expect("open original document");
    let _ = next_method(&mut original_events, "textDocument/didOpen").await;

    assert_eq!(
        router
            .remove_disconnected_server(&server_name)
            .await
            .expect("remove disconnected route"),
        1
    );
    original_task.await.expect("original server task");
    assert!(matches!(
        router.document_version(&uri),
        Err(LanguageServerRouterError::DocumentNotOpen { .. })
    ));

    let (replacement, mut replacement_events, replacement_task) = fake_language_server(sync).await;
    router
        .register(
            LanguageServerRoute::new(server_name, ["rust"]).expect("replacement route"),
            replacement,
        )
        .expect("register replacement");
    router
        .open_document(snapshot(&uri, 2, "authoritative latest text"))
        .await
        .expect("replay authoritative document");
    let replay = next_method(&mut replacement_events, "textDocument/didOpen").await;
    assert_eq!(
        replay["params"]["textDocument"]["text"],
        "authoritative latest text"
    );
    assert!(router.shutdown().await.is_empty());
    replacement_task.await.expect("replacement server task");
}

fn snapshot(uri: &Uri, revision: u64, text: &str) -> LanguageDocumentSnapshot {
    LanguageDocumentSnapshot::new(
        uri.clone(),
        "rust",
        EditorDocumentRevision::new(revision),
        text,
    )
    .expect("document snapshot")
}

async fn fake_language_server(
    text_document_sync: Value,
) -> (
    LanguageServerClient,
    mpsc::UnboundedReceiver<Value>,
    tokio::task::JoinHandle<()>,
) {
    let (client_stream, server_stream) = tokio::io::duplex(32 * 1024);
    let (client_reader, client_writer) = tokio::io::split(client_stream);
    let (server_reader, server_writer) = tokio::io::split(server_stream);
    let (event_tx, event_rx) = mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        let mut reader = BufReader::new(server_reader);
        let mut writer = server_writer;
        let initialize = read_json(&mut reader).await;
        respond(
            &mut writer,
            initialize["id"].clone(),
            json!({
                "capabilities": {
                    "textDocumentSync": text_document_sync
                }
            }),
        )
        .await;
        loop {
            let frame = match read_frame(
                &mut reader,
                DEFAULT_MAX_HEADER_BYTES,
                DEFAULT_MAX_MESSAGE_BYTES,
            )
            .await
            {
                Ok(Some(frame)) => frame,
                Ok(None) | Err(_) => break,
            };
            let message: Value = serde_json::from_slice(&frame).expect("valid JSON");
            let method = message["method"].as_str().unwrap_or_default();
            event_tx.send(message.clone()).expect("record server event");
            if method == "shutdown" {
                respond(&mut writer, message["id"].clone(), Value::Null).await;
            } else if method == "exit" {
                break;
            }
        }
    });
    let client = LanguageServerClient::connect(
        BufReader::new(client_reader),
        client_writer,
        LanguageServerOptions::new("ash-lsp-router-test", "0"),
    )
    .await
    .expect("initialize fake language server");
    (client, event_rx, task)
}

async fn next_method(events: &mut mpsc::UnboundedReceiver<Value>, method: &str) -> Value {
    loop {
        let event = events.recv().await.expect("server event");
        if event["method"] == method {
            return event;
        }
    }
}

async fn read_json<R>(reader: &mut R) -> Value
where
    R: tokio::io::AsyncBufRead + Unpin,
{
    let bytes = read_frame(reader, DEFAULT_MAX_HEADER_BYTES, DEFAULT_MAX_MESSAGE_BYTES)
        .await
        .expect("read frame")
        .expect("transport remains open");
    serde_json::from_slice(&bytes).expect("valid JSON")
}

async fn respond<W>(writer: &mut W, id: Value, result: Value)
where
    W: AsyncWrite + Unpin,
{
    let bytes = serde_json::to_vec(&json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    }))
    .expect("serialize response");
    write_frame(writer, &bytes, DEFAULT_MAX_MESSAGE_BYTES)
        .await
        .expect("write response");
}
