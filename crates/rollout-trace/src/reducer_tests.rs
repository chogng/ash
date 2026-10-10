use super::*;
use ash_history::StoredEvent;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use serde_json::json;
use std::collections::BTreeMap;

#[test]
fn accounting_edges_require_the_committed_thread_turn_identity_and_sequence() {
    let ledger: StoredEvent = serde_json::from_value(json!({
        "schemaVersion": ash_history::CURRENT_STORED_EVENT_SCHEMA_VERSION,
        "eventId": "committed-event", "sequence": 9, "threadId": "root", "recordedAt": 1,
        "event": {"type": "modelInvocationRecorded", "threadId": "root", "turnId": "turn", "record": {
            "invocationId": "committed", "threadId": "root", "turnId": "turn",
            "startedAtUnixMs": 1, "completedAtUnixMs": 2, "outcome": "completed",
            "referenceCost": {"type": "unpriced", "reason": {"type": "missingUsage"}}
        }}
    })).unwrap();
    let trace = RolloutTrace {
        format_version: 3,
        session_id: SessionId::new("s").unwrap(),
        threads: vec![ThreadRolloutTrace {
            thread_id: ThreadId::new("root").unwrap(),
            events: vec![ledger],
        }],
        history_prefixes: Vec::new(),
        diagnostics: None,
        graph: None,
    };
    let event = |sequence, event| DiagnosticEvent {
        event_id: format!("diag-{sequence}"),
        sequence,
        recorded_at: 0,
        thread_id: ThreadId::new("root").unwrap(),
        turn_id: Some(TurnId::new("turn").unwrap()),
        event,
    };
    let mut diagnostics = DiagnosticTrace {
        format_version: 2,
        capture_id: Some("capture".into()),
        recording_status: RecordingStatus::Recording,
        dropped_records: 0,
        pending_records: 0,
        payloads: BTreeMap::new(),
        events: vec![
            event(
                1,
                DiagnosticEventKind::ModelAttemptStarted {
                    attempt_id: "attempt".into(),
                    purpose: InferencePurpose::Agent,
                    model: None,
                    source_thread_sequence: 7,
                    request_payload: PayloadRef {
                        payload_id: "payload-1".into(),
                        kind: PayloadKind::CoreRequest,
                        byte_length: 0,
                        status: PayloadStatus::Omitted,
                        digest: None,
                    },
                },
            ),
            event(
                2,
                DiagnosticEventKind::ModelAttemptAccounted {
                    attempt_id: "attempt".into(),
                    invocation_id: ash_protocol::ModelInvocationId::new("committed").unwrap(),
                    source_thread_sequence: 9,
                },
            ),
        ],
    };
    let graph = reduce_trace(&trace, &diagnostics, |_| {
        panic!("accounting links never need bodies")
    });
    assert!(graph.warnings.is_empty());
    assert!(graph.edges.contains(&TraceEdge {
        from: "attempt:root:turn:attempt".into(),
        to: "invocation:root:turn:committed".into(),
        kind: TraceEdgeKind::AccountsFor
    }));
    assert_eq!(
        graph.nodes["invocation:root:turn:committed"]
            .event_key
            .as_deref(),
        Some("root:9")
    );
    for record in &mut diagnostics.events {
        record.turn_id = Some(TurnId::new("other").unwrap());
    }
    let graph = reduce_trace(&trace, &diagnostics, |_| panic!());
    assert!(
        !graph
            .edges
            .iter()
            .any(|edge| edge.kind == TraceEdgeKind::AccountsFor)
    );
    assert_eq!(graph.warnings.len(), 1);
    for record in &mut diagnostics.events {
        record.turn_id = Some(TurnId::new("turn").unwrap());
    }
    if let DiagnosticEventKind::ModelAttemptAccounted {
        source_thread_sequence,
        ..
    } = &mut diagnostics.events[1].event
    {
        *source_thread_sequence = 8;
    }
    let graph = reduce_trace(&trace, &diagnostics, |_| panic!());
    assert!(
        !graph
            .edges
            .iter()
            .any(|edge| edge.kind == TraceEdgeKind::AccountsFor)
    );
}

