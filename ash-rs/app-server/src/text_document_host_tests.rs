use super::*;
use crate::server::notification_queue::NotificationQueue;
use core_api::TurnReceipt;
use serde_json::{Value, json};
use std::thread;

fn bound_host() -> (
    Arc<ClientHost>,
    TextDocumentHost,
    NotificationQueue,
    ash_protocol::ThreadId,
    ash_protocol::TurnId,
) {
    let clients = Arc::new(ClientHost::default());
    let outbound = NotificationQueue::default();
    clients.register(7, true, outbound.clone());
    let thread = ash_protocol::ThreadId::new("document-thread").unwrap();
    let turn = ash_protocol::TurnId::new("document-turn").unwrap();
    clients
        .submit_turn(
            &thread,
            Some(7),
            crate::client_host::TextDocumentMode::Client,
            || {
                Ok(TurnReceipt {
                    turn_id: turn.clone(),
                    sequence: 1,
                })
            },
        )
        .unwrap();
    let host = TextDocumentHost::new(Arc::clone(&clients));
    (clients, host, outbound, thread, turn)
}

fn next_request(outbound: &NotificationQueue) -> Value {
    let listener = outbound.listener();
    assert!(listener.wait());
    listener.drain().into_iter().next().unwrap()
}

#[test]
fn document_reads_and_commits_use_the_exact_initiating_connection() {
    let (clients, host, outbound, thread_id, turn) = bound_host();
    let editor = host.for_turn(&thread_id, &turn).unwrap().unwrap();
    let worker_editor = Arc::clone(&editor);
    let worker = thread::spawn(move || {
        worker_editor.read(
            Path::new("C:/workspace/dirty.txt"),
            &CancellationSource::new().token(),
        )
    });
    let request = next_request(&outbound);
    assert_eq!(request["method"], "textDocument/read");
    let response = json!({"jsonrpc":"2.0", "id":request["id"], "result":{"kind":"document", "snapshot":"version-1", "text":"unsaved\r\n"}});
    assert!(clients.handle_response(8, response.clone()).is_err());
    clients.handle_response(7, response).unwrap();
    assert_eq!(worker.join().unwrap().unwrap().unwrap().text, "unsaved\r\n");
    let worker = thread::spawn(move || {
        editor.apply(
            vec![TextDocumentChange::Update {
                snapshot: "version-1".into(),
                text: "updated\n".into(),
            }],
            &CancellationSource::new().token(),
        )
    });
    let request = next_request(&outbound);
    assert_eq!(request["method"], "textDocument/apply");
    clients
        .handle_response(
            7,
            json!({"jsonrpc":"2.0", "id":request["id"], "result":{"kind":"conflict"}}),
        )
        .unwrap();
    assert_eq!(worker.join().unwrap(), Err(TextDocumentError::Conflict));
}

#[test]
fn disconnect_preserves_editor_selection_and_lost_commit_is_uncertain() {
    let (clients, host, outbound, thread_id, turn) = bound_host();
    let editor = host.for_turn(&thread_id, &turn).unwrap().unwrap();
    let worker = thread::spawn(move || {
        editor.apply(
            vec![TextDocumentChange::Update {
                snapshot: "version-1".into(),
                text: "updated".into(),
            }],
            &CancellationSource::new().token(),
        )
    });
    next_request(&outbound);
    clients.unregister(7);
    assert!(matches!(
        worker.join().unwrap(),
        Err(TextDocumentError::OutcomeUnknown(_))
    ));
    assert!(matches!(
        host.for_turn(&thread_id, &turn),
        Err(TextDocumentError::Unavailable)
    ));
    clients.finish_turn(&thread_id, &turn);
    assert!(matches!(
        host.for_turn(&thread_id, &turn),
        Err(TextDocumentError::Unavailable)
    ));
}

#[test]
fn disabled_document_capability_explicitly_selects_disk_and_replay_cannot_rebind() {
    let (clients, host, _, thread_id, turn) = bound_host();
    clients.register(8, false, NotificationQueue::default());
    clients
        .submit_turn(
            &thread_id,
            Some(8),
            crate::client_host::TextDocumentMode::Client,
            || {
                Ok(TurnReceipt {
                    turn_id: turn.clone(),
                    sequence: 1,
                })
            },
        )
        .unwrap();
    assert_eq!(
        clients
            .binding(&thread_id, &turn)
            .unwrap()
            .unwrap()
            .connection_id,
        7
    );
    let disk_turn = ash_protocol::TurnId::new("disk-turn").unwrap();
    clients
        .submit_turn(
            &thread_id,
            Some(8),
            crate::client_host::TextDocumentMode::Client,
            || {
                Ok(TurnReceipt {
                    turn_id: disk_turn.clone(),
                    sequence: 2,
                })
            },
        )
        .unwrap();
    assert!(host.for_turn(&thread_id, &disk_turn).unwrap().is_none());
}

#[test]
fn cancellation_retires_request_and_accepts_late_reply_without_republishing() {
    let (clients, host, outbound, thread_id, turn) = bound_host();
    let editor = host.for_turn(&thread_id, &turn).unwrap().unwrap();
    let cancellation = CancellationSource::new();
    let token = cancellation.token();
    let worker = thread::spawn(move || editor.read(Path::new("C:/workspace/file.txt"), &token));
    let request = next_request(&outbound);
    cancellation.cancel();
    assert_eq!(worker.join().unwrap(), Err(TextDocumentError::Cancelled));
    let cancel = next_request(&outbound);
    assert_eq!(cancel["method"], "$/cancelRequest");
    clients
        .handle_response(
            7,
            json!({"jsonrpc":"2.0", "id":request["id"], "result":{"kind":"notFound"}}),
        )
        .unwrap();
    assert!(outbound.listener().drain().is_empty());
}
