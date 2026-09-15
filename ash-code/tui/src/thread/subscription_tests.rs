use super::HISTORY_PAGE_TURNS;
use super::ThreadSubscription;
use super::ThreadUpdateDisposition;
use super::TranscriptUpdateDisposition;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::ClientError;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::session::MAX_THREAD_SNAPSHOT_TURNS;
use ash_app_server_protocol::protocol::session::ThreadHistoryBoundary;
use ash_app_server_protocol::protocol::session::ThreadSnapshotHistory;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptChange;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptUpdateEnvelope;
use ash_protocol::SessionId;
use ash_protocol::StreamCursor;
use ash_protocol::StreamInstanceId;
use ash_protocol::Thread;
use ash_protocol::ThreadEvent;
use ash_protocol::ThreadId;
use ash_protocol::ThreadStatus;
use ash_protocol::ThreadUpdate;
use ash_protocol::ThreadUpdateEnvelope;
use ash_protocol::Turn;
use ash_protocol::TurnId;
use ash_protocol::TurnStatus;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

#[derive(Clone)]
struct RecordingTransport {
    responses: VecDeque<String>,
    requests: Arc<Mutex<Vec<serde_json::Value>>>,
}

impl JsonRpcTransport for RecordingTransport {
    fn round_trip(&mut self, request: &str) -> Result<String, ClientError> {
        self.requests
            .lock()
            .expect("request log is not poisoned")
            .push(serde_json::from_str(request).expect("request is valid JSON"));
        self.responses
            .pop_front()
            .ok_or_else(|| ClientError::Transport("no response".into()))
    }
}

#[test]
fn newer_update_for_active_scope_requests_snapshot() {
    let snapshot = thread("session-1", "thread-1", 4);
    let mut subscription = ThreadSubscription::from_snapshot(&snapshot, HISTORY_PAGE_TURNS);

    assert_eq!(
        subscription.classify_update(&update("session-1", "thread-1", 5)),
        ThreadUpdateDisposition::RefreshSnapshot
    );
}

#[test]
fn subscribing_reads_every_history_page_before_installing_in_chronological_order() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let mut responses = VecDeque::new();
    for (index, name) in ["turn-3", "turn-2", "turn-1"].into_iter().enumerate() {
        let mut snapshot = thread("session-1", "thread-1", 7);
        snapshot.turns = vec![turn(name)];
        let turn_id = TurnId::new(name).unwrap();
        let entry = ash_app_server_protocol::protocol::transcript::ThreadTranscriptEntry::Item {
            entry_id: name.into(),
            turn_id: turn_id.clone(),
            item: ash_protocol::ThreadItem::AgentMessage {
                item_id: ash_protocol::ItemId::new(name).unwrap(),
                turn_id,
                text: name.into(),
            },
            transient: false,
        };
        responses.push_back(
            serde_json::json!({
                "jsonrpc": "2.0", "id": index + 1,
                "result": {
                    "thread": snapshot,
                    "transcript": {
                        "sessionId": "session-1", "threadId": "thread-1",
                        "durableSequence": 7, "revision": 9,
                        "entries": [entry]
                    },
                    "updates": [],
                    "history": {"hasOlderTurns": index < 2, "oldestTurnId": name}
                }
            })
            .to_string(),
        );
    }
    let mut client = AppServerClient::new(RecordingTransport {
        responses,
        requests: requests.clone(),
    });
    let (subscription, snapshot, transcript) = ThreadSubscription::start(
        &mut client,
        &SessionId::new("session-1").unwrap(),
        &ThreadId::new("thread-1").unwrap(),
    )
    .unwrap();
    assert_eq!(
        snapshot
            .turns
            .iter()
            .map(|turn| turn.turn_id.as_str())
            .collect::<Vec<_>>(),
        ["turn-1", "turn-2", "turn-3"]
    );
    assert_eq!(
        transcript
            .entries
            .iter()
            .map(|entry| entry.entry_id())
            .collect::<Vec<_>>(),
        ["turn-1", "turn-2", "turn-3"]
    );
    assert!(subscription.older_history().is_none());
    assert_eq!(transcript.revision, 9);
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[1]["params"]["history"]["turnId"], "turn-3");
    assert_eq!(requests[2]["params"]["history"]["turnId"], "turn-2");
}

