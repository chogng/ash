use super::*;
use ash_async_utils::CancellationSource;
use ash_lsp::LanguageServerEvent;
use ash_lsp::LanguageServerHost;
use ash_lsp::LanguageServerOptions;
use serde_json::Value;
use serde_json::json;
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::io::BufReader;
use tokio::sync::mpsc;

struct Host(mpsc::UnboundedSender<ash_lsp::LanguageServerCapabilitySnapshot>);

impl LanguageServerHost for Host {
    fn on_event(&self, event: LanguageServerEvent) {
        if let LanguageServerEvent::DynamicCapabilitiesChanged(snapshot) = event {
            self.0.send(snapshot).unwrap();
        }
    }
}

struct Peer {
    client: LanguageServerClient,
    messages: mpsc::UnboundedReceiver<Value>,
    send: mpsc::UnboundedSender<Value>,
    changes: mpsc::UnboundedReceiver<ash_lsp::LanguageServerCapabilitySnapshot>,
    reader: tokio::task::JoinHandle<()>,
    writer: tokio::task::JoinHandle<()>,
}

impl Peer {
    async fn new(capabilities: Value) -> Self {
        let (client, server) = tokio::io::duplex(32 * 1024);
        let (client_read, client_write) = tokio::io::split(client);
        let (server_read, mut server_write) = tokio::io::split(server);
        let (send, mut outgoing) = mpsc::unbounded_channel::<Value>();
        let (received, messages) = mpsc::unbounded_channel();
        let (host, changes) = mpsc::unbounded_channel();
        let writer = tokio::spawn(async move {
            while let Some(message) = outgoing.recv().await {
                let message = message.to_string();
                server_write
                    .write_all(
                        format!("Content-Length: {}\r\n\r\n{message}", message.len()).as_bytes(),
                    )
                    .await
                    .unwrap();
                server_write.flush().await.unwrap();
            }
        });
        let responses = send.clone();
        let reader = tokio::spawn(async move {
            let mut reader = BufReader::new(server_read);
            loop {
                let mut length = None;
                loop {
                    let mut line = String::new();
                    assert_ne!(reader.read_line(&mut line).await.unwrap(), 0);
                    if line == "\r\n" {
                        break;
                    }
                    if let Some(value) = line.strip_prefix("Content-Length: ") {
                        length = Some(value.trim().parse::<usize>().unwrap());
                    }
                }
                let mut body = vec![0; length.unwrap()];
                reader.read_exact(&mut body).await.unwrap();
                let message: Value = serde_json::from_slice(&body).unwrap();
                match message["method"].as_str() {
                    Some("initialize") => {
                        assert_eq!(
                            message["params"]["capabilities"]["textDocument"]["onTypeFormatting"]["dynamicRegistration"],
                            true
                        );
                        responses.send(json!({"jsonrpc":"2.0", "id":message["id"], "result":{"capabilities":capabilities}})).unwrap();
                    }
                    Some("initialized") => {}
                    Some("shutdown") => {
                        responses
                            .send(json!({"jsonrpc":"2.0", "id":message["id"], "result":null}))
                            .unwrap();
                    }
                    Some("exit") => break,
                    _ => {
                        received.send(message).unwrap();
                    }
                }
            }
        });
        let client = LanguageServerClient::connect(
            BufReader::new(client_read),
            client_write,
            LanguageServerOptions::new("on-type-test", "0").with_host(Arc::new(Host(host))),
        )
        .await
        .unwrap();
        Self {
            client,
            messages,
            send,
            changes,
            reader,
            writer,
        }
    }

    async fn next(&mut self) -> Value {
        tokio::time::timeout(Duration::from_secs(5), self.messages.recv())
            .await
            .unwrap()
            .unwrap()
    }

    async fn close(self) {
        self.client.shutdown().await.unwrap();
        self.reader.await.unwrap();
        self.writer.abort();
        assert!(self.writer.await.unwrap_err().is_cancelled());
    }
}

fn request(character: &str) -> PendingLanguageRequest {
    PendingLanguageRequest::OnTypeFormatting {
        id: LanguageRequestId::new(7),
        path: PathBuf::from("main.rs"),
        revision: LanguageDocumentRevision::INITIAL,
        position: LanguageDocumentPosition::new(0, 6),
        character: character.into(),
        options: LanguageFormattingOptions {
            tab_size: 2,
            insert_spaces: true,
            trim_trailing_whitespace: Some(false),
        },
    }
}

