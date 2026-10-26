use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ash_async_utils::CancellationSource;
use lsp_types::request::HoverRequest;
use lsp_types::{
    ConfigurationItem, HoverParams, Position, TextDocumentIdentifier, TextDocumentPositionParams,
    Uri, WorkDoneProgressParams,
};
use serde_json::{Value, json};
use tokio::io::{AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{Notify, oneshot};

use super::*;
use crate::protocol::{
    DEFAULT_MAX_HEADER_BYTES, DEFAULT_MAX_MESSAGE_BYTES, read_frame, write_frame,
};

#[tokio::test]
async fn initialize_preserves_static_type_hierarchy_without_assuming_support() {
    for (value, supported) in [
        (json!({}), Some(false)),
        (json!({"typeHierarchyProvider": false}), Some(false)),
        (json!({"typeHierarchyProvider": true}), Some(true)),
        (
            json!({"typeHierarchyProvider": {"workDoneProgress": true}}),
            Some(true),
        ),
        (
            json!({"typeHierarchyProvider": {"id": "types", "documentSelector": null}}),
            Some(true),
        ),
        (json!({"typeHierarchyProvider": "invalid"}), None),
    ] {
        let (client_stream, server_stream) = tokio::io::duplex(16 * 1024);
        let (client_reader, client_writer) = tokio::io::split(client_stream);
        let (server_reader, mut writer) = tokio::io::split(server_stream);
        let server = tokio::spawn(async move {
            let mut reader = BufReader::new(server_reader);
            let initialize = read_json(&mut reader).await;
            respond(
                &mut writer,
                initialize["id"].clone(),
                json!({ "capabilities": value }),
            )
            .await;
            if supported.is_none() {
                return;
            }
            assert_eq!(read_json(&mut reader).await["method"], "initialized");
            let shutdown = read_json(&mut reader).await;
            assert_eq!(shutdown["method"], "shutdown");
            respond(&mut writer, shutdown["id"].clone(), Value::Null).await;
            assert_eq!(read_json(&mut reader).await["method"], "exit");
        });
        let client = LanguageServerClient::connect(
            BufReader::new(client_reader),
            client_writer,
            LanguageServerOptions::new("ash-lsp-test", "0"),
        )
        .await;
        if let Some(supported) = supported {
            let client = client.expect("valid initialize response");
            assert_eq!(client.initialization().type_hierarchy, supported);
            client.shutdown().await.expect("shutdown");
        } else {
            assert!(matches!(
                client,
                Err(LanguageServerError::InvalidResult { .. })
            ));
        }
        server.await.expect("peer");
    }
}

#[derive(Default)]
struct RecordingHost {
    events: Mutex<Vec<LanguageServerEvent>>,
    event_received: Notify,
}

#[test]
fn on_type_formatting_registration_validates_characters_without_rejecting_newlines() {
    let registry = crate::capability::DynamicCapabilityRegistry::default();
    for options in [
        Value::Null,
        json!({}),
        json!({"firstTriggerCharacter":""}),
        json!({"firstTriggerCharacter":"ab"}),
        json!({"firstTriggerCharacter":";", "moreTriggerCharacter":["\0"]}),
    ] {
        assert!(
            registry
                .register(vec![lsp_types::Registration {
                    id: "typing".into(),
                    method: "textDocument/onTypeFormatting".into(),
                    register_options: Some(options),
                }])
                .is_err()
        );
        assert_eq!(registry.snapshot().revision, 0);
    }
    let snapshot = registry
        .register(vec![lsp_types::Registration {
            id: "typing".into(),
            method: "textDocument/onTypeFormatting".into(),
            register_options: Some(
                json!({"firstTriggerCharacter":"\n", "moreTriggerCharacter":[";", "🦀"]}),
            ),
        }])
        .unwrap();
    assert_eq!(snapshot.revision, 1);
    assert!(registry.supports("textDocument/onTypeFormatting"));
}

impl RecordingHost {
    async fn wait_for_diagnostics(&self) {
        loop {
            if self
                .events
                .lock()
                .expect("events mutex")
                .iter()
                .any(|event| matches!(event, LanguageServerEvent::Diagnostics(_)))
            {
                return;
            }
            self.event_received.notified().await;
        }
    }

    async fn wait_for_transport_closed(&self) -> String {
        loop {
            if let Some(message) =
                self.events
                    .lock()
                    .expect("events mutex")
                    .iter()
                    .find_map(|event| match event {
                        LanguageServerEvent::TransportClosed { message } => Some(message.clone()),
                        _ => None,
                    })
            {
                return message;
            }
            self.event_received.notified().await;
        }
    }

    async fn wait_for_dynamic_revision(&self, revision: u64) -> LanguageServerCapabilitySnapshot {
        loop {
            if let Some(snapshot) =
                self.events
                    .lock()
                    .expect("events mutex")
                    .iter()
                    .find_map(|event| match event {
                        LanguageServerEvent::DynamicCapabilitiesChanged(snapshot)
                            if snapshot.revision == revision =>
                        {
                            Some(snapshot.clone())
                        }
                        _ => None,
                    })
            {
                return snapshot;
            }
            self.event_received.notified().await;
        }
    }

    async fn wait_for_progress(&self) {
        loop {
            if self
                .events
                .lock()
                .expect("events mutex")
                .iter()
                .any(|event| matches!(event, LanguageServerEvent::Progress(_)))
            {
                return;
            }
            self.event_received.notified().await;
        }
    }
}

impl LanguageServerHost for RecordingHost {
    fn on_event(&self, event: LanguageServerEvent) {
        self.events.lock().expect("events mutex").push(event);
        self.event_received.notify_waiters();
    }

    fn workspace_configuration(&self, items: &[ConfigurationItem]) -> Vec<WorkspaceConfiguration> {
        items
            .iter()
            .map(|item| {
                WorkspaceConfiguration(json!({
                    "section": item.section,
                    "enabled": true,
                }))
            })
            .collect()
    }
}

#[tokio::test]
async fn runs_initialize_document_requests_events_and_shutdown() {
    let (client_stream, server_stream) = tokio::io::duplex(64 * 1024);
    let (client_reader, client_writer) = tokio::io::split(client_stream);
    let (server_reader, server_writer) = tokio::io::split(server_stream);
    let (configuration_done_tx, configuration_done_rx) = oneshot::channel();
    let uri = Uri::from_str("file:///workspace/src/main.rs").expect("document URI");
    let server_uri = uri.clone();
    let server = tokio::spawn(async move {
        let mut reader = BufReader::new(server_reader);
        let mut writer = server_writer;
        let initialize = read_json(&mut reader).await;
        assert_eq!(initialize["method"], "initialize");
        assert_eq!(
            initialize["params"]["capabilities"]["general"]["positionEncodings"],
            json!(["utf-8", "utf-16"])
        );
        respond(
            &mut writer,
            initialize["id"].clone(),
            json!({
                "capabilities": {
                    "positionEncoding": "utf-8",
                    "hoverProvider": true,
                    "textDocumentSync": {
                        "openClose": true,
                        "change": 2,
                        "save": { "includeText": true }
                    }
                },
                "serverInfo": {
                    "name": "test-language-server",
                    "version": "1"
                }
            }),
        )
        .await;

        let initialized = read_json(&mut reader).await;
        assert_eq!(initialized["method"], "initialized");
        write_json(
            &mut writer,
            json!({
                "jsonrpc": "2.0",
                "id": "configuration-1",
                "method": "workspace/configuration",
                "params": {
                    "items": [{
                        "scopeUri": server_uri,
                        "section": "rust-analyzer"
                    }]
                }
            }),
        )
        .await;
        let configuration = read_json(&mut reader).await;
        assert_eq!(configuration["id"], "configuration-1");
        assert_eq!(configuration["result"][0]["section"], "rust-analyzer");
        assert_eq!(configuration["result"][0]["enabled"], true);
        configuration_done_tx
            .send(())
            .expect("signal configuration");

        let opened = read_json(&mut reader).await;
        assert_eq!(opened["method"], "textDocument/didOpen");
        assert_eq!(opened["params"]["textDocument"]["version"], 1);
        write_json(
            &mut writer,
            json!({
                "jsonrpc": "2.0",
                "method": "textDocument/publishDiagnostics",
                "params": {
                    "uri": server_uri,
                    "version": 1,
                    "diagnostics": [{
                        "range": {
                            "start": { "line": 0, "character": 0 },
                            "end": { "line": 0, "character": 2 }
                        },
                        "severity": 1,
                        "message": "example error"
                    }]
                }
            }),
        )
        .await;

        let changed = read_json(&mut reader).await;
        assert_eq!(changed["method"], "textDocument/didChange");
        assert_eq!(changed["params"]["textDocument"]["version"], 2);
        assert_eq!(
            changed["params"]["contentChanges"][0]["range"]["start"]["line"],
            0
        );

        let saved = read_json(&mut reader).await;
        assert_eq!(saved["method"], "textDocument/didSave");
        assert_eq!(saved["params"]["text"], "fn main() {}");

        let hover = read_json(&mut reader).await;
        assert_eq!(hover["method"], "textDocument/hover");
        respond(&mut writer, hover["id"].clone(), Value::Null).await;

        let closed = read_json(&mut reader).await;
        assert_eq!(closed["method"], "textDocument/didClose");

        let shutdown = read_json(&mut reader).await;
        assert_eq!(shutdown["method"], "shutdown");
        respond(&mut writer, shutdown["id"].clone(), Value::Null).await;
        let exit = read_json(&mut reader).await;
        assert_eq!(exit["method"], "exit");
    });

    let host = Arc::new(RecordingHost::default());
    let client = LanguageServerClient::connect(
        BufReader::new(client_reader),
        client_writer,
        LanguageServerOptions::new("ash-lsp-test", "0").with_host(host.clone()),
    )
    .await
    .expect("initialize language server");
    assert_eq!(
        client.initialization().position_encoding,
        lsp_types::PositionEncodingKind::UTF8
    );
    assert_eq!(
        client.initialization().document_sync,
        DocumentSyncPolicy {
            open_close: true,
            change: DocumentChangeSync::Incremental,
            save: DocumentSaveSync::IncludeText,
        }
    );

    configuration_done_rx
        .await
        .expect("configuration response should complete");
    assert_eq!(
        client
            .open_document(uri.clone(), "rust", "fn main() {}")
            .await
            .expect("open document"),
        DocumentVersion::INITIAL
    );
    host.wait_for_diagnostics().await;
    let version = client
        .change_document(
            &uri,
            DocumentChange::Incremental(vec![lsp_types::TextDocumentContentChangeEvent {
                range: Some(lsp_types::Range::new(
                    Position::new(0, 0),
                    Position::new(0, 2),
                )),
                range_length: None,
                text: "fn".into(),
            }]),
        )
        .await
        .expect("change document");
    assert_eq!(version.value(), 2);
    client
        .save_document(&uri, DocumentSave::WithText("fn main() {}"))
        .await
        .expect("save document");
    let hover = client
        .request::<HoverRequest>(HoverParams {
            text_document_position_params: TextDocumentPositionParams {
                text_document: TextDocumentIdentifier { uri: uri.clone() },
                position: Position::new(0, 1),
            },
            work_done_progress_params: WorkDoneProgressParams::default(),
        })
        .await
        .expect("hover response");
    assert!(hover.is_none());
    client.close_document(&uri).await.expect("close document");
    client.shutdown().await.expect("shutdown language server");
    server.await.expect("server task");
    assert!(
        !host
            .events
            .lock()
            .expect("events mutex")
            .iter()
            .any(|event| matches!(event, LanguageServerEvent::TransportClosed { .. }))
    );
}

#[tokio::test]
async fn unexpected_transport_close_is_reported_once_after_initialization() {
    let (client_stream, server_stream) = tokio::io::duplex(16 * 1024);
    let (client_reader, client_writer) = tokio::io::split(client_stream);
    let (server_reader, server_writer) = tokio::io::split(server_stream);
    let server = tokio::spawn(async move {
        let mut reader = BufReader::new(server_reader);
        let mut writer = server_writer;
        let initialize = read_json(&mut reader).await;
        respond(
            &mut writer,
            initialize["id"].clone(),
            json!({ "capabilities": {} }),
        )
        .await;
        assert_eq!(read_json(&mut reader).await["method"], "initialized");
    });
    let host = Arc::new(RecordingHost::default());
    let client = LanguageServerClient::connect(
        BufReader::new(client_reader),
        client_writer,
        LanguageServerOptions::new("ash-lsp-test", "0").with_host(host.clone()),
    )
    .await
    .expect("initialize language server");

    let message = tokio::time::timeout(Duration::from_secs(1), host.wait_for_transport_closed())
        .await
        .expect("transport close event");

    assert!(!message.is_empty());
    client.abort_disconnected().await;
    server.await.expect("server task");
    assert_eq!(
        host.events
            .lock()
            .expect("events mutex")
            .iter()
            .filter(|event| matches!(event, LanguageServerEvent::TransportClosed { .. }))
            .count(),
        1
    );
}

#[tokio::test]
async fn request_timeout_sends_protocol_cancellation() {
    let (client_stream, server_stream) = tokio::io::duplex(16 * 1024);
    let (client_reader, client_writer) = tokio::io::split(client_stream);
    let (server_reader, server_writer) = tokio::io::split(server_stream);
    let server = tokio::spawn(async move {
        let mut reader = BufReader::new(server_reader);
        let mut writer = server_writer;
        let initialize = read_json(&mut reader).await;
        respond(
            &mut writer,
            initialize["id"].clone(),
            json!({ "capabilities": { "hoverProvider": true } }),
        )
        .await;
        assert_eq!(read_json(&mut reader).await["method"], "initialized");

        let hover = read_json(&mut reader).await;
        assert_eq!(hover["method"], "textDocument/hover");
        let cancellation = read_json(&mut reader).await;
        assert_eq!(cancellation["method"], "$/cancelRequest");
        assert_eq!(cancellation["params"]["id"], hover["id"]);

        let shutdown = read_json(&mut reader).await;
        respond(&mut writer, shutdown["id"].clone(), Value::Null).await;
        assert_eq!(read_json(&mut reader).await["method"], "exit");
    });
    let client = LanguageServerClient::connect(
        BufReader::new(client_reader),
        client_writer,
        LanguageServerOptions::new("ash-lsp-test", "0").with_timeouts(LanguageServerTimeouts {
            initialize: Duration::from_secs(1),
            request: Duration::from_millis(20),
            shutdown: Duration::from_secs(1),
        }),
    )
    .await
    .expect("initialize language server");
    let uri = Uri::from_str("file:///workspace/main.rs").expect("document URI");
    let error = client
        .request::<HoverRequest>(HoverParams {
            text_document_position_params: TextDocumentPositionParams {
                text_document: TextDocumentIdentifier { uri },
                position: Position::new(0, 0),
            },
            work_done_progress_params: WorkDoneProgressParams::default(),
        })
        .await
        .expect_err("hover should time out");
    assert!(matches!(
        error,
        LanguageServerError::Timeout { operation, .. } if operation == "textDocument/hover"
    ));
    client.shutdown().await.expect("shutdown language server");
    server.await.expect("server task");
}

#[tokio::test]
async fn request_cancellation_sends_protocol_cancellation() {
    let (client_stream, server_stream) = tokio::io::duplex(16 * 1024);
    let (client_reader, client_writer) = tokio::io::split(client_stream);
    let (server_reader, server_writer) = tokio::io::split(server_stream);
    let (hover_seen_tx, hover_seen_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let mut reader = BufReader::new(server_reader);
        let mut writer = server_writer;
        let initialize = read_json(&mut reader).await;
        respond(
            &mut writer,
            initialize["id"].clone(),
            json!({ "capabilities": { "hoverProvider": true } }),
        )
        .await;
        assert_eq!(read_json(&mut reader).await["method"], "initialized");

        let hover = read_json(&mut reader).await;
        assert_eq!(hover["method"], "textDocument/hover");
        hover_seen_tx
            .send(hover["id"].clone())
            .expect("signal hover");
        let cancellation = read_json(&mut reader).await;
        assert_eq!(cancellation["method"], "$/cancelRequest");
        assert_eq!(cancellation["params"]["id"], hover["id"]);

        let shutdown = read_json(&mut reader).await;
        respond(&mut writer, shutdown["id"].clone(), Value::Null).await;
        assert_eq!(read_json(&mut reader).await["method"], "exit");
    });
    let client = LanguageServerClient::connect(
        BufReader::new(client_reader),
        client_writer,
        LanguageServerOptions::new("ash-lsp-test", "0"),
    )
    .await
    .expect("initialize language server");
    let uri = Uri::from_str("file:///workspace/main.rs").expect("document URI");
    let cancellation = CancellationSource::new();
    let request_client = client.clone();
    let request_token = cancellation.token();
    let request = tokio::spawn(async move {
        request_client
            .request_with_cancellation::<HoverRequest>(
                HoverParams {
                    text_document_position_params: TextDocumentPositionParams {
                        text_document: TextDocumentIdentifier { uri },
                        position: Position::new(0, 0),
                    },
                    work_done_progress_params: WorkDoneProgressParams::default(),
                },
                &request_token,
            )
            .await
    });
    hover_seen_rx
        .await
        .expect("hover request should reach server");
    cancellation.cancel();
    let error = request
        .await
        .expect("request task")
        .expect_err("hover should be cancelled");
    assert!(matches!(
        error,
        LanguageServerError::Cancelled { operation } if operation == "textDocument/hover"
    ));
    client.shutdown().await.expect("shutdown language server");
    server.await.expect("server task");
}

