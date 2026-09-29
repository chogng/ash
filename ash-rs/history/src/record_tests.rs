use super::*;
use ash_protocol::CommandId;
use ash_protocol::SessionId;
use ash_protocol::ThreadCommand;
use ash_protocol::ThreadEvent;
use ash_protocol::ThreadId;

#[test]
fn stored_event_round_trip_preserves_history_contract() {
    let thread_id = ThreadId::new("thread_1").unwrap();
    let event = StoredEvent {
        time_context: None,
        schema_version: CURRENT_STORED_EVENT_SCHEMA_VERSION,
        event_id: EventId("event_1".into()),
        sequence: 1,
        thread_id: thread_id.clone(),
        recorded_at: Timestamp(42),
        command: Some(ThreadCommandReceipt {
            command_id: CommandId::new("command_1").unwrap(),
            command: ThreadCommand::StartShellTurn {
                command: "pwd".into(),
                approval_mode: ash_protocol::ApprovalMode::AskPermissions,
            },
        }),
        event: ThreadEvent::ThreadCreated {
            execution_target: None,
            agent_id: Some(ash_protocol::AgentId::new("agent-test").unwrap()),
            origin: Default::default(),
            agent: None,
            session_id: SessionId::new("session_1").unwrap(),
            thread_id: thread_id.clone(),
            title: "Primary".into(),
        },
    };

    let encoded = serde_json::to_string(&event).unwrap();
    let decoded: StoredEvent = serde_json::from_str(&encoded).unwrap();

    assert_eq!(decoded, event);
    assert_eq!(decoded.thread_id(), &thread_id);
}

#[test]
fn legacy_workspace_field_replays_as_execution_target() {
    let json = r#"{"schemaVersion":20,"eventId":"created","sequence":1,"threadId":"old","recordedAt":1,"event":{"type":"threadCreated","agentId":"agent","sessionId":"session","threadId":"old","title":"Old","workspace":{"type":"local","root":"/repo"}}}"#;
    let record: StoredEvent = serde_json::from_str(json).unwrap();
    assert!(matches!(&record.event, ThreadEvent::ThreadCreated {
        execution_target: Some(ash_protocol::SessionExecutionTarget::Local { root }), ..
    } if root == std::path::Path::new("/repo")));
    assert_eq!(serde_json::to_string(&record).unwrap(), json);
    let prefix = crate::HistoryPrefix {
        events: vec![record],
    };
    let expected =
        ash_protocol::ContentDigest::sha256(format!("{{\"events\":[{json}]}}").as_bytes());
    assert_eq!(prefix.reference().unwrap().digest, expected);
}

#[test]
fn supported_schema_range_distinguishes_reads_from_new_writes() {
    assert!(!supports_stored_event_schema_version(0));
    assert!(supports_stored_event_schema_version(
        MINIMUM_SUPPORTED_EVENT_SCHEMA_VERSION
    ));
    assert!(supports_stored_event_schema_version(
        CURRENT_STORED_EVENT_SCHEMA_VERSION
    ));
    assert!(!supports_stored_event_schema_version(
        CURRENT_STORED_EVENT_SCHEMA_VERSION + 1
    ));
}

#[test]
fn legacy_creation_keeps_serialized_event_bytes_and_new_creation_requires_identity() {
    let json = r#"{"schemaVersion":15,"eventId":"created","sequence":1,"threadId":"old","recordedAt":1,"event":{"type":"threadCreated","sessionId":"session","threadId":"old","title":"Old"}}"#;
    let mut record: StoredEvent = serde_json::from_str(json).unwrap();
    assert_eq!(
        created_thread_agent_id(&record).unwrap().as_str(),
        "legacy-agent:old"
    );
    assert_eq!(serde_json::to_string(&record).unwrap(), json);
    record.schema_version = CURRENT_STORED_EVENT_SCHEMA_VERSION;
    assert!(created_thread_agent_id(&record).is_err());
    let ThreadEvent::ThreadCreated { agent_id, .. } = &mut record.event else {
        unreachable!()
    };
    *agent_id = Some(ash_protocol::AgentId::new("independent-agent").unwrap());
    assert_eq!(
        created_thread_agent_id(&record).unwrap().as_str(),
        "independent-agent"
    );
    record.schema_version += 1;
    assert!(created_thread_agent_id(&record).is_err());
}