async fn execute(
    client: LanguageServerClient,
    character: &str,
    cancellation: ash_async_utils::CancellationToken,
) -> Result<CompletedLanguageRequest, String> {
    execute_request(
        client,
        request(character),
        "file:///workspace/main.rs".parse().unwrap(),
        Some(ash_lsp::lsp_types::Position::new(0, 4)),
        "🦀x;".into(),
        PositionEncodingKind::UTF16,
        cancellation,
    )
    .await
}

#[tokio::test]
async fn on_type_formatting_negotiates_triggers_projects_unicode_edits_and_cancels_the_lsp_request()
{
    let mut peer = Peer::new(json!({"documentOnTypeFormattingProvider":{"firstTriggerCharacter":";", "moreTriggerCharacter":["\n", ";", "🦀", "bad", ""]}})).await;
    let snapshot = capability_snapshot(&peer.client, 1);
    assert!(
        snapshot
            .features
            .contains(&LanguageServerFeature::OnTypeFormatting)
    );
    assert_eq!(
        snapshot.on_type_formatting_trigger_characters,
        ["\n", ";", "🦀"]
    );
    let cancellation = CancellationSource::new();
    assert!(
        execute(peer.client.clone(), "}", cancellation.token())
            .await
            .err()
            .unwrap()
            .contains("not negotiated")
    );
    let client = peer.client.clone();
    let token = cancellation.token();
    let pending = tokio::spawn(async move { execute(client, ";", token).await });
    let message = peer.next().await;
    assert_eq!(message["method"], "textDocument/onTypeFormatting");
    assert_eq!(
        message["params"],
        json!({"textDocument":{"uri":"file:///workspace/main.rs"}, "position":{"line":0,"character":4}, "ch":";", "options":{"tabSize":2,"insertSpaces":true,"trimTrailingWhitespace":false}})
    );
    peer.send.send(json!({"jsonrpc":"2.0", "id":message["id"], "result":[{"range":{"start":{"line":0,"character":2},"end":{"line":0,"character":3}},"newText":"y"}]})).unwrap();
    let result = pending.await.unwrap().unwrap();
    let CompletedLanguageRequest::FormattingEdits(result) = result else {
        panic!("expected formatting edits");
    };
    assert_eq!(result.revision, LanguageDocumentRevision::INITIAL);
    assert_eq!(result.edits[0].range.byte_range(), 4..5);
    assert_eq!(result.edits[0].new_text, "y");
    let client = peer.client.clone();
    let token = cancellation.token();
    let pending = tokio::spawn(async move { execute(client, "\n", token).await });
    let message = peer.next().await;
    assert_eq!(message["params"]["ch"], "\n");
    cancellation.cancel();
    assert!(pending.await.unwrap().is_err());
    let cancelled = peer.next().await;
    assert_eq!(cancelled["method"], "$/cancelRequest");
    assert_eq!(cancelled["params"]["id"], message["id"]);
    peer.close().await;
}

#[tokio::test]
async fn on_type_formatting_dynamic_registration_and_withdrawal_update_the_canonical_snapshot() {
    let mut peer = Peer::new(json!({})).await;
    assert!(!supports_request(
        &peer.client,
        LanguageRequestKind::OnTypeFormatting
    ));
    peer.send.send(json!({"jsonrpc":"2.0", "id":"add", "method":"client/registerCapability", "params":{"registrations":[{"id":"typing", "method":"textDocument/onTypeFormatting", "registerOptions":{"firstTriggerCharacter":"\n", "moreTriggerCharacter":[";"], "documentSelector":null}}]}})).unwrap();
    assert_eq!(peer.next().await["id"], "add");
    assert_eq!(peer.changes.recv().await.unwrap().revision, 1);
    assert_eq!(
        capability_snapshot(&peer.client, 1).on_type_formatting_trigger_characters,
        ["\n", ";"]
    );
    assert!(supports_request(
        &peer.client,
        LanguageRequestKind::OnTypeFormatting
    ));
    peer.send.send(json!({"jsonrpc":"2.0", "id":"remove", "method":"client/unregisterCapability", "params":{"unregisterations":[{"id":"typing", "method":"textDocument/onTypeFormatting"}]}})).unwrap();
    assert_eq!(peer.next().await["id"], "remove");
    assert_eq!(peer.changes.recv().await.unwrap().revision, 2);
    let snapshot = capability_snapshot(&peer.client, 1);
    assert!(snapshot.on_type_formatting_trigger_characters.is_empty());
    assert!(
        !snapshot
            .features
            .contains(&LanguageServerFeature::OnTypeFormatting)
    );
    peer.close().await;
}