#[test]
fn history_window_expands_one_page_at_a_time() {
    let snapshot = thread("session-1", "thread-1", 4);
    let mut subscription = ThreadSubscription::from_snapshot(&snapshot, HISTORY_PAGE_TURNS);

    assert_eq!(
        subscription.history(),
        ThreadSnapshotHistory::Latest { turn_limit: 50 }
    );
    subscription.expand_history();
    assert_eq!(
        subscription.history(),
        ThreadSnapshotHistory::Latest { turn_limit: 100 }
    );
}

#[test]
fn history_window_never_exceeds_the_server_limit() {
    let snapshot = thread("session-1", "thread-1", 4);
    let mut subscription =
        ThreadSubscription::from_snapshot(&snapshot, MAX_THREAD_SNAPSHOT_TURNS - 10);

    subscription.expand_history();

    assert_eq!(
        subscription.history(),
        ThreadSnapshotHistory::Latest {
            turn_limit: MAX_THREAD_SNAPSHOT_TURNS
        }
    );
}

#[test]
fn older_history_uses_the_server_turn_cursor() {
    let snapshot = thread("session-1", "thread-1", 4);
    let oldest_turn_id = ash_protocol::TurnId::new("turn-50").unwrap();
    let subscription = ThreadSubscription::from_snapshot_with_boundary(
        &snapshot,
        HISTORY_PAGE_TURNS,
        Some(ThreadHistoryBoundary {
            has_older_turns: true,
            oldest_turn_id: Some(oldest_turn_id.clone()),
        }),
    );

    assert_eq!(
        subscription.older_history(),
        Some(ThreadSnapshotHistory::Before {
            turn_id: oldest_turn_id,
            turn_limit: HISTORY_PAGE_TURNS,
        })
    );
}

#[test]
fn latest_snapshot_replaces_a_stale_history_boundary() {
    let mut initial = thread("session-1", "thread-1", 4);
    initial.turns = vec![turn("turn-50")];
    let mut subscription = ThreadSubscription::from_snapshot_with_boundary(
        &initial,
        HISTORY_PAGE_TURNS,
        Some(ThreadHistoryBoundary {
            has_older_turns: false,
            oldest_turn_id: Some(TurnId::new("turn-50").unwrap()),
        }),
    );
    assert_eq!(subscription.older_history(), None);

    let mut refreshed = thread("session-1", "thread-1", 5);
    refreshed.turns = vec![turn("turn-51")];
    let oldest_turn_id = TurnId::new("turn-51").unwrap();
    subscription.apply_latest_snapshot(
        &refreshed,
        0,
        ThreadHistoryBoundary {
            has_older_turns: true,
            oldest_turn_id: Some(oldest_turn_id.clone()),
        },
    );

    assert_eq!(
        subscription.older_history(),
        Some(ThreadSnapshotHistory::Before {
            turn_id: oldest_turn_id,
            turn_limit: HISTORY_PAGE_TURNS,
        })
    );
}

#[test]
fn transcript_revision_rejects_duplicates_and_requests_a_snapshot_for_gaps() {
    let snapshot = thread("session-1", "thread-1", 4);
    let mut subscription = ThreadSubscription::from_snapshot(&snapshot, HISTORY_PAGE_TURNS);

    assert_eq!(
        subscription.classify_transcript_update(&transcript_update(1, Vec::new())),
        TranscriptUpdateDisposition::Apply
    );
    assert_eq!(
        subscription.classify_transcript_update(&transcript_update(1, Vec::new())),
        TranscriptUpdateDisposition::Ignore
    );
    assert_eq!(
        subscription.classify_transcript_update(&transcript_update(3, Vec::new())),
        TranscriptUpdateDisposition::RefreshSnapshot
    );
}

#[test]
fn overflow_reset_advances_across_a_transcript_revision_gap() {
    let snapshot = thread("session-1", "thread-1", 4);
    let mut subscription = ThreadSubscription::from_snapshot(&snapshot, HISTORY_PAGE_TURNS);

    assert_eq!(
        subscription.classify_transcript_update(&transcript_update(
            9,
            vec![ThreadTranscriptChange::ClearTransient],
        )),
        TranscriptUpdateDisposition::Apply
    );
}

#[test]
fn an_older_async_snapshot_cannot_replace_a_newer_transcript_update() {
    let snapshot = thread("session-1", "thread-1", 4);
    let mut subscription = ThreadSubscription::from_snapshot(&snapshot, HISTORY_PAGE_TURNS);
    assert_eq!(
        subscription.classify_transcript_update(&transcript_update(1, Vec::new())),
        TranscriptUpdateDisposition::Apply
    );

    assert!(!subscription.apply_latest_snapshot(
        &snapshot,
        0,
        ThreadHistoryBoundary {
            has_older_turns: false,
            oldest_turn_id: None,
        },
    ));
}