#[tokio::test]
async fn dynamic_capabilities_and_progress_are_scoped_to_one_client_incarnation() {
    let (client_stream, server_stream) = tokio::io::duplex(32 * 1024);
    let (client_reader, client_writer) = tokio::io::split(client_stream);
    let (server_reader, server_writer) = tokio::io::split(server_stream);
    let (unregister_tx, unregister_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let mut reader = BufReader::new(server_reader);
        let mut writer = server_writer;
        let initialize = read_json(&mut reader).await;
        assert_eq!(
            initialize["params"]["capabilities"]["textDocument"]["hover"]["dynamicRegistration"],
            true
        );
        assert_eq!(
            initialize["params"]["capabilities"]["textDocument"]["hover"]["contentFormat"],
            json!(["plaintext"])
        );
        assert_eq!(
            initialize["params"]["capabilities"]["textDocument"]["completion"]["completionItem"]["documentationFormat"],
            json!(["plaintext"])
        );
        assert_eq!(
            initialize["params"]["capabilities"]["workspace"]["diagnostic"]["refreshSupport"],
            true
        );
        respond(
            &mut writer,
            initialize["id"].clone(),
            json!({ "capabilities": {} }),
        )
        .await;
        assert_eq!(read_json(&mut reader).await["method"], "initialized");

        write_json(
            &mut writer,
            json!({
                "jsonrpc": "2.0",
                "id": "register-hover",
                "method": "client/registerCapability",
                "params": {
                    "registrations": [{
                        "id": "hover-1",
                        "method": "textDocument/hover",
                        "registerOptions": { "documentSelector": [{ "language": "rust" }] }
                    }]
                }
            }),
        )
        .await;
        let registered = read_json(&mut reader).await;
        assert_eq!(registered["id"], "register-hover");
        assert!(registered["result"].is_null());

        write_json(
            &mut writer,
            json!({
                "jsonrpc": "2.0",
                "id": "progress-create",
                "method": "window/workDoneProgress/create",
                "params": { "token": "indexing" }
            }),
        )
        .await;
        assert!(read_json(&mut reader).await["result"].is_null());
        write_json(&mut writer, json!({
            "jsonrpc": "2.0", "id": "invalid-refresh", "method": "workspace/diagnostic/refresh", "params": []
        })).await;
        assert_eq!(read_json(&mut reader).await["error"]["code"], -32602);
        write_json(&mut writer, json!({
            "jsonrpc": "2.0", "id": "refresh-diagnostics", "method": "workspace/diagnostic/refresh"
        })).await;
        let refreshed = read_json(&mut reader).await;
        assert_eq!(refreshed["id"], "refresh-diagnostics");
        assert!(refreshed["result"].is_null());
        write_json(
            &mut writer,
            json!({
                "jsonrpc": "2.0",
                "method": "$/progress",
                "params": {
                    "token": "indexing",
                    "value": { "kind": "begin", "title": "Indexing", "percentage": 10 }
                }
            }),
        )
        .await;

        unregister_rx.await.expect("continue with unregister");
        write_json(
            &mut writer,
            json!({
                "jsonrpc": "2.0",
                "id": "unregister-hover",
                "method": "client/unregisterCapability",
                "params": {
                    "unregisterations": [{
                        "id": "hover-1",
                        "method": "textDocument/hover"
                    }]
                }
            }),
        )
        .await;
        assert!(read_json(&mut reader).await["result"].is_null());

        write_json(
            &mut writer,
            json!({
                "jsonrpc": "2.0",
                "id": "unsupported-registration",
                "method": "client/registerCapability",
                "params": {
                    "registrations": [{
                        "id": "watch-files-1",
                        "method": "workspace/didChangeWatchedFiles"
                    }]
                }
            }),
        )
        .await;
        let unsupported = read_json(&mut reader).await;
        assert_eq!(unsupported["error"]["code"], -32602);

        let shutdown = read_json(&mut reader).await;
        respond(&mut writer, shutdown["id"].clone(), Value::Null).await;
        assert_eq!(read_json(&mut reader).await["method"], "exit");
    });

    let host = Arc::new(RecordingHost::default());
    let client = LanguageServerClient::connect(
        BufReader::new(client_reader),
        client_writer,
        LanguageServerOptions::new("ash-lsp-test", "0").with_host(host.clone()),
    )
    .await
    .expect("initialize language server");
    let registered = host.wait_for_dynamic_revision(1).await;
    assert_eq!(registered.registrations.len(), 1);
    assert!(client.supports_dynamic_method("textDocument/hover"));
    assert_eq!(client.dynamic_capabilities(), registered);
    host.wait_for_progress().await;
    assert_eq!(
        host.events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| matches!(event, LanguageServerEvent::DiagnosticsRefresh))
            .count(),
        1
    );
    unregister_tx.send(()).expect("request unregister");
    let unregistered = host.wait_for_dynamic_revision(2).await;
    assert!(unregistered.registrations.is_empty());
    assert!(!client.supports_dynamic_method("textDocument/hover"));
    client.shutdown().await.expect("shutdown language server");
    server.await.expect("server task");
}

