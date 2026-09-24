//! Session runtime operation tests.

use std::sync::Arc;
use std::sync::Mutex;

use ash_app_server_protocol::protocol::session::SessionSubscribeResult;
use ash_app_server_protocol::protocol::session::SessionThreadProjection;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptSnapshot;
use ash_protocol::Session;
use ash_protocol::SessionId;
use ash_protocol::SessionStatus;
use ash_protocol::SessionThread;
use ash_protocol::Thread;
use ash_protocol::ThreadId;
use ash_protocol::ThreadStatus;

use super::cwd_title;
use super::publish_subscription;
use super::selected_conversation_thread;
use crate::SessionRuntimeEvent;
use crate::SessionRuntimeEventSink;

#[test]
fn subscription_publishes_the_authoritative_thread_snapshot() {
    let session_id = SessionId::new("session-1").unwrap();
    let thread_id = ThreadId::new("thread-1").unwrap();
    let subscription = SessionSubscribeResult {
        session: Session {
            session_id: session_id.clone(),
            title: "Project".to_owned(),
            status: SessionStatus::Active,
            manager: Default::default(),
            threads: vec![SessionThread {
                thread_id: thread_id.clone(),
                title: "Agent".to_owned(),
                created_at_unix_ms: 0,
                completed_turn_duration_ms: 0,
                active_turn_started_at_unix_ms: None,
                usage: Default::default(),
                parent_thread_id: None,
                forked_from_id: None,
                status: ThreadStatus::Active,
            }],
        },
        thread_projections: vec![SessionThreadProjection {
            thread: Thread {
                advisor: Default::default(),
                agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
                origin: Default::default(),
                session_id: session_id.clone(),
                thread_id: thread_id.clone(),
                parent_thread_id: None,
                forked_from_id: None,
                title: "Agent".to_owned(),
                status: ThreadStatus::Active,
                sequence: 7,
                usage: Default::default(),
                reference_cost: Default::default(),
                goal: None,
                turns: Vec::new(),
            },
            transcript: ThreadTranscriptSnapshot {
                session_id: session_id.clone(),
                thread_id: thread_id.clone(),
                durable_sequence: 7,
                revision: 1,
                entries: Vec::new(),
            },
            updates: Vec::new(),
        }],
        agent_tree: Default::default(),
    };
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink_events = Arc::clone(&events);
    let sink: SessionRuntimeEventSink = Arc::new(move |event| {
        sink_events.lock().unwrap().push(event);
        Ok(())
    });

    publish_subscription(&sink, &subscription, &thread_id).unwrap();

    let events = events.lock().unwrap();
    assert!(matches!(
        events.as_slice(),
        [SessionRuntimeEvent::Snapshot {
            session,
            thread,
            transcript,
        }] if session.session_id == session_id
            && thread.thread_id == thread_id
            && thread.sequence == 7
            && transcript.thread_id == thread_id
    ));
}

#[test]
fn cwd_title_uses_the_last_component_and_root_fallback() {
    assert_eq!(cwd_title(std::path::Path::new("/work/ash")), "ash");
    assert_eq!(cwd_title(std::path::Path::new("/")), "Session");
}

#[test]
fn root_thread_wins_over_a_later_conversation_thread() {
    let root_id = ThreadId::new("thread-root").unwrap();
    let rewound_id = ThreadId::new("thread-rewound").unwrap();
    let session = Session {
        session_id: SessionId::new("session-1").unwrap(),
        title: "Project".to_owned(),
        status: SessionStatus::Active,
        manager: Default::default(),
        threads: vec![
            SessionThread {
                thread_id: root_id.clone(),
                title: "Root".to_owned(),
                created_at_unix_ms: 0,
                completed_turn_duration_ms: 0,
                active_turn_started_at_unix_ms: None,
                usage: Default::default(),
                parent_thread_id: None,
                forked_from_id: None,
                status: ThreadStatus::Active,
            },
            SessionThread {
                thread_id: rewound_id.clone(),
                title: "Rewound".to_owned(),
                created_at_unix_ms: 0,
                completed_turn_duration_ms: 0,
                active_turn_started_at_unix_ms: None,
                usage: Default::default(),
                parent_thread_id: Some(root_id.clone()),
                forked_from_id: Some(root_id.clone()),
                status: ThreadStatus::Active,
            },
        ],
    };

    assert_eq!(
        selected_conversation_thread(&session).unwrap().thread_id,
        root_id
    );
}