#[test]
fn reducer_links_observed_model_calls_code_cells_commands_and_results_without_inventing_input() {
    let record = |sequence, item| -> StoredEvent {
        serde_json::from_value(json!({ "schemaVersion": ash_history::CURRENT_STORED_EVENT_SCHEMA_VERSION, "eventId": format!("event-{sequence}"), "sequence": sequence, "threadId": "root", "recordedAt": 1, "event": { "type": "itemCompleted", "threadId": "root", "turnId": "turn", "item": item } })).unwrap()
    };
    let trace = RolloutTrace {
        format_version: 3,
        session_id: SessionId::new("s").unwrap(),
        threads: vec![ThreadRolloutTrace {
            thread_id: ThreadId::new("root").unwrap(),
            events: vec![
                record(
                    1,
                    json!({ "type": "toolCall", "itemId": "parent-item", "turnId": "turn", "toolCallId": "parent", "name": "exec", "argumentsJson": "{}" }),
                ),
                record(
                    2,
                    json!({ "type": "toolCall", "itemId": "child-item", "turnId": "turn", "toolCallId": "child", "name": "exec_command", "argumentsJson": "{}", "binding": { "registryGeneration": 1, "definitionDigest": "definition", "sourceChain": [], "caller": { "type": "codeMode", "parentToolCallId": "parent", "cellId": "cell", "runtimeCallId": "runtime" }, "activity": { "type": "command", "program": "echo", "arguments": ["value"], "workingDirectory": "." } } }),
                ),
                record(
                    3,
                    json!({ "type": "toolResult", "itemId": "result-item", "turnId": "turn", "toolCallId": "child", "text": "secret runtime output not supplied to model", "isError": false }),
                ),
            ],
        }],
        history_prefixes: Vec::new(),
        diagnostics: None,
        graph: None,
    };
    let payload = PayloadRef {
        payload_id: "payload-1".into(),
        kind: PayloadKind::ModelResponse,
        byte_length: 0,
        status: PayloadStatus::Saved,
        digest: None,
    };
    let observation = |sequence, event| DiagnosticEvent {
        event_id: format!("diagnostic-{sequence}"),
        sequence,
        recorded_at: 1,
        thread_id: ThreadId::new("root").unwrap(),
        turn_id: Some(TurnId::new("turn").unwrap()),
        event,
    };
    let diagnostics = DiagnosticTrace {
        format_version: 1,
        capture_id: Some("capture".into()),
        recording_status: RecordingStatus::Recording,
        dropped_records: 0,
        pending_records: 0,
        payloads: BTreeMap::new(),
        events: vec![
            observation(
                1,
                DiagnosticEventKind::ModelAttemptStarted {
                    attempt_id: "attempt".into(),
                    purpose: InferencePurpose::Agent,
                    model: None,
                    source_thread_sequence: 1,
                    request_payload: payload.clone(),
                },
            ),
            observation(
                2,
                DiagnosticEventKind::ModelAttemptCompleted {
                    attempt_id: "attempt".into(),
                    response_payload: payload,
                },
            ),
        ],
    };
    let graph = reduce_trace(&trace, &diagnostics, |_| {
        Ok(json!({ "output": [{ "type": "toolCall", "value": { "id": "parent" } }] }))
    });
    assert!(graph.warnings.is_empty());
    assert!(graph.edges.contains(&TraceEdge {
        from: "attempt:root:turn:attempt".into(),
        to: "tool:root:turn:parent".into(),
        kind: TraceEdgeKind::RequestsTool
    }));
    assert_eq!(
        graph.nodes["runtime-call:root:turn:cell:runtime"].kind,
        TraceNodeKind::RuntimeCall
    );
    assert_eq!(
        graph.nodes["cell:root:turn:cell"].event_key.as_deref(),
        Some("root:1")
    );
    assert_eq!(
        graph.nodes["terminal-operation:tool:root:turn:child"].label,
        "echo value"
    );
    assert!(graph.edges.contains(&TraceEdge {
        from: "tool:root:turn:child".into(),
        to: "result:tool:root:turn:child".into(),
        kind: TraceEdgeKind::Result
    }));
    assert!(
        !serde_json::to_string(&graph)
            .unwrap()
            .contains("secret runtime output")
    );
    assert_eq!(
        graph,
        reduce_trace(&trace, &diagnostics, |_| Ok(
            json!({ "output": [{ "type": "toolCall", "value": { "id": "parent" } }] })
        ))
    );
    let missing = reduce_trace(&trace, &diagnostics, |_| {
        Err("missing response evidence".into())
    });
    assert_eq!(missing.warnings, ["missing response evidence"]);
    assert!(
        !missing
            .edges
            .iter()
            .any(|edge| edge.kind == TraceEdgeKind::RequestsTool)
    );
}