#[tokio::test]
async fn framing_rejects_duplicate_content_length() {
    let bytes = b"Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}";
    let mut reader = BufReader::new(&bytes[..]);
    let error = read_frame(
        &mut reader,
        DEFAULT_MAX_HEADER_BYTES,
        DEFAULT_MAX_MESSAGE_BYTES,
    )
    .await
    .expect_err("duplicate content length must fail");
    assert!(matches!(error, LanguageServerError::InvalidMessage(_)));
}

#[tokio::test]
async fn framing_bounds_a_header_before_its_newline() {
    let bytes = vec![b'x'; DEFAULT_MAX_HEADER_BYTES + 1];
    let mut reader = BufReader::new(bytes.as_slice());
    let error = read_frame(
        &mut reader,
        DEFAULT_MAX_HEADER_BYTES,
        DEFAULT_MAX_MESSAGE_BYTES,
    )
    .await
    .expect_err("oversized header must fail before a newline");
    assert!(matches!(
        error,
        LanguageServerError::MessageTooLarge { limit }
            if limit == DEFAULT_MAX_HEADER_BYTES
    ));
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
    write_json(
        writer,
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result,
        }),
    )
    .await;
}

async fn write_json<W>(writer: &mut W, value: Value)
where
    W: AsyncWrite + Unpin,
{
    let bytes = serde_json::to_vec(&value).expect("serialize JSON");
    write_frame(writer, &bytes, DEFAULT_MAX_MESSAGE_BYTES)
        .await
        .expect("write frame");
}

