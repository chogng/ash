use super::SqliteThreadStore;
use super::SqliteTurnChangeStore;
use super::TurnChangeCommandOutcome;
use ash_history::CURRENT_STORED_EVENT_SCHEMA_VERSION;
use ash_history::EventId;
use ash_history::StoredEvent;
use ash_history::Timestamp;
use ash_protocol::SessionId;
use ash_protocol::SessionManagerInfo;
use ash_protocol::SessionThread;
use ash_protocol::ThreadEvent;
use ash_protocol::ThreadId;
use ash_protocol::ThreadStatus;
use ash_protocol::TurnId;
use ash_thread_store::ThreadCatalogRecord;
use ash_thread_store::ThreadEventBatch;
use ash_thread_store::ThreadStore;
use ash_thread_store::ThreadStoreError;
use git_turn_changes::ChangeSetId;
use git_turn_changes::MessageState;
use git_turn_changes::TerminalTurnState;
use git_turn_changes::TurnChangeSet;
use git_turn_changes::TurnChangeSetDraft;
use git_turn_changes::TurnChangeStore;
use git_turn_changes::TurnChangeStoreError;
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

fn database_path(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "ash-sqlite-{label}-{}-{}.sqlite3",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn open_change_set(thread_id: ThreadId) -> TurnChangeSet {
    TurnChangeSet::open(TurnChangeSetDraft {
        change_set_id: ChangeSetId::new("changes-1").unwrap(),
        session_id: SessionId::new("session-1").unwrap(),
        thread_id,
        turn_id: TurnId::new("turn-1").unwrap(),
        repository_id: "repository-1".into(),
        worktree_root: std::path::PathBuf::from("/dir/repository-1"),
        target_branch: Some("main".into()),
        base_object_id: Some("head".into()),
        before_tree: "before".into(),
        baseline_dependency_paths: std::collections::BTreeSet::new(),
        message_state: MessageState::Unconfigured,
    })
    .unwrap()
}

fn catalog(session_id: &SessionId, thread_id: &ThreadId, sequence: u64) -> ThreadCatalogRecord {
    ThreadCatalogRecord {
        binding: agent_graph_store::ThreadBinding {
            agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
            session_id: session_id.clone(),
            thread_id: thread_id.clone(),
            origin: Default::default(),
        },
        session_id: session_id.clone(),
        thread: SessionThread {
            thread_id: thread_id.clone(),
            title: "Primary".into(),
            created_at_unix_ms: 1,
            completed_turn_duration_ms: 0,
            active_turn_started_at_unix_ms: None,
            usage: Default::default(),
            parent_thread_id: None,
            forked_from_id: None,
            status: ThreadStatus::Active,
        },
        sequence,
        manager: SessionManagerInfo::default(),
        archived_at_unix_ms: None,
        stopped: false,
        requires_startup_recovery: false,
    }
}

fn append_created_thread(
    store: &SqliteThreadStore,
    session_id: &SessionId,
    thread_id: &ThreadId,
    ordinal: u64,
) {
    store
        .append_batch(&ThreadEventBatch {
            history_prefixes: Vec::new(),
            batch_id: format!("thread-batch-{ordinal}"),
            thread_id: thread_id.clone(),
            expected_sequence: 0,
            events: vec![StoredEvent {
                time_context: None,
                schema_version: CURRENT_STORED_EVENT_SCHEMA_VERSION,
                event_id: EventId(format!("thread-event-{ordinal}")),
                sequence: 1,
                thread_id: thread_id.clone(),
                recorded_at: Timestamp(u128::from(ordinal)),
                command: None,
                event: ThreadEvent::ThreadCreated {
                    agent_id: Some(ash_protocol::AgentId::new("agent-test").unwrap()),
                    origin: Default::default(),
                    agent: None,
                    session_id: session_id.clone(),
                    thread_id: thread_id.clone(),
                    title: "Primary".into(),
                },
            }],
            catalog: catalog(session_id, thread_id, 1),
        })
        .unwrap();
}

#[test]
fn sqlite_turn_changes_compare_and_swap_complete_records() {
    let path = database_path("turn-changes-cas");
    let thread_id = ThreadId::new("thread-1").unwrap();
    let store = SqliteTurnChangeStore::open(&path).unwrap();
    let original = open_change_set(thread_id.clone());
    store.insert(&original).unwrap();

    let mut sealed = original.clone();
    sealed
        .seal(
            "after".into(),
            TerminalTurnState::Completed,
            Vec::new(),
            Default::default(),
        )
        .unwrap();
    store.compare_and_swap(original.revision, &sealed).unwrap();

    assert_eq!(store.load(&sealed.change_set_id).unwrap(), sealed);
    assert_eq!(
        store.list_for_thread(&thread_id).unwrap(),
        vec![sealed.clone()]
    );
    assert_eq!(
        store.compare_and_swap(original.revision, &sealed),
        Err(TurnChangeStoreError::RevisionConflict {
            expected: original.revision,
            actual: sealed.revision,
        })
    );
    fs::remove_file(path).unwrap();
}

#[test]
fn sqlite_turn_change_commands_replay_the_original_response() {
    let path = database_path("turn-changes-command");
    let thread_id = ThreadId::new("thread-1").unwrap();
    let store = SqliteTurnChangeStore::open(&path).unwrap();
    let original = open_change_set(thread_id);
    store.insert(&original).unwrap();

    let mut updated = original.clone();
    updated
        .update_draft("feat: keep the receipt".into())
        .unwrap();
    assert_eq!(
        store
            .apply_command(
                "command-1",
                "fingerprint-1",
                None,
                &[updated.clone()],
                r#"{"revision":2}"#,
            )
            .unwrap(),
        TurnChangeCommandOutcome::Applied
    );

    let mut advanced = updated.clone();
    advanced.update_draft("feat: later edit".into()).unwrap();
    store.compare_and_swap(updated.revision, &advanced).unwrap();
    assert_eq!(
        store.replay_command("command-1", "fingerprint-1").unwrap(),
        Some(r#"{"revision":2}"#.into())
    );
    assert_eq!(
        store
            .apply_command("command-1", "fingerprint-1", None, &[updated], "ignored",)
            .unwrap(),
        TurnChangeCommandOutcome::Replayed(r#"{"revision":2}"#.into())
    );
    assert!(matches!(
        store.replay_command("command-1", "different"),
        Err(TurnChangeStoreError::CommandConflict(_))
    ));
    fs::remove_file(path).unwrap();
}

#[test]
fn sqlite_thread_store_recovers_typed_events() {
    let path = database_path("recovery");
    let session_id = SessionId::new("session_1").unwrap();
    let thread_id = ThreadId::new("thread_1").unwrap();
    let thread_event = StoredEvent {
        time_context: None,
        schema_version: CURRENT_STORED_EVENT_SCHEMA_VERSION,
        event_id: EventId("thread-event-1".into()),
        sequence: 1,
        thread_id: thread_id.clone(),
        recorded_at: Timestamp(2),
        command: None,
        event: ThreadEvent::ThreadCreated {
            agent_id: Some(ash_protocol::AgentId::new("agent-test").unwrap()),
            origin: Default::default(),
            agent: None,
            session_id: session_id.clone(),
            thread_id: thread_id.clone(),
            title: "Primary".into(),
        },
    };

    let expected_catalog = catalog(&session_id, &thread_id, 1);
    SqliteThreadStore::open(&path)
        .unwrap()
        .append_batch(&ThreadEventBatch {
            history_prefixes: Vec::new(),
            batch_id: "thread-batch-1".into(),
            thread_id: thread_id.clone(),
            expected_sequence: 0,
            events: vec![thread_event.clone()],
            catalog: expected_catalog.clone(),
        })
        .unwrap();

    let reopened = SqliteThreadStore::open(&path).unwrap();
    assert_eq!(reopened.load(&thread_id).unwrap(), vec![thread_event]);
    assert_eq!(reopened.list_catalog().unwrap(), vec![expected_catalog]);
    fs::remove_file(path).unwrap();
}

#[test]
fn sqlite_session_catalog_reads_only_the_requested_session() {
    let path = database_path("session-catalog");
    let first_session = SessionId::new("session-first").unwrap();
    let second_session = SessionId::new("session-second").unwrap();
    let first_thread = ThreadId::new("thread-first").unwrap();
    let second_thread = ThreadId::new("thread-second").unwrap();
    let store = SqliteThreadStore::open(&path).unwrap();
    append_created_thread(&store, &first_session, &first_thread, 1);
    append_created_thread(&store, &second_session, &second_thread, 2);
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute(
            "UPDATE thread_catalog SET record_json = 'invalid' WHERE thread_id = ?1",
            [second_thread.as_str()],
        )
        .unwrap();

    assert_eq!(
        store.session_catalog(&first_session).unwrap(),
        vec![catalog(&first_session, &first_thread, 1)]
    );
    assert!(
        store
            .session_catalog(&SessionId::new("missing").unwrap())
            .unwrap()
            .is_empty()
    );
    assert!(matches!(
        store.session_catalog(&second_session),
        Err(ThreadStoreError::Storage(_))
    ));
    drop(store);
    fs::remove_file(path).unwrap();
}

#[test]
fn sqlite_delete_session_removes_all_thread_history_and_change_sets_atomically() {
    let path = database_path("delete-session");
    let deleted_session = SessionId::new("session-delete").unwrap();
    let kept_session = SessionId::new("session-keep").unwrap();
    let first = ThreadId::new("thread-delete-1").unwrap();
    let second = ThreadId::new("thread-delete-2").unwrap();
    let kept = ThreadId::new("thread-keep").unwrap();
    let store = SqliteThreadStore::open(&path).unwrap();
    append_created_thread(&store, &deleted_session, &first, 1);
    append_created_thread(&store, &deleted_session, &second, 2);
    append_created_thread(&store, &kept_session, &kept, 3);
    let change_store = SqliteTurnChangeStore::open(&path).unwrap();
    change_store
        .insert(&open_change_set(first.clone()))
        .unwrap();

    assert_eq!(
        store.delete_session(&deleted_session).unwrap(),
        vec![first.clone(), second.clone()]
    );

    assert!(store.load(&first).unwrap().is_empty());
    assert!(store.load(&second).unwrap().is_empty());
    assert_eq!(store.load(&kept).unwrap().len(), 1);
    assert_eq!(
        store.list_catalog().unwrap(),
        vec![catalog(&kept_session, &kept, 1)]
    );
    assert!(change_store.list_for_thread(&first).unwrap().is_empty());
    drop(change_store);
    drop(store);
    fs::remove_file(path).unwrap();
}

#[test]
fn sqlite_thread_catalog_rejects_index_metadata_mismatch() {
    let path = database_path("catalog-metadata");
    let session_id = SessionId::new("session_1").unwrap();
    let thread_id = ThreadId::new("thread_1").unwrap();
    let store = SqliteThreadStore::open(&path).unwrap();
    store
        .append_batch(&ThreadEventBatch {
            history_prefixes: Vec::new(),
            batch_id: "thread-batch-1".into(),
            thread_id: thread_id.clone(),
            expected_sequence: 0,
            events: vec![StoredEvent {
                time_context: None,
                schema_version: CURRENT_STORED_EVENT_SCHEMA_VERSION,
                event_id: EventId("thread-event-1".into()),
                sequence: 1,
                thread_id: thread_id.clone(),
                recorded_at: Timestamp(2),
                command: None,
                event: ThreadEvent::ThreadCreated {
                    agent_id: Some(ash_protocol::AgentId::new("agent-test").unwrap()),
                    origin: Default::default(),
                    agent: None,
                    session_id: session_id.clone(),
                    thread_id: thread_id.clone(),
                    title: "Primary".into(),
                },
            }],
            catalog: catalog(&session_id, &thread_id, 1),
        })
        .unwrap();
    drop(store);

    rusqlite::Connection::open(&path)
        .unwrap()
        .execute(
            "UPDATE thread_catalog SET session_id = 'wrong-session' WHERE thread_id = ?1",
            [thread_id.as_str()],
        )
        .unwrap();
    assert!(matches!(
        SqliteThreadStore::open(&path).unwrap().list_catalog(),
        Err(ThreadStoreError::Storage(message)) if message.contains("metadata disagrees")
    ));
    fs::remove_file(path).unwrap();
}

#[test]
fn sqlite_thread_append_is_atomic_and_sequence_checked() {
    let path = database_path("sequence");
    let session_id = SessionId::new("session_1").unwrap();
    let thread_id = ThreadId::new("thread_1").unwrap();
    let event = StoredEvent {
        time_context: None,
        schema_version: CURRENT_STORED_EVENT_SCHEMA_VERSION,
        event_id: EventId("event-1".into()),
        sequence: 1,
        thread_id: thread_id.clone(),
        recorded_at: Timestamp(1),
        command: None,
        event: ThreadEvent::ThreadCreated {
            agent_id: Some(ash_protocol::AgentId::new("agent-test").unwrap()),
            origin: Default::default(),
            agent: None,
            session_id: session_id.clone(),
            thread_id: thread_id.clone(),
            title: "Primary".into(),
        },
    };
    let store = SqliteThreadStore::open(&path).unwrap();
    store
        .append_batch(&ThreadEventBatch {
            history_prefixes: Vec::new(),
            batch_id: "batch-1".into(),
            thread_id: thread_id.clone(),
            expected_sequence: 0,
            events: vec![event.clone()],
            catalog: catalog(&session_id, &thread_id, 1),
        })
        .unwrap();
    let stale = store.append_batch(&ThreadEventBatch {
        history_prefixes: Vec::new(),
        batch_id: "batch-2".into(),
        thread_id: thread_id.clone(),
        expected_sequence: 0,
        events: vec![event],
        catalog: catalog(&session_id, &thread_id, 1),
    });

    assert!(matches!(
        stale,
        Err(ThreadStoreError::SequenceConflict {
            expected: 0,
            actual: 1
        })
    ));
    assert_eq!(store.load(&thread_id).unwrap().len(), 1);
    drop(store);
    fs::remove_file(path).unwrap();
}

#[test]
fn sqlite_thread_recovery_rejects_metadata_mismatch_and_accepts_legacy_schema() {
    let path = database_path("legacy-schema");
    let session_id = SessionId::new("session_1").unwrap();
    let thread_id = ThreadId::new("thread_1").unwrap();
    let mut event = StoredEvent {
        time_context: None,
        schema_version: CURRENT_STORED_EVENT_SCHEMA_VERSION,
        event_id: EventId("event-1".into()),
        sequence: 1,
        thread_id: thread_id.clone(),
        recorded_at: Timestamp(1),
        command: None,
        event: ThreadEvent::ThreadCreated {
            agent_id: Some(ash_protocol::AgentId::new("agent-test").unwrap()),
            origin: Default::default(),
            agent: None,
            session_id: session_id.clone(),
            thread_id: thread_id.clone(),
            title: "Primary".into(),
        },
    };
    let store = SqliteThreadStore::open(&path).unwrap();
    store
        .append_batch(&ThreadEventBatch {
            history_prefixes: Vec::new(),
            batch_id: "batch-1".into(),
            thread_id: thread_id.clone(),
            expected_sequence: 0,
            events: vec![event.clone()],
            catalog: catalog(&session_id, &thread_id, 1),
        })
        .unwrap();
    drop(store);

    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute(
            "UPDATE thread_events SET schema_version = ?1 WHERE thread_id = ?2 AND sequence = 1",
            rusqlite::params![
                ash_history::MINIMUM_SUPPORTED_EVENT_SCHEMA_VERSION,
                thread_id.as_str()
            ],
        )
        .unwrap();
    assert!(matches!(
        SqliteThreadStore::open(&path)
            .unwrap()
            .load(&thread_id),
        Err(ThreadStoreError::Storage(message))
            if message.contains("metadata disagrees")
    ));

    event.schema_version = ash_history::MINIMUM_SUPPORTED_EVENT_SCHEMA_VERSION;
    let json = serde_json::to_string(&event).unwrap();
    let digest = ash_protocol::ContentDigest::sha256(json.as_bytes());
    connection
        .execute(
            "INSERT INTO history_records (digest, record_json) VALUES (?1, ?2)",
            rusqlite::params![digest.as_str(), json],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE thread_events SET record_digest = ?1 WHERE thread_id = ?2 AND sequence = 1",
            rusqlite::params![digest.as_str(), thread_id.as_str()],
        )
        .unwrap();

    assert_eq!(
        SqliteThreadStore::open(&path)
            .unwrap()
            .load(&thread_id)
            .unwrap(),
        vec![event.clone()]
    );
    connection
        .execute(
            "UPDATE thread_streams SET current_sequence = 2 WHERE thread_id = ?1",
            [thread_id.as_str()],
        )
        .unwrap();
    assert!(matches!(
        SqliteThreadStore::open(&path)
            .unwrap()
            .load(&thread_id),
        Err(ThreadStoreError::Storage(message))
            if message.contains("durable event tail")
    ));
    drop(connection);
    fs::remove_file(path).unwrap();
}

#[cfg(unix)]
#[test]
fn sqlite_authority_database_is_private_to_the_host_user() {
    use std::os::unix::fs::PermissionsExt;

    let path = database_path("permissions");
    let store = SqliteThreadStore::open(&path).unwrap();

    let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);

    drop(store);
    fs::remove_file(path).unwrap();
}