#[test]
fn older_page_does_not_confirm_durable_state_missing_from_the_page() {
    let snapshot = thread("session-1", "thread-1", 4);
    let mut subscription = ThreadSubscription::from_snapshot_with_boundary(
        &snapshot,
        HISTORY_PAGE_TURNS,
        Some(ThreadHistoryBoundary {
            has_older_turns: true,
            oldest_turn_id: Some(TurnId::new("turn-50").unwrap()),
        }),
    );
    let mut older_page = thread("session-1", "thread-1", 7);
    older_page.turns = vec![turn("turn-1")];

    subscription.apply_history_page(
        &older_page,
        ThreadHistoryBoundary {
            has_older_turns: false,
            oldest_turn_id: Some(TurnId::new("turn-1").unwrap()),
        },
    );

    assert_eq!(
        subscription.classify_update(&update("session-1", "thread-1", 5)),
        ThreadUpdateDisposition::RefreshSnapshot
    );
}

#[test]
fn duplicate_and_updates_for_another_thread_do_not_request_snapshot() {
    let snapshot = thread("session-1", "thread-1", 4);
    let mut subscription = ThreadSubscription::from_snapshot(&snapshot, HISTORY_PAGE_TURNS);

    assert_eq!(
        subscription.classify_update(&update("session-1", "thread-1", 4)),
        ThreadUpdateDisposition::Ignore
    );
    assert_eq!(
        subscription.classify_update(&update("session-1", "thread-old", 5)),
        ThreadUpdateDisposition::Ignore
    );
}

#[test]
fn session_mismatch_for_active_thread_is_ignored() {
    let snapshot = thread("session-1", "thread-1", 4);
    let mut subscription = ThreadSubscription::from_snapshot(&snapshot, HISTORY_PAGE_TURNS);

    assert_eq!(
        subscription.classify_update(&update("session-old", "thread-1", 4)),
        ThreadUpdateDisposition::Ignore
    );
}

#[test]
fn confirming_a_new_snapshot_suppresses_buffered_duplicates() {
    let snapshot = thread("session-1", "thread-1", 4);
    let mut subscription = ThreadSubscription::from_snapshot(&snapshot, HISTORY_PAGE_TURNS);
    subscription.confirm_sequence(7);

    assert_eq!(
        subscription.classify_update(&update("session-1", "thread-1", 6)),
        ThreadUpdateDisposition::Ignore
    );
    assert_eq!(
        subscription.classify_update(&update("session-1", "thread-1", 8)),
        ThreadUpdateDisposition::RefreshSnapshot
    );
}

#[test]
fn transient_thread_updates_are_ignored_because_transcript_updates_drive_display() {
    let snapshot = thread("session-1", "thread-1", 4);
    let mut subscription = ThreadSubscription::from_snapshot(&snapshot, HISTORY_PAGE_TURNS);
    assert_eq!(
        subscription.classify_update(&transient_update("stream-1", 1)),
        ThreadUpdateDisposition::Ignore
    );
}

#[test]
fn switching_threads_unsubscribes_the_previous_session_and_thread() {
    let previous = thread("session-1", "thread-1", 4);
    let next = thread("session-2", "thread-2", 7);
    let requests = Arc::new(Mutex::new(Vec::new()));
    let mut client = AppServerClient::new(RecordingTransport {
        responses: VecDeque::from([
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "thread": next,
                    "transcript": {
                        "sessionId": "session-2",
                        "threadId": "thread-2",
                        "durableSequence": 7,
                        "revision": 0,
                        "entries": []
                    },
                    "updates": [],
                    "history": { "hasOlderTurns": false, "oldestTurnId": null }
                }
            })
            .to_string(),
            serde_json::json!({ "jsonrpc": "2.0", "id": 2, "result": null }).to_string(),
        ]),
        requests: Arc::clone(&requests),
    });
    let mut subscription = ThreadSubscription::from_snapshot(&previous, HISTORY_PAGE_TURNS);

    subscription
        .switch(
            &mut client,
            &SessionId::new("session-2").unwrap(),
            &ThreadId::new("thread-2").unwrap(),
        )
        .expect("thread switch should succeed");

    let requests = requests.lock().expect("request log is not poisoned");
    assert_eq!(requests[0]["params"]["history"]["type"], "latest");
    assert_eq!(requests[0]["params"]["history"]["turnLimit"], 50);
    assert_eq!(requests[1]["method"], "session/thread/unsubscribe");
    assert_eq!(requests[1]["params"]["sessionId"], "session-1");
    assert_eq!(requests[1]["params"]["threadId"], "thread-1");
}