#[tokio::test]
async fn workspace_folders_request_matches_the_folders_advertised_at_initialization() {
    let (client, server) = tokio::io::duplex(16 * 1024);
    let (reader, writer) = tokio::io::split(client);
    let (server_reader, mut server_writer) = tokio::io::split(server);
    let folders = vec![lsp_types::WorkspaceFolder {
        uri: "file:///workspace".parse().unwrap(),
        name: "workspace".into(),
    }];
    let expected = serde_json::to_value(&folders).unwrap();
    let (ready, received) = oneshot::channel();
    let task = tokio::spawn(async move {
        let mut reader = BufReader::new(server_reader);
        let initialize = read_json(&mut reader).await;
        assert_eq!(initialize["params"]["workspaceFolders"], expected);
        respond(
            &mut server_writer,
            initialize["id"].clone(),
            json!({"capabilities":{}}),
        )
        .await;
        assert_eq!(read_json(&mut reader).await["method"], "initialized");
        write_json(
            &mut server_writer,
            json!({"jsonrpc":"2.0","id":"folders","method":"workspace/workspaceFolders"}),
        )
        .await;
        assert_eq!(
            read_json(&mut reader).await,
            json!({"jsonrpc":"2.0","id":"folders","result":expected})
        );
        ready.send(()).unwrap();
        let shutdown = read_json(&mut reader).await;
        respond(&mut server_writer, shutdown["id"].clone(), Value::Null).await;
        assert_eq!(read_json(&mut reader).await["method"], "exit");
    });
    let client = LanguageServerClient::connect(
        BufReader::new(reader),
        writer,
        LanguageServerOptions::new("test", "1").with_workspace_folders(folders),
    )
    .await
    .unwrap();
    received.await.unwrap();
    client.shutdown().await.unwrap();
    task.await.unwrap();
}

