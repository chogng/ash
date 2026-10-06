use super::*;
use crate::server::message_queue::MessageBudget;

fn message(budget: &MessageBudget, raw: &str) -> RemoteMessage {
    RemoteMessage {
        raw: raw.to_owned(),
        _bytes: budget.try_reserve(raw.len()).unwrap(),
    }
}

#[test]
fn saturated_ordinary_mailbox_preserves_reply_and_control_capacity_and_priority() {
    let mailbox = RemoteMailbox::default();
    let budget = MessageBudget::new(1024);
    for _ in 0..REQUEST_CAPACITY {
        mailbox
            .send(MessageKind::Ordinary, message(&budget, "work"))
            .unwrap();
    }
    assert_eq!(
        mailbox
            .send(MessageKind::Ordinary, message(&budget, "full"))
            .unwrap_err()
            .kind(),
        io::ErrorKind::WouldBlock
    );
    mailbox
        .send(MessageKind::Control, message(&budget, "stop"))
        .unwrap();
    mailbox
        .send(MessageKind::Control, message(&budget, "cancel"))
        .unwrap();
    for _ in 0..HOST_REPLY_CAPACITY {
        mailbox
            .send(MessageKind::HostReply, message(&budget, "reply"))
            .unwrap();
    }
    assert_eq!(
        mailbox
            .send(MessageKind::HostReply, message(&budget, "full"))
            .unwrap_err()
            .kind(),
        io::ErrorKind::WouldBlock
    );
    for _ in 0..HOST_REPLY_CAPACITY {
        assert_eq!(mailbox.recv().unwrap().unwrap().raw, "reply");
    }
    assert_eq!(mailbox.recv().unwrap().unwrap().raw, "stop");
    assert_eq!(mailbox.recv().unwrap().unwrap().raw, "cancel");
    assert_eq!(mailbox.recv().unwrap().unwrap().raw, "work");
    mailbox.close();
    assert_eq!(
        mailbox.recv().err().unwrap().kind(),
        io::ErrorKind::BrokenPipe
    );
    assert!(budget.try_reserve(1024).is_some());
}

#[test]
fn ssh_initialize_routes_early_messages_and_keeps_the_buffered_stream() {
    use ash_app_server_protocol::protocol::initialize::ProtocolVersion;
    use ash_app_server_protocol::protocol::initialize::ServerCapabilities;

    let mut capabilities = ServerCapabilities {
        sessions: true,
        threads: true,
        turns: true,
        ..ServerCapabilities::default()
    };
    capabilities.advertise_contracts();
    let notification = serde_json::json!({"jsonrpc":"2.0","method":"queue/changed","params":{}});
    let host_request =
        serde_json::json!({"jsonrpc":"2.0","id":"host:1","method":"browser/open","params":{}});
    let response = serde_json::json!({"jsonrpc":"2.0","id":1,"result":{
        "serverInfo":{"name":"ash-app-server","version":"test"},
        "protocolVersion":ProtocolVersion::current(),
        "schemaHash":ash_app_server_protocol::schema_hash(), "capabilities":capabilities,"slashCommands":[]
    }});
    let trailing = serde_json::json!({"jsonrpc":"2.0","id":2,"result":{}});
    let stream = format!("{notification}\n{host_request}\n{response}\n{trailing}\n");
    let mut reader = JsonlReader::new(std::io::Cursor::new(stream), DEFAULT_MAX_MESSAGE_BYTES);
    let (outbound, received) = crate::server::message_queue::outbound_queue(16);
    read_initialize(
        &mut reader,
        &serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}).to_string(),
        7,
        &outbound,
        ash_app_server_protocol::protocol::initialize::REQUIRED_SESSION_CAPABILITIES,
    )
    .unwrap();
    assert_eq!(received.recv().unwrap().raw, notification.to_string());
    let routed: Value = serde_json::from_str(&received.recv().unwrap().raw).unwrap();
    assert_eq!(routed["id"], "browser-host:gateway:7:host:1");
    assert_eq!(
        reader.read_message().unwrap().unwrap(),
        trailing.to_string()
    );

    let mut reader = JsonlReader::new(
        std::io::Cursor::new(format!("{response}\n")),
        DEFAULT_MAX_MESSAGE_BYTES,
    );
    let error = read_initialize(
        &mut reader,
        &serde_json::json!({"jsonrpc":"2.0","id":2,"method":"initialize","params":{}}).to_string(),
        7,
        &outbound,
        ash_app_server_protocol::protocol::initialize::REQUIRED_SESSION_CAPABILITIES,
    )
    .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(error.to_string().contains("ID mismatch"));
}
