use super::*;
use crate::ThreadRolloutTrace;
use ash_history::StoredEvent;
use serde_json::json;

fn invocation(sequence: u64, id: &str, usage: serde_json::Value) -> StoredEvent {
    serde_json::from_value(json!({
        "schemaVersion": ash_history::CURRENT_STORED_EVENT_SCHEMA_VERSION,
        "eventId": format!("event-{sequence}"), "sequence": sequence,
        "threadId": "root", "recordedAt": sequence,
        "event": {"type": "modelInvocationRecorded", "threadId": "root", "turnId": "turn", "record": {
            "invocationId": id, "threadId": "root", "turnId": "turn",
            "startedAtUnixMs": 1, "completedAtUnixMs": 2, "outcome": "completed", "usage": usage,
            "referenceCost": {"type": "unpriced", "reason": {"type": "missingUsage"}}
        }}
    })).unwrap()
}

fn trace(events: Vec<StoredEvent>) -> RolloutTrace {
    RolloutTrace {
        format_version: 3,
        session_id: ash_protocol::SessionId::new("session").unwrap(),
        threads: vec![ThreadRolloutTrace {
            thread_id: ThreadId::new("root").unwrap(),
            events,
        }],
        history_prefixes: Vec::new(),
        diagnostics: None,
        graph: None,
        overview: None,
    }
}

#[test]
fn deduplicates_accounting_and_preserves_independent_and_paired_usage_coverage() {
    let first = invocation(
        1,
        "first",
        json!({"inputTokens": 100, "outputTokens": 20,
        "cachedInputTokens": 80, "reasoningTokens": 10, "cacheWriteInputTokens": 5}),
    );
    let mut repeated = first.clone();
    repeated.sequence = 2;
    repeated.event_id = serde_json::from_value(json!("repeated")).unwrap();
    let summary = summarize_trace(&trace(vec![
        first,
        repeated,
        invocation(3, "second", json!({"inputTokens": null, "outputTokens": 0})),
        invocation(4, "third", serde_json::Value::Null),
    ]));
    assert_eq!(summary.model_calls, 3);
    assert_eq!(summary.excluded_model_calls, 0);
    assert_eq!(
        summary.input_tokens,
        TraceMetric {
            reported: Some("100".into()),
            reported_calls: 1,
            missing_calls: 2
        }
    );
    assert_eq!(
        summary.output_tokens,
        TraceMetric {
            reported: Some("20".into()),
            reported_calls: 2,
            missing_calls: 1
        }
    );
    assert_eq!(
        summary.total_tokens,
        TraceMetric {
            reported: Some("120".into()),
            reported_calls: 1,
            missing_calls: 2
        }
    );
    assert_eq!(summary.cached_input_tokens.reported.as_deref(), Some("80"));
    assert_eq!(summary.event_count, 4);
    assert_eq!(summary.thread_cursors[&ThreadId::new("root").unwrap()], 4);
}

#[test]
fn missing_reports_stay_unknown_and_zero_is_a_real_report() {
    let empty = summarize_trace(&trace(Vec::new()));
    assert_eq!(empty.model_calls, 0);
    assert_eq!(empty.input_tokens.reported, None);
    let zero = summarize_trace(&trace(vec![invocation(
        1,
        "zero",
        json!({"inputTokens": 0, "outputTokens": 0}),
    )]));
    assert_eq!(
        zero.total_tokens,
        TraceMetric {
            reported: Some("0".into()),
            reported_calls: 1,
            missing_calls: 0
        }
    );
    assert_eq!(
        zero.cached_input_tokens,
        TraceMetric {
            reported: None,
            reported_calls: 0,
            missing_calls: 1
        }
    );
}

#[test]
fn conflicting_call_identities_are_excluded_and_large_totals_are_lossless() {
    let summary = summarize_trace(&trace(vec![
        invocation(1, "conflict", json!({"inputTokens": 1})),
        invocation(2, "conflict", json!({"inputTokens": 99})),
        invocation(
            3,
            "large",
            json!({"inputTokens": u64::MAX, "outputTokens": u64::MAX}),
        ),
    ]));
    assert_eq!(summary.model_calls, 1);
    assert_eq!(summary.excluded_model_calls, 1);
    assert_eq!(
        summary.total_tokens.reported,
        Some((u128::from(u64::MAX) * 2).to_string())
    );
}

#[test]
fn tool_calls_count_completed_identities_once_per_thread_and_turn() {
    let call = |sequence, thread: &str, turn: &str| -> StoredEvent {
        serde_json::from_value(json!({
            "schemaVersion": ash_history::CURRENT_STORED_EVENT_SCHEMA_VERSION,
            "eventId": format!("{thread}-{sequence}"), "sequence": sequence,
            "threadId": thread, "recordedAt": sequence,
            "event": {"type": "itemCompleted", "threadId": thread, "turnId": turn,
                "item": {"type": "toolCall", "itemId": "item", "turnId": turn,
                    "toolCallId": "same-call", "name": "shell-command", "argumentsJson": "{}"}}
        }))
        .unwrap()
    };
    let mut capture = trace(vec![
        call(1, "root", "turn"),
        call(2, "root", "turn"),
        call(3, "root", "other"),
    ]);
    capture.threads.push(ThreadRolloutTrace {
        thread_id: ThreadId::new("child").unwrap(),
        events: vec![call(1, "child", "turn")],
    });
    assert_eq!(summarize_trace(&capture).tool_calls, 3);
}