#[tokio::test]
async fn nonreading_peer_must_not_defeat_initialize_deadline() {
    let (client_io, server_io) = tokio::io::duplex(512);
    let (reader, writer) = tokio::io::split(client_io);
    let result = tokio::time::timeout(
        Duration::from_millis(300),
        LanguageServerClient::connect(
            BufReader::new(reader),
            writer,
            LanguageServerOptions::new("audit", "1").with_timeouts(LanguageServerTimeouts {
                initialize: Duration::from_millis(25),
                request: Duration::from_millis(25),
                shutdown: Duration::from_millis(25),
            }),
        ),
    )
    .await;
    drop(server_io);
    assert!(
        result.is_ok(),
        "initialize exceeded 300ms with a configured 25ms deadline"
    );
}

#[tokio::test]
async fn cancelling_initialization_drops_both_transport_halves() {
    let (client_io, server_io) = tokio::io::duplex(512);
    let (reader, writer) = tokio::io::split(client_io);
    let initialization = tokio::spawn(LanguageServerClient::connect(
        BufReader::new(reader),
        writer,
        LanguageServerOptions::new("cancel-test", "1"),
    ));
    let mut peer = BufReader::new(server_io);
    assert_eq!(read_json(&mut peer).await["method"], "initialize");
    initialization.abort();
    assert!(matches!(initialization.await, Err(error) if error.is_cancelled()));
    let mut peer = peer.into_inner();
    let mut bytes = [0; 64];
    assert_eq!(
        tokio::time::timeout(
            Duration::from_secs(1),
            tokio::io::AsyncReadExt::read(&mut peer, &mut bytes)
        )
        .await
        .unwrap()
        .unwrap(),
        0
    );
    assert!(
        tokio::time::timeout(Duration::from_secs(1), peer.write_all(&[0; 1024]))
            .await
            .unwrap()
            .is_err()
    );
}

