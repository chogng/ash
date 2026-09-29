use super::*;

#[test]
fn request_notifications_wait_for_delivery_while_host_requests_keep_flowing() {
    let queue = NotificationQueue::default();
    let request = queue.defer_causal_notifications(None);
    queue.push(serde_json::json!({"method":"config/changed", "params":{"revision":1}}));
    queue.push(serde_json::json!({"id":"host:1", "method":"browser/open", "params":{}}));
    assert_eq!(
        queue.drain(),
        vec![serde_json::json!({"id":"host:1", "method":"browser/open", "params":{}})]
    );
    drop(request);
    assert_eq!(
        queue.drain(),
        vec![serde_json::json!({"method":"config/changed", "params":{"revision":1}})]
    );
}

#[test]
fn starting_a_turn_holds_only_its_session_events_from_background_producers() {
    let queue = NotificationQueue::default();
    let request = queue.defer_causal_notifications(Some("session-1"));
    let producer = queue.clone();
    std::thread::spawn(move || {
        producer.push(serde_json::json!({"method":"session/thread/update", "params":{"sessionId":"session-1", "update":{"type":"committed"}}}));
        producer.push(serde_json::json!({"method":"session/thread/update", "params":{"sessionId":"session-2", "update":{"type":"committed"}}}));
        producer.push(serde_json::json!({"method":"fs/changed", "params":{}}));
    }).join().unwrap();
    let independent = queue.drain();
    assert_eq!(independent.len(), 2);
    assert_eq!(independent[0]["params"]["sessionId"], "session-2");
    assert_eq!(independent[1]["method"], "fs/changed");
    drop(request);
    let causal = queue.drain();
    assert_eq!(causal.len(), 1);
    assert_eq!(causal[0]["params"]["sessionId"], "session-1");
}

#[test]
fn transient_backlog_is_bounded_without_losing_control_messages() {
    let queue = NotificationQueue::default();
    for sequence in 1..=MAX_NOTIFICATION_QUEUE_LEN {
        queue.push(serde_json::json!({
            "jsonrpc":"2.0",
            "method":"session/thread/update",
            "params":{
                "streamCursor":{"streamInstanceId":"stream-1","sequence":sequence},
                "update":{"type":"itemDelta"}
            }
        }));
    }
    queue.push(serde_json::json!({
        "jsonrpc":"2.0",
        "method":"config/changed",
        "params":{"revision":1,"generation":1}
    }));

    let values = queue.drain();
    assert!(values.len() <= MAX_NOTIFICATION_QUEUE_LEN);
    assert_eq!(values.len(), 1);
    assert_eq!(values[0]["method"], "config/changed");
}

#[test]
fn assembled_transcript_stream_updates_are_droppable() {
    let queue = NotificationQueue::default();
    for sequence in 1..=MAX_NOTIFICATION_QUEUE_LEN {
        queue.push(serde_json::json!({
            "jsonrpc":"2.0",
            "method":"session/thread/transcript/update",
            "params":{
                "sessionId":"session-1",
                "threadId":"thread-1",
                "durableSequence":0,
                "revision":sequence,
                "streamCursor":{"streamInstanceId":"stream-1","sequence":sequence},
                "changes":[{"type":"upsert"}]
            }
        }));
    }
    queue.push(serde_json::json!({
        "jsonrpc":"2.0",
        "method":"config/changed",
        "params":{"revision":1,"generation":1}
    }));

    let values = queue.drain();
    assert_eq!(values.len(), 2);
    assert_eq!(values[0]["method"], "session/thread/transcript/update");
    assert_eq!(
        values[0]["params"]["revision"],
        MAX_NOTIFICATION_QUEUE_LEN as u64
    );
    assert_eq!(values[0]["params"]["changes"][0]["type"], "clearTransient");
    assert_eq!(values[1]["method"], "config/changed");
}

#[test]
fn control_overflow_closes_instead_of_dropping_existing_messages() {
    let queue = NotificationQueue::default();
    for sequence in 0..MAX_NOTIFICATION_QUEUE_LEN {
        queue.push(serde_json::json!({
            "jsonrpc":"2.0",
            "method":"config/changed",
            "params":{"revision":sequence,"generation":sequence}
        }));
    }
    queue.push(serde_json::json!({
        "jsonrpc":"2.0",
        "method":"skills/changed",
        "params":{"generation":1}
    }));

    assert_eq!(queue.len(), MAX_NOTIFICATION_QUEUE_LEN);
    assert!(queue.listener().wait());
    assert_eq!(queue.drain().len(), MAX_NOTIFICATION_QUEUE_LEN);
    assert!(!queue.listener().wait());
}
