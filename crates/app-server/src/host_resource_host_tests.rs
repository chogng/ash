use super::*;
use crate::server::notification_queue::NotificationQueue;
use serde_json::json;
use std::sync::Arc;

fn reference(bytes: &[u8]) -> HostResourceRef {
    HostResourceRef {
        handle: "snapshot-handle".into(),
        byte_length: bytes.len(),
        sha256: format!("sha256:{:x}", Sha256::digest(bytes)),
    }
}

fn chunk(
    resource: &HostResourceRef,
    bytes: &[u8],
    offset: usize,
    maximum: usize,
) -> HostResourceReadResult {
    let end = bytes.len().min(offset + maximum);
    let bytes = &bytes[offset..end];
    HostResourceReadResult {
        handle: resource.handle.clone(),
        offset,
        data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        decoded_length: bytes.len(),
        eof: end == resource.byte_length,
    }
}

#[test]
fn context_materialization_verifies_every_chunk_before_returning_utf8() {
    let content = "中文😀 snapshot\n".repeat(20_000);
    let bytes = content.as_bytes();
    let resource = reference(bytes);
    let mut offsets = Vec::new();
    let materialized = materialize(&resource, |offset, maximum| {
        offsets.push(offset);
        Ok(chunk(&resource, bytes, offset, maximum))
    })
    .unwrap();
    assert_eq!(materialized, content);
    assert_eq!(offsets, vec![0, MAX_CHUNK_BYTES]);
}

#[test]
fn corrupt_or_inconsistent_snapshots_never_become_context() {
    let bytes = "中文😀".as_bytes();
    for fault in [
        "handle", "offset", "length", "eof", "digest", "base64", "empty",
    ] {
        let mut resource = reference(bytes);
        if fault == "digest" {
            resource.sha256 = format!("sha256:{}", "0".repeat(64));
        }
        let result = materialize(&resource, |offset, maximum| {
            let mut reply = chunk(&resource, bytes, offset, maximum);
            match fault {
                "handle" => reply.handle = "other-connection".into(),
                "offset" => reply.offset += 1,
                "length" => reply.decoded_length += 1,
                "eof" => reply.eof = false,
                "base64" => reply.data_base64 = "!".into(),
                "empty" => {
                    reply.data_base64.clear();
                    reply.decoded_length = 0;
                }
                "digest" => {}
                _ => unreachable!(),
            }
            Ok(reply)
        });
        assert!(result.is_err(), "{fault}");
    }
    let bytes = [0xff, 0xfe];
    let resource = reference(&bytes);
    assert!(
        materialize(&resource, |offset, maximum| Ok(chunk(
            &resource, &bytes, offset, maximum
        )))
        .is_err()
    );
}

#[test]
fn host_callbacks_are_connection_bound_and_release_after_a_digest_failure() {
    let host = Arc::new(ClientHost::default());
    let owner = NotificationQueue::default();
    let other = NotificationQueue::default();
    host.register(7, false, owner.clone());
    host.register(8, false, other.clone());
    let bytes = b"captured before editing";
    let mut resource = reference(bytes);
    resource.sha256 = format!("sha256:{}", "0".repeat(64));
    let worker = {
        let host = Arc::clone(&host);
        let resource = resource.clone();
        std::thread::spawn(move || read_context(&host, 7, &resource))
    };
    let listener = owner.listener();
    assert!(listener.wait());
    let request = listener.drain().pop().unwrap();
    assert_eq!(request["method"], "hostResource/read");
    let reply = json!({"jsonrpc":"2.0","id":request["id"],"result":chunk(&resource, bytes, 0, MAX_CHUNK_BYTES)});
    assert!(host.handle_response(8, reply.clone()).is_err());
    host.handle_response(7, reply).unwrap();
    assert!(listener.wait());
    let release = listener.drain().pop().unwrap();
    assert_eq!(release["method"], "hostResource/release");
    host.handle_response(7, json!({"jsonrpc":"2.0","id":release["id"],"result":null}))
        .unwrap();
    assert!(worker.join().unwrap().is_err());
    assert!(other.listener().drain().is_empty());
}

#[test]
fn closing_the_originating_connection_cancels_materialization_without_rerouting() {
    let host = Arc::new(ClientHost::default());
    let owner = NotificationQueue::default();
    let other = NotificationQueue::default();
    host.register(7, false, owner.clone());
    host.register(8, false, other.clone());
    let worker = {
        let host = Arc::clone(&host);
        std::thread::spawn(move || read_context(&host, 7, &reference(b"snapshot")))
    };
    assert!(owner.listener().wait());
    host.unregister(7);
    assert!(worker.join().unwrap().is_err());
    assert!(other.listener().drain().is_empty());
}

#[test]
fn successful_context_still_requires_release_before_admission() {
    let host = Arc::new(ClientHost::default());
    let outbound = NotificationQueue::default();
    host.register(7, false, outbound.clone());
    let bytes = b"immutable snapshot";
    let resource = reference(bytes);
    let worker = {
        let host = Arc::clone(&host);
        let resource = resource.clone();
        std::thread::spawn(move || read_context(&host, 7, &resource))
    };
    let listener = outbound.listener();
    assert!(listener.wait());
    let request = listener.drain().pop().unwrap();
    host.handle_response(7, json!({"jsonrpc":"2.0","id":request["id"],"result":chunk(&resource, bytes, 0, MAX_CHUNK_BYTES)})).unwrap();
    assert!(listener.wait());
    let release = listener.drain().pop().unwrap();
    assert_eq!(release["method"], "hostResource/release");
    host.handle_response(7, json!({"jsonrpc":"2.0","id":release["id"],"error":{"code":-32603,"message":"release failed","data":null}})).unwrap();
    assert!(matches!(
        worker.join().unwrap(),
        Err(ClientHostError::Failed(_))
    ));
}