#[tokio::test]
async fn stalled_writer_must_not_prevent_bounded_shutdown() {
    let (client_io, server_io) = tokio::io::duplex(512);
    let (client_reader, client_writer) = tokio::io::split(client_io);
    let (server_reader, mut server_writer) = tokio::io::split(server_io);
    let (ready, initialized) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let mut reader = BufReader::new(server_reader);
        let request = read_json(&mut reader).await;
        let response = serde_json::to_vec(&json!({
            "jsonrpc": "2.0", "id": request["id"],
            "result": {"capabilities": {"textDocumentSync": 1}}
        }))
        .unwrap();
        server_writer
            .write_all(format!("Content-Length: {}\r\n\r\n", response.len()).as_bytes())
            .await
            .unwrap();
        server_writer.write_all(&response).await.unwrap();
        assert_eq!(read_json(&mut reader).await["method"], "initialized");
        ready.send(()).unwrap();
        // Keep both transport halves alive, while the peer stops reading client messages.
        std::future::pending::<()>().await;
        drop((reader, server_writer));
    });
    let client = LanguageServerClient::connect(
        BufReader::new(client_reader),
        client_writer,
        LanguageServerOptions::new("audit", "1").with_timeouts(LanguageServerTimeouts {
            initialize: Duration::from_secs(1),
            request: Duration::from_secs(1),
            shutdown: Duration::from_millis(25),
        }),
    )
    .await
    .unwrap();
    initialized.await.unwrap();
    let document_client = client.clone();
    let notification = tokio::spawn(async move {
        document_client
            .open_document(
                "file:///audit.demo".parse().unwrap(),
                "demo",
                "x".repeat(8192),
            )
            .await
    });
    tokio::time::sleep(Duration::from_millis(25)).await;
    let result = tokio::time::timeout(Duration::from_millis(300), client.shutdown()).await;
    notification.abort();
    server.abort();
    assert!(
        result.is_ok(),
        "shutdown exceeded 300ms with a configured 25ms deadline"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn shutdown_timeout_kills_and_reaps_the_owned_stdio_process() {
    let script = r#"
cr=$(printf '\r')
while IFS= read -r line; do
  line=${line%"$cr"}
  [ -z "$line" ] && break
  case "$line" in Content-Length:*) length=${line#Content-Length: };; esac
done
message=$(dd bs=1 count="$length" 2>/dev/null)
id=$(printf '%s' "$message" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
response="{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"capabilities\":{},\"serverInfo\":{\"name\":\"owned-fixture\",\"version\":\"$$\"}}}"
printf 'Content-Length: %s\r\n\r\n%s' "${#response}" "$response"
exec sleep 60
"#;
    let client = LanguageServerClient::start_stdio(
        LanguageServerCommand::new("/bin/sh").with_arguments(["-c", script]),
        LanguageServerOptions::new("stdio-lifecycle", "1").with_timeouts(LanguageServerTimeouts {
            initialize: Duration::from_secs(2),
            request: Duration::from_secs(1),
            shutdown: Duration::from_millis(25),
        }),
    )
    .await
    .unwrap();
    let pid = client
        .initialization()
        .server_info
        .as_ref()
        .unwrap()
        .version
        .as_ref()
        .unwrap();
    let alive = || {
        std::process::Command::new("/bin/kill")
            .args(["-0", pid])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success()
    };
    assert!(alive());
    let result = tokio::time::timeout(Duration::from_secs(1), client.shutdown())
        .await
        .unwrap();
    assert!(result.is_err(), "the fixture never acknowledges shutdown");
    assert!(
        !alive(),
        "forced cleanup must reap this exact owned process before returning"
    );
}
