use super::*;
use ash_protocol::CommandId;
use ash_protocol::SessionId;
use ash_protocol::ThreadCommand;
use ash_protocol::ThreadEvent;
use ash_protocol::ThreadId;
use serde_json::Value;

#[test]
fn legacy_creation_keeps_the_classification_bytes_used_by_history_prefixes() {
    use ash_protocol::SessionKind;

    for (field, kind) in [
        ("", SessionKind::Code),
        (r#","surface":"chat""#, SessionKind::Chat),
        (r#","surface":"code""#, SessionKind::Code),
    ] {
        let json = format!(
            r#"{{"schemaVersion":32,"eventId":"created","sequence":1,"threadId":"old","recordedAt":1,"event":{{"type":"threadCreated","agentId":"agent","sessionId":"old","threadId":"old","title":"Old"{field},"executionTarget":{{"type":"local","root":"/repo"}}}}}}"#
        );
        let event: StoredEvent = serde_json::from_str(&json).unwrap();
        assert!(
            matches!(event.event, ThreadEvent::ThreadCreated { kind: actual, .. } if actual == kind)
        );
        assert_eq!(serde_json::to_string(&event).unwrap(), json);
        let prefix = crate::HistoryPrefix {
            events: vec![event],
        };
        assert_eq!(
            prefix.reference().unwrap().digest,
            ash_protocol::ContentDigest::sha256(format!(r#"{{"events":[{json}]}}"#).as_bytes())
        );
    }
}

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
            let creation = r#"{"schemaVersion":22,"eventId":"created","sequence":1,"threadId":"old","recordedAt":1,"event":{"type":"threadCreated","agentId":"agent","sessionId":"session","threadId":"old","title":"Old","kind":"code"}}"#;
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
fn history_discards_schema_38_mode_fields_and_keeps_schema_39_strict() {
    let base =
        ash_protocol::TurnInstructions::new("modes", "swarm", "v1", "Coordinate workers.").unwrap();
    let instructions = base
        .clone()
        .with_task_instructions(&base)
        .with_task_command(Some(ash_protocol::TaskExecution::Swarm))
        .with_model_guidance(ash_protocol::ModelInstructionSelection::Specialized {
            model: ash_protocol::ModelRef::new(
                ash_protocol::ProviderId::new("test").unwrap(),
                ash_protocol::ModelId::new("model").unwrap(),
            ),
            instructions: base.as_text(),
            digest: ash_protocol::ContentDigest::sha256(base.body().as_bytes()),
            messages: Some(ash_protocol::ModelInstructionMessages {
                task_commands: [(ash_protocol::TaskExecution::Swarm, base.as_text())].into(),
                ..Default::default()
            }),
        });
    let turn = serde_json::json!({
        "turnId": "turn",
        "status": "completed",
        "instructions": &instructions,
        "directory": { "type": "local", "root": "/repo" },
        "items": [],
        "startedToolCallIds": ["tool"]
    });
    let records = [
        serde_json::json!({
            "event": {
                "type": "turnAccepted", "threadId": "old", "turnId": "turn",
                "instructions": &instructions
            }
        }),
        serde_json::json!({
            "command": {
                "commandId": "start",
                "command": {
                    "type": "startTurn", "kind": "coding", "instructions": &instructions,
                    "contextPolicy": { "mode": "summary", "contextWindowAsToolOutput": true },
                    "input": [{ "type": "text", "text": "Coordinate the updates" }]
                }
            },
            "event": {
                "type": "turnAccepted", "threadId": "old", "turnId": "turn",
                "directory": { "type": "local", "root": "/repo" }
            }
        }),
        serde_json::json!({
            "event": {
                "type": "historyImported", "threadId": "old", "sourceThreadId": "source",
                "beforeTurnId": "before", "turns": [turn.clone()]
            }
        }),
        serde_json::json!({
            "event": {
                "type": "forkHistoryImported", "threadId": "old", "sourceThreadId": "source",
                "sourceSequence": 1, "turns": [turn.clone()]
            }
        }),
        serde_json::json!({
            "event": {
                "type": "forkTurnImported", "threadId": "old", "sourceThreadId": "source",
                "sourceSequence": 1, "turnIndex": 0, "turn": turn
            }
        }),
    ];
    for mut value in records {
        value["eventId"] = "event".into();
        value["threadId"] = "old".into();
        value["sequence"] = 2.into();
        value["recordedAt"] = 1.into();
        value["schemaVersion"] = 39.into();
        let record: StoredEvent = serde_json::from_value(value.clone()).unwrap();
        let encoded = serde_json::to_string(&record).unwrap();
        let restored: StoredEvent = serde_json::from_str(&encoded).unwrap();
        assert_eq!(serde_json::to_string(&restored).unwrap(), encoded);
        assert!(encoded.contains(r#""taskCommand":"swarm""#));
        let retired = encoded
            .replace(r#""taskInstructions":"#, r#""modeInstructions":"#)
            .replace(r#""taskCommands":"#, r#""agentModes":"#);
        assert_ne!(retired, encoded);
        assert!(serde_json::from_str::<StoredEvent>(&retired).is_err());
        let legacy = retired.replace(r#""schemaVersion":39"#, r#""schemaVersion":38"#);
        let decoded: StoredEvent = serde_json::from_str(&legacy).unwrap();
        assert_eq!(serde_json::to_string(&decoded).unwrap(), legacy);
        let projected = serde_json::to_string(&(decoded.event, decoded.command)).unwrap();
        assert!(projected.contains(r#""taskCommand":"swarm""#));
        assert!(projected.contains(r#""taskCommands":{}"#));
        assert!(!projected.contains(r#""taskInstructions""#));
        assert!(
            serde_json::from_str::<StoredEvent>(
                &encoded.replace(r#""taskCommand":"swarm""#, r#""taskCommand":"multitask""#)
            )
            .is_err()
        );

        for path in [
            "/event",
            "/command/command",
            "/event/turn",
            "/event/turns/0",
        ] {
            let mut retired = value.clone();
            if let Some(object) = retired
                .pointer_mut(path)
                .and_then(|value| value.as_object_mut())
            {
                object.insert("mode".into(), "swarm".into());
                assert!(serde_json::from_value::<StoredEvent>(retired).is_err());
            }
        }
    }
}

#[test]
fn legacy_mode_changes_preserve_the_event_used_by_history_and_checkpoint_digests() {
    let creation = r#"{"schemaVersion":38,"eventId":"created","sequence":1,"threadId":"old","recordedAt":1,"event":{"type":"threadCreated","agentId":"agent","sessionId":"session","threadId":"old","title":"Old","kind":"code"}}"#;
    let change = r#"{"schemaVersion":38,"eventId":"change","sequence":2,"threadId":"old","recordedAt":2,"event":{"type":"turnModeChanged","threadId":"old","turnId":"turn","fromMode":"agent","mode":"plan","instructions":{"owner":"test","id":"base","revision":"1","body":"Base","modeInstructions":{"owner":"test","id":"plan","revision":"1","body":"Plan"}}}}"#;
    let record: StoredEvent = serde_json::from_str(change).unwrap();
    assert!(matches!(
        &record.event,
        ThreadEvent::RetiredTurnEvent { turn_id, .. } if turn_id.as_str() == "turn"
    ));
    assert_eq!(
        record.event_value_for_digest().unwrap(),
        serde_json::from_str::<Value>(change).unwrap()["event"]
    );
    let prefix = crate::HistoryPrefix {
        events: vec![serde_json::from_str(creation).unwrap(), record],
    };
    let bytes = format!(r#"{{"events":[{creation},{change}]}}"#);
    assert_eq!(serde_json::to_string(&prefix).unwrap(), bytes);
    assert_eq!(
        prefix.reference().unwrap().digest,
        ash_protocol::ContentDigest::sha256(bytes.as_bytes()),
    );
    assert!(
        serde_json::from_str::<StoredEvent>(&change.replace("Version\":38", "Version\":39"))
            .is_err()
    );
}

#[test]
fn legacy_delegation_seed_is_verified_before_retired_guidance_is_discarded() {
    let revision = ash_protocol::ContentDigest::sha256(b"Coordinate.");
    let guidance =
        format!(r#"{{"owner":"test","id":"swarm","revision":"{revision}","body":"Coordinate."}}"#);
    for (version, key, mode) in [
        (38, "agentModes", "swarm"),
        (36, "collaborationModes", "swarm"),
        (35, "collaborationModes", "multitask"),
    ] {
        let instructions = format!(
            r#"{{"owner":"test","id":"base","revision":"1","body":"Base","modelGuidance":{{"type":"specialized","model":{{"provider":"test","model":"test"}},"instructions":{guidance},"digest":"{revision}","messages":{{"tools":{{}},"{key}":{{"{mode}":{guidance}}},"root":null,"subagent":null}}}},"modeInstructions":{guidance}}}"#
        );
        let material = format!(
            r#"{{"delegationId":"d","parentThreadId":"parent","parentTurnId":"turn","parentSequence":3,"task":{{"title":"Task","instructions":"Do the work."}},"role":null,"inheritance":{{"type":"fresh"}},"policyCeiling":{{"policyRevision":"policy"}},"capabilityScope":{{"tools":[],"skills":[]}},"baseInstructions":{instructions}}}"#
        );
        let digest = ash_protocol::ContentDigest::sha256(material.as_bytes());
        let seed_material = material.strip_suffix('}').unwrap();
        let event = format!(
            r#"{{"schemaVersion":{version},"eventId":"delegation","sequence":4,"threadId":"parent","recordedAt":1,"event":{{"type":"delegationRequested","threadId":"parent","seed":{seed_material},"digest":"{digest}"}}}}}}"#
        );
        let decoded: StoredEvent = serde_json::from_str(&event).unwrap();
        assert_eq!(serde_json::to_string(&decoded).unwrap(), event);
        let ThreadEvent::DelegationRequested { seed, .. } = decoded.event else {
            panic!("expected a delegation request");
        };
        assert_ne!(seed.digest.as_str(), digest.as_str());
        assert_eq!(crate::context_seed_digest(&seed).unwrap(), seed.digest);
        assert!(
            seed.agent
                .base_instructions
                .as_ref()
                .unwrap()
                .task_instructions()
                .is_none()
        );
        assert!(
            serde_json::from_str::<StoredEvent>(&event.replace("Do the work.", "Different task."))
                .is_err()
        );
    }
}

#[test]
fn stored_event_round_trip_preserves_history_contract() {
    let thread_id = ThreadId::new("thread_1").unwrap();
    let event = StoredEvent {
        encoding: Default::default(),
        thread_created_kind_encoding: Default::default(),
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
            kind: ash_protocol::SessionKind::Code,
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
    let mut untyped = serde_json::to_value(&event).unwrap();
    untyped["event"].as_object_mut().unwrap().remove("kind");
    assert!(serde_json::from_value::<StoredEvent>(untyped).is_err());
}

#[test]
fn legacy_workspace_field_replays_as_execution_target() {
    let json = r#"{"schemaVersion":20,"eventId":"created","sequence":1,"threadId":"old","recordedAt":1,"event":{"type":"threadCreated","agentId":"agent","sessionId":"session","threadId":"old","title":"Old","kind":"code","workspace":{"type":"local","root":"/repo"}}}"#;
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
    let json = r#"{"schemaVersion":15,"eventId":"created","sequence":1,"threadId":"old","recordedAt":1,"event":{"type":"threadCreated","sessionId":"session","threadId":"old","title":"Old","kind":"code"}}"#;
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
fn imported_turns_preserve_legacy_approval_bytes_without_agent_mode() {
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
                encoding: Default::default(),
                thread_created_kind_encoding: Default::default(),
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
            let legacy = encoded.replace("\"schemaVersion\":22", "\"schemaVersion\":21");
            let restored: StoredEvent = serde_json::from_str(&legacy).unwrap();
            assert_eq!(serde_json::to_string(&restored).unwrap(), legacy);
            assert!(!encoded.contains("\"mode\":\"agent\""));
            current.schema_version = 37;
            let encoded = serde_json::to_string(&current).unwrap();
            assert!(!encoded.contains("\"mode\":\"agent\""));
            assert_eq!(
                serde_json::to_string(&serde_json::from_str::<StoredEvent>(&encoded).unwrap())
                    .unwrap(),
                encoded,
            );
            current.schema_version = CURRENT_STORED_EVENT_SCHEMA_VERSION;
            let encoded = serde_json::to_string(&current).unwrap();
            assert!(!encoded.contains("\"mode\":\"agent\""));
            assert!(encoded.contains(&format!("\"approvalMode\":\"{}\"", approval_mode.id())));
            assert_eq!(
                serde_json::from_str::<StoredEvent>(&encoded).unwrap(),
                current
            );
        }
    }
}