#[test]
fn reducer_links_message_delivery_and_delegation_using_saved_identities() {
    let record = |thread: &str, sequence, event| -> StoredEvent {
        serde_json::from_value(json!({
            "schemaVersion": ash_history::CURRENT_STORED_EVENT_SCHEMA_VERSION,
            "eventId": format!("{thread}-{sequence}"), "sequence": sequence,
            "threadId": thread, "recordedAt": 1, "event": event
        }))
        .unwrap()
    };
    let message = json!({
        "messageId": "delivered", "delegationId": "delegation",
        "senderThreadId": "root", "receiverThreadId": "child", "senderSequence": 2,
        "content": { "type": "instruction", "text": "inspect the fixture" },
        "provenance": "agent"
    });
    let trace = RolloutTrace {
        format_version: 3,
        session_id: SessionId::new("session").unwrap(),
        threads: vec![
            ThreadRolloutTrace {
                thread_id: ThreadId::new("child").unwrap(),
                events: vec![
                    record(
                        "child",
                        1,
                        json!({ "type": "threadCreated", "threadId": "child", "sessionId": "session", "title": "Child", "origin": { "type": "agentSpawn", "parentThreadId": "root", "parentSequence": 1, "delegationId": "delegation" } }),
                    ),
                    record(
                        "child",
                        2,
                        json!({ "type": "agentMessageReceived", "threadId": "child", "message": message.clone() }),
                    ),
                ],
            },
            ThreadRolloutTrace {
                thread_id: ThreadId::new("root").unwrap(),
                events: vec![
                    record(
                        "root",
                        1,
                        json!({ "type": "threadCreated", "threadId": "root", "sessionId": "session", "title": "Root" }),
                    ),
                    record(
                        "root",
                        2,
                        json!({ "type": "agentMessageSent", "threadId": "root", "message": message }),
                    ),
                    record(
                        "root",
                        3,
                        json!({ "type": "delegationStarted", "threadId": "root", "delegationId": "delegation", "childThreadId": "child" }),
                    ),
                    record(
                        "root",
                        4,
                        json!({ "type": "delegationStarted", "threadId": "root", "delegationId": "unavailable", "childThreadId": "missing" }),
                    ),
                ],
            },
        ],
        history_prefixes: Vec::new(),
        diagnostics: None,
        graph: None,
    };
    let diagnostics = DiagnosticTrace {
        format_version: 1,
        capture_id: None,
        recording_status: RecordingStatus::Disabled,
        dropped_records: 0,
        pending_records: 0,
        events: Vec::new(),
        payloads: BTreeMap::new(),
    };
    let graph = reduce_trace(&trace, &diagnostics, |_| {
        unreachable!("no model evidence in fixture")
    });
    for kind in [TraceEdgeKind::ChildThread, TraceEdgeKind::Delegates] {
        assert!(graph.edges.contains(&TraceEdge {
            from: "thread:root".into(),
            to: "thread:child".into(),
            kind
        }));
    }
    assert!(graph.edges.contains(&TraceEdge {
        from: "message-sent:delivered".into(),
        to: "message-received:delivered".into(),
        kind: TraceEdgeKind::DeliversMessage,
    }));
    assert_eq!(graph.nodes["thread:root"].label, "Root");
    assert_eq!(
        graph.nodes["message-sent:delivered"].event_key.as_deref(),
        Some("root:2")
    );
    assert_eq!(
        graph.nodes["message-received:delivered"]
            .event_key
            .as_deref(),
        Some("child:2")
    );
    assert!(!graph.nodes.contains_key("thread:missing"));
    assert_eq!(
        graph.warnings,
        ["missing graph endpoint: thread:root -> thread:missing"]
    );
}