#[test]
fn bounded_snapshot_without_a_history_boundary_is_rejected() {
    let snapshot = thread("session-1", "thread-1", 4);
    let mut client = AppServerClient::new(RecordingTransport {
        responses: VecDeque::from([serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "thread": snapshot.clone(),
                "transcript": {
                    "sessionId": "session-1",
                    "threadId": "thread-1",
                    "durableSequence": 4,
                    "revision": 0,
                    "entries": []
                }
            }
        })
        .to_string()]),
        requests: Arc::new(Mutex::new(Vec::new())),
    });
    let mut subscription = ThreadSubscription::from_snapshot(&snapshot, HISTORY_PAGE_TURNS);

    assert!(matches!(
        subscription.switch(
            &mut client,
            &SessionId::new("session-1").unwrap(),
            &ThreadId::new("thread-1").unwrap(),
        ),
        Err(ClientError::Protocol(message)) if message.contains("history boundary")
    ));
}

fn thread(session_id: &str, thread_id: &str, sequence: u64) -> Thread {
    Thread {
        agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
        origin: Default::default(),
        session_id: SessionId::new(session_id).unwrap(),
        thread_id: ThreadId::new(thread_id).unwrap(),
        parent_thread_id: None,
        forked_from_id: None,
        title: "Thread".into(),
        status: ThreadStatus::Active,
        sequence,
        usage: ash_protocol::ModelUsageSummary::default(),
        reference_cost: ash_protocol::ModelReferenceCostSummary::default(),
        goal: None,
        turns: Vec::new(),
    }
}

fn turn(turn_id: &str) -> Turn {
    Turn {
        turn_id: TurnId::new(turn_id).unwrap(),
        status: TurnStatus::Completed,
        kind: Default::default(),
        instructions: None,
        model: None,
        tool_profile: None,
        tool_mode: ash_protocol::ToolMode::Direct,
        approval_mode: ash_protocol::ApprovalMode::AskPermissions,
        usage: ash_protocol::ModelUsageSummary::default(),
        context_usage: None,
        items: Vec::new(),
        plan: None,
        pending_interaction: None,
        error: None,
    }
}

fn update(session_id: &str, thread_id: &str, durable_sequence: u64) -> ThreadUpdateEnvelope {
    let session_id = SessionId::new(session_id).unwrap();
    let thread_id = ThreadId::new(thread_id).unwrap();
    ThreadUpdateEnvelope {
        session_id: session_id.clone(),
        thread_id: thread_id.clone(),
        durable_sequence,
        stream_cursor: None,
        update: ThreadUpdate::Committed {
            event: ThreadEvent::ThreadCreated {
                agent_id: Some(ash_protocol::AgentId::new("agent-test").unwrap()),
                origin: Default::default(),
                agent: None,
                session_id,
                thread_id,
                title: "Thread".into(),
            },
        },
    }
}

fn transcript_update(
    revision: u64,
    changes: Vec<ThreadTranscriptChange>,
) -> ThreadTranscriptUpdateEnvelope {
    ThreadTranscriptUpdateEnvelope {
        session_id: SessionId::new("session-1").unwrap(),
        thread_id: ThreadId::new("thread-1").unwrap(),
        durable_sequence: 4,
        revision,
        stream_cursor: None,
        changes,
    }
}

fn transient_update(stream_id: &str, sequence: u64) -> ThreadUpdateEnvelope {
    ThreadUpdateEnvelope {
        session_id: SessionId::new("session-1").unwrap(),
        thread_id: ThreadId::new("thread-1").unwrap(),
        durable_sequence: 4,
        stream_cursor: Some(StreamCursor {
            stream_instance_id: StreamInstanceId::new(stream_id).unwrap(),
            sequence,
        }),
        update: ThreadUpdate::ItemDelta {
            turn_id: ash_protocol::TurnId::new("turn-1").unwrap(),
            item_id: ash_protocol::ItemId::new("item-1").unwrap(),
            delta: ash_protocol::ItemDelta::AgentMessage { text: "x".into() },
        },
    }
}