#[test]
fn whole_snapshot_deadline_cancels_a_stalled_read_without_a_second_release_timeout() {
    let host = Arc::new(ClientHost::default());
    let outbound = NotificationQueue::default();
    host.register(7, false, outbound.clone());
    let resource = reference(b"immutable snapshot");
    let started = Instant::now();
    let worker = {
        let host = Arc::clone(&host);
        std::thread::spawn(move || {
            read_context_with_timeout(&host, 7, &resource, Duration::from_millis(40))
        })
    };
    let listener = outbound.listener();
    assert!(listener.wait());
    let request = listener.drain().pop().unwrap();
    assert_eq!(request["method"], "hostResource/read");
    assert!(matches!(
        worker.join().unwrap(),
        Err(ClientHostError::TimedOut)
    ));
    assert!(started.elapsed() < Duration::from_secs(1));
    let cancellation = listener.drain();
    assert_eq!(cancellation.len(), 1);
    assert_eq!(cancellation[0]["method"], "$/cancelRequest");
    assert_eq!(cancellation[0]["params"]["id"], request["id"]);
    // A late response belongs to the retired request and cannot revive admission.
    assert!(
        host.handle_response(7, json!({"jsonrpc":"2.0","id":request["id"],"result":null}))
            .is_ok()
    );
}

#[test]
fn session_admission_materializes_context_before_persisting_and_rejects_corruption() {
    use crate::tests::call;
    use crate::tests::initialize;
    use crate::tests::server;
    for corrupt in [false, true] {
        let server = Arc::new(server());
        let mut connection = server.connection();
        initialize(&server, &mut connection);
        let session = call(
            &server,
            &mut connection,
            json!({"jsonrpc":"2.0","id":2,"method":"session/create","params":{"commandId":"session","title":"snapshots","executionTarget":null}}),
        );
        let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
        let created = call(
            &server,
            &mut connection,
            json!({"jsonrpc":"2.0","id":3,"method":"session/request","params":{"commandId":"thread","sessionId":session_id,"request":{"type":"createThread","title":"snapshots"}}}),
        );
        let thread_id = created["result"]["value"]["threadId"]
            .as_str()
            .unwrap()
            .to_owned();
        let content = "selection-time captured 中文😀";
        let resource = reference(content.as_bytes());
        let request = json!({"jsonrpc":"2.0","id":4,"method":"session/request","params":{"commandId":"start","sessionId":session_id,"request":{"type":"startTurn","threadId":thread_id,"expectedSequence":1,"input":[{"type":"hostResource","name":"selected.ts","resource":resource}]}}});
        let (sender, receiver) = std::sync::mpsc::channel();
        let worker = {
            let server = Arc::clone(&server);
            let mut connection = connection.clone();
            std::thread::spawn(move || {
                sender
                    .send(call(&server, &mut connection, request))
                    .unwrap()
            })
        };
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut reads = 0;
        let mut releases = 0;
        let response = loop {
            for notification in server.drain_notifications(&mut connection) {
                let notification: serde_json::Value = serde_json::from_str(&notification).unwrap();
                let result = match notification["method"].as_str() {
                    Some("hostResource/read") => {
                        reads += 1;
                        let mut result = chunk(&resource, content.as_bytes(), 0, MAX_CHUNK_BYTES);
                        if corrupt {
                            result.data_base64 = base64::engine::general_purpose::STANDARD
                                .encode(b"modified after capture");
                        }
                        serde_json::to_value(result).unwrap()
                    }
                    Some("hostResource/release") => {
                        releases += 1;
                        serde_json::Value::Null
                    }
                    _ => continue,
                };
                server
                    .client_host
                    .handle_response(
                        connection.connection_id,
                        json!({"jsonrpc":"2.0","id":notification["id"],"result":result}),
                    )
                    .unwrap();
            }
            if let Ok(response) = receiver.try_recv() {
                break response;
            }
            assert!(
                Instant::now() < deadline,
                "snapshot admission did not finish"
            );
            std::thread::yield_now();
        };
        worker.join().unwrap();
        assert_eq!(reads, 1);
        assert_eq!(releases, 1);
        let thread_id = ash_protocol::ThreadId::new(thread_id).unwrap();
        let snapshot = server.threads().read_thread(&thread_id).unwrap();
        if corrupt {
            assert_eq!(response["error"]["message"], "InvalidParams");
            assert!(
                snapshot.turns.is_empty(),
                "invalid snapshots must never admit a Turn"
            );
        } else {
            assert_eq!(response["result"]["type"], "turn");
            assert!(snapshot.items.iter().any(|item| matches!(item,
                ash_protocol::ThreadItem::UserContext { name, content: captured, .. }
                    if name == "selected.ts" && captured == content)));
            let persisted = serde_json::to_string(&snapshot.items).unwrap();
            assert!(
                !persisted.contains(&resource.handle),
                "connection handles must not enter durable thread state"
            );
        }
        server.close_connection(connection);
    }
}
