use super::*;
use ash_history::CURRENT_STORED_EVENT_SCHEMA_VERSION;
use ash_history::EventId;
use ash_history::StoredEvent;
use ash_history::Timestamp;
use ash_protocol::SessionManagerInfo;
use ash_protocol::SessionThread;
use ash_protocol::ThreadEvent;
use ash_protocol::ThreadStatus;

fn batch(expected_sequence: u64, event_sequence: u64) -> ThreadEventBatch {
    ThreadEventBatch {
        history_prefixes: Vec::new(),
        batch_id: "batch_1".into(),
        thread_id: ThreadId::new("thread_1").expect("test ID is non-empty"),
        expected_sequence,
        events: vec![StoredEvent {
            time_context: None,
            schema_version: CURRENT_STORED_EVENT_SCHEMA_VERSION,
            event_id: EventId("event_1".into()),
            sequence: event_sequence,
            thread_id: ThreadId::new("thread_1").expect("test ID is non-empty"),
            recorded_at: Timestamp(1),
            command: None,
            event: ThreadEvent::ThreadCreated {
                agent_id: Some(ash_protocol::AgentId::new("agent-test").unwrap()),
                origin: Default::default(),
                agent: None,
                session_id: ash_protocol::SessionId::new("session_1")
                    .expect("test ID is non-empty"),
                thread_id: ThreadId::new("thread_1").expect("test ID is non-empty"),
                title: "test".into(),
                execution_target: None,
            },
        }],
        catalog: ThreadCatalogRecord {
            model: None,
            binding: agent_graph_store::ThreadBinding {
                agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
                session_id: SessionId::new("session_1").unwrap(),
                thread_id: ThreadId::new("thread_1").unwrap(),
                origin: Default::default(),
            },
            session_id: ash_protocol::SessionId::new("session_1").expect("test ID is non-empty"),
            thread: SessionThread {
                manager: None,
                thread_id: ThreadId::new("thread_1").expect("test ID is non-empty"),
                title: "test".into(),
                created_at_unix_ms: 1,
                completed_turn_duration_ms: 0,
                active_turn_started_at_unix_ms: None,
                usage: Default::default(),
                parent_thread_id: None,
                forked_from_id: None,
                status: ThreadStatus::Active,
            },
            execution_target: None,
            sequence: event_sequence,
            manager: SessionManagerInfo::default(),
            archived_at_unix_ms: None,
            stopped: false,
            requires_startup_recovery: false,
        },
    }
}

#[test]
fn validation_rejects_stale_expected_sequence() {
    assert_eq!(
        validate_append_batch(&batch(3, 4), 2),
        Err(ThreadStoreError::SequenceConflict {
            expected: 3,
            actual: 2
        })
    );
}

#[test]
fn validation_rejects_event_sequence_outside_the_batch() {
    assert!(matches!(
        validate_append_batch(&batch(0, 2), 0),
        Err(ThreadStoreError::InvalidBatch(_))
    ));
}

#[test]
fn session_branches_use_outer_management_even_with_stale_nested_metadata() {
    let mut record = batch(0, 1).catalog;
    record.manager = ash_protocol::SessionManagerInfo {
        status: ash_protocol::SessionManagerStatus::Working,
        status_changed_at_unix_ms: 12,
        activity: Some(ash_protocol::SessionManagerActivity::Operation {
            text: "Running a tool".into(),
        }),
        summary: None,
    };
    record.thread.manager = Some(SessionManagerInfo::default());
    let expected = record.manager.clone();
    let session = session_from_catalog(vec![record]).unwrap();
    assert_eq!(session.manager, expected);
    assert_eq!(session.threads[0].manager, Some(expected));
}
