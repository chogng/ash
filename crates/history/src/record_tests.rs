use super::*;
use ash_protocol::CommandId;
use ash_protocol::SessionId;
use ash_protocol::ThreadCommand;
use ash_protocol::ThreadEvent;
use ash_protocol::ThreadId;

#[test]
fn old_permission_ids_restore_without_changing_history_bytes_or_command_identity() {
    for (old_id, mode) in [
        ("askPermissions", ash_protocol::ApprovalMode::Manual),
        ("autoReview", ash_protocol::ApprovalMode::Auto),
        (
            "bypassPermissions",
            ash_protocol::ApprovalMode::BypassPermissions,
        ),
    ] {
        for command in [
            format!(
                r#"{{"type":"startShellTurn","command":"echo autoReview","approvalMode":"{old_id}"}}"#
            ),
            format!(
                r#"{{"type":"startTurn","kind":"coding","activatedSkills":[],"approvalMode":"{old_id}","toolMode":"direct","input":[{{"type":"text","text":"askPermissions"}}]}}"#
            ),
        ] {
            let json = format!(
                r#"{{"schemaVersion":22,"eventId":"accepted","sequence":2,"threadId":"old","recordedAt":1,"command":{{"commandId":"command","command":{command}}},"event":{{"type":"turnAccepted","threadId":"old","turnId":"turn","kind":"coding","policyRevision":"revision","approvalMode":"{old_id}","toolMode":"direct","activatedSkills":[]}}}}"#
            );
            let record: StoredEvent = serde_json::from_str(&json).unwrap();
            assert!(
                matches!(record.event, ThreadEvent::TurnAccepted { approval_mode, .. } if approval_mode == mode)
            );
            assert_eq!(serde_json::to_string(&record).unwrap(), json);
            let creation = r#"{"schemaVersion":22,"eventId":"created","sequence":1,"threadId":"old","recordedAt":1,"event":{"type":"threadCreated","agentId":"agent","sessionId":"session","threadId":"old","title":"Old"}}"#;
            let prefix = crate::HistoryPrefix {
                events: vec![serde_json::from_str(creation).unwrap(), record],
            };
            let digest = ash_protocol::ContentDigest::sha256(
                format!("{{\"events\":[{creation},{json}]}}").as_bytes(),
            );
            assert_eq!(prefix.reference().unwrap().digest, digest);
            let mut current = prefix.events.into_iter().last().unwrap();
            current.schema_version = CURRENT_STORED_EVENT_SCHEMA_VERSION;
            let value = serde_json::to_value(&current).unwrap();
            assert_eq!(
                value["command"]["command"]["approvalMode"],
                serde_json::to_value(mode).unwrap()
            );
            assert_eq!(
                value["event"]["approvalMode"],
                serde_json::to_value(mode).unwrap()
            );
            if old_id != "bypassPermissions" {
                assert!(
                    serde_json::from_str::<StoredEvent>(
                        &json.replace("\"schemaVersion\":22", "\"schemaVersion\":23")
                    )
                    .is_err()
                );
            }
        }
    }
}

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
                approval_mode: ash_protocol::ApprovalMode::Manual,
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

#[test]
fn legacy_imported_turns_keep_bytes_without_mode_while_current_turns_expose_it() {
    for approval_mode in ash_protocol::ApprovalMode::ALL {
        let turn: ash_protocol::Turn = serde_json::from_value(serde_json::json!({
            "turnId":"old-turn", "status":"completed", "items":[], "approvalMode":approval_mode
        }))
        .unwrap();
        for event in [
            ThreadEvent::HistoryImported {
                thread_id: ThreadId::new("old").unwrap(),
                source_thread_id: ThreadId::new("source").unwrap(),
                before_turn_id: ash_protocol::TurnId::new("before").unwrap(),
                turns: vec![turn.clone()],
            },
            ThreadEvent::ForkHistoryImported {
                thread_id: ThreadId::new("old").unwrap(),
                source_thread_id: ThreadId::new("source").unwrap(),
                source_sequence: 3,
                turns: vec![turn.clone()],
            },
            ThreadEvent::ForkTurnImported {
                thread_id: ThreadId::new("old").unwrap(),
                source_thread_id: ThreadId::new("source").unwrap(),
                source_sequence: 3,
                turn_index: 0,
                turn: Box::new(turn.clone()),
            },
        ] {
            let mut current = StoredEvent {
                time_context: None,
                schema_version: 22,
                event_id: EventId("imported".into()),
                sequence: 2,
                thread_id: ThreadId::new("old").unwrap(),
                recorded_at: Timestamp(1),
                command: None,
                event,
            };
            let encoded = serde_json::to_string(&current).unwrap();
            let restored: StoredEvent = serde_json::from_str(&encoded).unwrap();
            assert_eq!(serde_json::to_string(&restored).unwrap(), encoded);
            let legacy = encoded
                .replace("\"schemaVersion\":22", "\"schemaVersion\":21")
                .replace(",\"mode\":\"agent\"", "");
            let restored: StoredEvent = serde_json::from_str(&legacy).unwrap();
            assert_eq!(serde_json::to_string(&restored).unwrap(), legacy);
            assert!(encoded.contains("\"mode\":\"agent\""));
            current.schema_version = CURRENT_STORED_EVENT_SCHEMA_VERSION;
            let encoded = serde_json::to_string(&current).unwrap();
            assert!(encoded.contains(&format!("\"approvalMode\":\"{}\"", approval_mode.id())));
            assert_eq!(
                serde_json::from_str::<StoredEvent>(&encoded).unwrap(),
                current
            );
        }
    }
}
