use super::SqliteThreadStore;
use super::SqliteTurnChangeStore;
use super::TurnChangeCommandOutcome;
use ash_core::CreateThreadRequest;
use ash_core::RequestTurnInteraction;
use ash_core::StartTurnRequest;
use ash_core::ThreadController;
use ash_history::CURRENT_STORED_EVENT_SCHEMA_VERSION;
use ash_history::EventId;
use ash_history::StoredEvent;
use ash_history::Timestamp;
use ash_protocol::ModelId;
use ash_protocol::ModelRef;
use ash_protocol::ProviderId;
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
use ash_thread_store::session_from_catalog;
use git_turn_changes::ChangeSetId;
use git_turn_changes::MessageState;
use git_turn_changes::TerminalTurnState;
use git_turn_changes::TurnChangeSet;
use git_turn_changes::TurnChangeSetDraft;
use git_turn_changes::TurnChangeStore;
use git_turn_changes::TurnChangeStoreError;
use git_turn_changes::TurnCommitStore;
use std::collections::BTreeMap;
use std::fs;
use std::sync::Arc;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

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

#[test]
fn manual_pull_requests_survive_reopen_and_follow_session_deletion() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("state.sqlite3");
    let session = SessionId::new("session").unwrap();
    let root = ThreadId::new("session").unwrap();
    let other_session = SessionId::new("other").unwrap();
    let other = ThreadId::new("other").unwrap();
    let repository =
        github::Repository::new("GitHub.com".into(), "TEAM".into(), "Repo".into()).unwrap();
    let normalized =
        github::Repository::new("github.com".into(), "team".into(), "repo".into()).unwrap();
    {
        let store = SqliteThreadStore::open(&path).unwrap();
        append_created_thread(&store, &session, &root, 1);
        append_created_thread(&store, &other_session, &other, 2);
        assert!(store.attach_pull_request(&root, &repository, 7).unwrap());
        assert!(!store.attach_pull_request(&root, &normalized, 7).unwrap());
        store.attach_pull_request(&other, &normalized, 8).unwrap();
        assert!(store.attach_pull_request(&root, &repository, 0).is_err());
    }
    let store = SqliteThreadStore::open(&path).unwrap();
    assert_eq!(
        store.list_pull_requests(&root).unwrap(),
        vec![(normalized.clone(), 7)]
    );
    assert!(store.detach_pull_request(&root, &repository, 7).unwrap());
    assert!(!store.detach_pull_request(&root, &repository, 7).unwrap());
    store.attach_pull_request(&root, &repository, 9).unwrap();
    store.delete_session(&session).unwrap();
    assert!(store.list_pull_requests(&root).unwrap().is_empty());
    assert_eq!(
        store.list_pull_requests(&other).unwrap(),
        vec![(normalized, 8)]
    );
}

fn open_change_set(thread_id: ThreadId) -> TurnChangeSet {
    TurnChangeSet::open(TurnChangeSetDraft {
        change_set_id: ChangeSetId::new("changes-1").unwrap(),
        session_id: SessionId::new("session-1").unwrap(),
        thread_id,
        turn_id: TurnId::new("turn-1").unwrap(),
        repository_id: "repository-1".into(),
        worktree_root: std::path::PathBuf::from("/dir/repository-1"),
        git_common_dir: std::path::PathBuf::from("/dir/repository-1/.git"),
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
        model: None,
        execution_target: None,
        binding: agent_graph_store::ThreadBinding {
            agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
            session_id: session_id.clone(),
            thread_id: thread_id.clone(),
            origin: Default::default(),
        },
        session_id: session_id.clone(),
        thread: SessionThread {
            manager: None,
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

#[test]
fn legacy_catalog_target_is_read_without_rewriting_the_record() {
    let session_id = SessionId::new("session_1").unwrap();
    let thread_id = ThreadId::new("thread_1").unwrap();
    let mut expected = catalog(&session_id, &thread_id, 1);
    expected.execution_target = Some(ash_protocol::SessionExecutionTarget::Local {
        root: "/repo".into(),
    });
    let mut legacy = serde_json::to_value(&expected).unwrap();
    let fields = legacy.as_object_mut().unwrap();
    let target = fields.remove("execution_target").unwrap();
    fields.insert("workspace".into(), target);
    let restored: ThreadCatalogRecord = serde_json::from_value(legacy).unwrap();
    assert_eq!(restored, expected);
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
                    execution_target: None,
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

fn append_recent_activity(
    store: &SqliteThreadStore,
    label: &str,
    root: &str,
    time: u64,
    count: usize,
) {
    append_recent_activity_with_padding(store, label, root, time, count, 0);
}

fn append_recent_activity_with_padding(
    store: &SqliteThreadStore,
    label: &str,
    root: &str,
    time: u64,
    count: usize,
    argument_bytes: usize,
) {
    let session = SessionId::new(label).unwrap();
    let thread = ThreadId::new(label).unwrap();
    let turn = TurnId::new(format!("turn-{label}")).unwrap();
    let target = ash_protocol::SessionExecutionTarget::Local { root: root.into() };
    let mut events = vec![ThreadEvent::ThreadCreated {
        execution_target: Some(target.clone()),
        agent_id: Some(ash_protocol::AgentId::new("agent-test").unwrap()),
        origin: Default::default(),
        agent: None,
        session_id: session.clone(),
        thread_id: thread.clone(),
        title: label.into(),
    }];
    for index in 0..count {
        events.push(ThreadEvent::ItemCompleted {
            checkpoint_after_sequence: None, workspace_checkpoint: None, thread_id: thread.clone(), turn_id: turn.clone(),
            item: ash_protocol::ThreadItem::ToolCall {
                item_id: ash_protocol::ItemId::new(format!("item-{label}-{index}")).unwrap(), turn_id: turn.clone(),
                tool_call_id: ash_protocol::ToolCallId::new(format!("call-{label}-{index}")).unwrap(),
                name: ash_protocol::ToolName::new("shell-command").unwrap(), binding: None,
                arguments_json: serde_json::json!({"program":"curl", "arguments":[format!("https://{label}.example.com"), "x".repeat(argument_bytes)], "working_directory":root}).to_string(),
            },
        });
        if label != "pending" {
            events.push(ThreadEvent::ItemCompleted {
                checkpoint_after_sequence: None,
                workspace_checkpoint: None,
                thread_id: thread.clone(),
                turn_id: turn.clone(),
                item: ash_protocol::ThreadItem::ToolResult {
                    item_id: ash_protocol::ItemId::new(format!("result-{label}-{index}")).unwrap(),
                    turn_id: turn.clone(),
                    tool_call_id: ash_protocol::ToolCallId::new(format!("call-{label}-{index}"))
                        .unwrap(),
                    text: "Private output must not become background".into(),
                    content: None,
                    is_error: label == "denied",
                },
            });
        }
    }
    events.push(ThreadEvent::ItemCompleted {
        checkpoint_after_sequence: None,
        workspace_checkpoint: None,
        thread_id: thread.clone(),
        turn_id: turn.clone(),
        item: ash_protocol::ThreadItem::UserMessage {
            client_id: None,
            item_id: ash_protocol::ItemId::new(format!("message-{label}")).unwrap(),
            turn_id: turn,
            text: "A private user message must never appear in command observations".into(),
        },
    });
    let mut record = catalog(&session, &thread, events.len() as u64);
    record.execution_target = Some(target);
    store
        .append_batch(&ThreadEventBatch {
            history_prefixes: Vec::new(),
            batch_id: format!("activity-{label}"),
            thread_id: thread.clone(),
            expected_sequence: 0,
            catalog: record,
            events: events
                .into_iter()
                .enumerate()
                .map(|(index, event)| StoredEvent {
                    time_context: None,
                    schema_version: CURRENT_STORED_EVENT_SCHEMA_VERSION,
                    event_id: EventId(format!("event-{label}-{index}")),
                    sequence: index as u64 + 1,
                    thread_id: thread.clone(),
                    recorded_at: Timestamp(u128::from(time)),
                    command: None,
                    event,
                })
                .collect(),
        })
        .unwrap();
}

#[test]
fn recent_tool_calls_apply_the_byte_budget_after_interleaving_sessions() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteThreadStore::open(root.path().join("activity.sqlite")).unwrap();
    append_recent_activity_with_padding(&store, "busy", "/project", 90, 500, 30_000);
    append_recent_activity(&store, "quiet", "/project", 50, 1);
    let history = store
        .recent_tool_calls(&ash_thread_store::RecentToolCallsQuery {
            root: "/project".into(),
            since_unix_ms: 0,
            until_unix_ms: 100,
            sessions: 50,
            commands_per_session: 2000,
        })
        .unwrap();
    assert_eq!(history.sessions_available, 2);
    assert_eq!(history.commands_available, 501);
    assert!(history.calls.len() < 501);
    assert_eq!(history.calls[0].session_id.as_str(), "busy");
    assert_eq!(history.calls[1].session_id.as_str(), "quiet");
    let total = history
        .calls
        .iter()
        .map(|call| call.arguments_json.len())
        .sum::<usize>();
    assert!(total <= ash_thread_store::MAX_RECENT_ARGUMENT_TOTAL_BYTES);
    assert!(total > ash_thread_store::MAX_RECENT_ARGUMENT_TOTAL_BYTES - 31_000);
}

#[test]
fn recent_tool_calls_are_scoped_bounded_and_removed_with_their_sessions() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("activity.sqlite");
    let store = SqliteThreadStore::open(&path).unwrap();
    append_recent_activity(&store, "older", "/project", 49, 1);
    append_recent_activity(&store, "first", "/project", 50, 2);
    append_recent_activity(&store, "second", "/project", 60, 1);
    append_recent_activity(&store, "future", "/project", 101, 1);
    append_recent_activity(&store, "other", "/project-neighbor", 99, 100);
    append_recent_activity(&store, "remote", "/project", 98, 1);
    append_recent_activity(&store, "pending", "/project", 98, 1);
    append_recent_activity(&store, "denied", "/project", 98, 1);
    rusqlite::Connection::open(&path).unwrap().execute("INSERT INTO history_imports (source, digest, host, thread_count) VALUES ('import', 'fixture', 'remote.example.com', 1)", []).unwrap();
    rusqlite::Connection::open(&path).unwrap().execute("INSERT INTO remote_history_bindings (thread_id, source, host, root) VALUES ('remote', 'import', 'remote.example.com', '/project')", []).unwrap();
    let query = ash_thread_store::RecentToolCallsQuery {
        root: "/project".into(),
        since_unix_ms: 50,
        until_unix_ms: 100,
        sessions: 50,
        commands_per_session: 200,
    };
    let history = store.recent_tool_calls(&query).unwrap();
    assert_eq!(
        (history.sessions_available, history.commands_available),
        (2, 3)
    );
    let calls = &history.calls;
    assert_eq!(
        calls
            .iter()
            .map(|call| (
                call.session_id.as_str(),
                call.sequence,
                call.recorded_at_unix_ms
            ))
            .collect::<Vec<_>>(),
        [("second", 2, 60), ("first", 4, 50), ("first", 2, 50)]
    );
    assert!(
        calls
            .iter()
            .all(|call| call.name == "shell-command"
                && !call.arguments_json.contains("private user"))
    );
    drop(store);
    let reopened = SqliteThreadStore::open(&path).unwrap();
    assert_eq!(reopened.recent_tool_calls(&query).unwrap(), history);
    reopened
        .delete_session(&SessionId::new("second").unwrap())
        .unwrap();
    assert_eq!(
        reopened.recent_tool_calls(&query).unwrap().calls,
        calls[1..]
    );
    for index in 0..10 {
        append_recent_activity(
            &reopened,
            &format!("recent-{index}"),
            "/project",
            70 + index,
            1,
        );
    }
    let sessions = reopened.recent_tool_calls(&query).unwrap();
    assert_eq!(sessions.sessions_available, 11);
    assert_eq!(sessions.calls.len(), 12);
    let narrow = ash_thread_store::RecentToolCallsQuery {
        sessions: 2,
        ..query.clone()
    };
    let selected = reopened.recent_tool_calls(&narrow).unwrap();
    assert_eq!(
        selected
            .calls
            .iter()
            .map(|call| call.session_id.as_str())
            .collect::<Vec<_>>(),
        ["recent-9", "recent-8"]
    );
    append_recent_activity(&reopened, "bulk", "/project", 90, 100);
    let fair = ash_thread_store::RecentToolCallsQuery {
        commands_per_session: 3,
        ..query.clone()
    };
    let bounded = reopened.recent_tool_calls(&fair).unwrap();
    assert_eq!(
        (bounded.sessions_available, bounded.commands_available),
        (12, 112)
    );
    assert_eq!(bounded.calls.len(), 15);
    assert_eq!(
        bounded
            .calls
            .iter()
            .filter(|call| call.session_id.as_str() == "bulk")
            .count(),
        3
    );
    assert!(
        bounded
            .calls
            .iter()
            .any(|call| call.session_id.as_str() == "first")
    );
    // Selecting by recency supports quiet projects too; an age filter is an explicit choice.
    assert!(
        reopened
            .recent_tool_calls(&ash_thread_store::RecentToolCallsQuery {
                since_unix_ms: 0,
                ..query.clone()
            })
            .unwrap()
            .calls
            .iter()
            .any(|call| call.session_id.as_str() == "older")
    );
    for index in 0..55 {
        append_recent_activity(
            &reopened,
            &format!("expanded-{index}"),
            "/project",
            200 + index,
            1,
        );
    }
    let wider = ash_thread_store::RecentToolCallsQuery {
        until_unix_ms: 1000,
        ..query
    };
    let default = reopened.recent_tool_calls(&wider).unwrap();
    assert_eq!(default.calls.len(), 50);
    assert!(
        default
            .calls
            .iter()
            .all(|call| call.session_id.as_str().starts_with("expanded-"))
    );
    let expanded = reopened
        .recent_tool_calls(&ash_thread_store::RecentToolCallsQuery {
            sessions: 100,
            ..wider
        })
        .unwrap();
    assert!(
        expanded
            .calls
            .iter()
            .any(|call| call.session_id.as_str() == "first")
    );
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
    drop(store);
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
    drop(store);
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
            execution_target: None,
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
    drop(reopened);
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
    assert_eq!(
        store
            .read_session(&first_session)
            .unwrap()
            .unwrap()
            .session_id,
        first_session
    );
    assert!(
        store
            .read_session(&SessionId::new("missing").unwrap())
            .unwrap()
            .is_none()
    );
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute(
            "UPDATE thread_catalog SET record_json = 'invalid' WHERE thread_id = ?1",
            [second_thread.as_str()],
        )
        .unwrap();
    assert_eq!(
        store
            .read_session(&second_session)
            .unwrap()
            .unwrap()
            .session_id,
        second_session
    );

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
        Err(ThreadStoreError::CatalogDamaged(thread_id)) if thread_id == second_thread
    ));
    drop(store);
    fs::remove_file(path).unwrap();
}

#[test]
fn sqlite_session_list_reads_one_verified_row_per_session() {
    let path = database_path("session-list");
    let session_id = SessionId::new("session-list").unwrap();
    let thread_id = ThreadId::new("thread-list").unwrap();
    let store = SqliteThreadStore::open(&path).unwrap();
    append_created_thread(&store, &session_id, &thread_id, 1);
    let expected = store.list_sessions().unwrap();
    assert_eq!(expected.len(), 1);
    assert_eq!(expected[0].threads[0].thread_id, thread_id);

    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute(
            "UPDATE thread_catalog SET record_json = 'invalid' WHERE thread_id = ?1",
            [thread_id.as_str()],
        )
        .unwrap();
    assert_eq!(store.list_sessions().unwrap(), expected);
    connection
        .execute(
            "UPDATE session_catalog SET record_json = 'invalid' WHERE session_id = ?1",
            [session_id.as_str()],
        )
        .unwrap();
    assert!(matches!(
        store.list_sessions(),
        Err(ThreadStoreError::SessionCatalogDamaged(damaged)) if damaged == session_id
    ));
    store
        .backfill_catalog(&catalog(&session_id, &thread_id, 1))
        .unwrap();
    assert_eq!(store.list_sessions().unwrap(), expected);
    drop(connection);
    drop(store);
    fs::remove_file(path).unwrap();
}

#[test]
fn sqlite_session_list_migrates_existing_thread_catalog() {
    let path = database_path("session-list-migration");
    let session_id = SessionId::new("session-migration").unwrap();
    let thread_id = ThreadId::new("thread-migration").unwrap();
    let store = SqliteThreadStore::open(&path).unwrap();
    append_created_thread(&store, &session_id, &thread_id, 1);
    let expected = store.list_sessions().unwrap();
    drop(store);
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "DROP TABLE turn_commits;
             DROP TABLE session_catalog;
             UPDATE ash_schema_migrations SET version = 8 WHERE component = 'event-store';",
        )
        .unwrap();
    drop(connection);

    let reopened = SqliteThreadStore::open(&path).unwrap();
    assert_eq!(reopened.list_sessions().unwrap(), expected);
    drop(reopened);
    fs::remove_file(path).unwrap();
}

#[test]
fn sqlite_session_list_tracks_thread_archive_in_the_event_transaction() {
    let path = database_path("session-list-archive");
    let session_id = SessionId::new("session-archive").unwrap();
    let thread_id = ThreadId::new("thread-archive").unwrap();
    let store = SqliteThreadStore::open(&path).unwrap();
    append_created_thread(&store, &session_id, &thread_id, 1);
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE session_write_count (count INTEGER NOT NULL);
             INSERT INTO session_write_count VALUES (0);
             CREATE TRIGGER count_session_writes AFTER UPDATE ON session_catalog
             BEGIN UPDATE session_write_count SET count = count + 1; END;",
        )
        .unwrap();
    store
        .append_batch(&ThreadEventBatch {
            history_prefixes: Vec::new(),
            batch_id: "advisor-batch".into(),
            thread_id: thread_id.clone(),
            expected_sequence: 1,
            events: vec![StoredEvent {
                time_context: None,
                schema_version: CURRENT_STORED_EVENT_SCHEMA_VERSION,
                event_id: EventId("advisor-event".into()),
                sequence: 2,
                thread_id: thread_id.clone(),
                recorded_at: Timestamp(2),
                command: None,
                event: ThreadEvent::AdvisorConfigured {
                    thread_id: thread_id.clone(),
                    selection: Default::default(),
                },
            }],
            catalog: catalog(&session_id, &thread_id, 2),
        })
        .unwrap();
    assert_eq!(
        connection
            .query_row("SELECT count FROM session_write_count", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );

    let mut archived = catalog(&session_id, &thread_id, 3);
    archived.thread.status = ThreadStatus::Archived;
    archived.archived_at_unix_ms = Some(2);
    store
        .append_batch(&ThreadEventBatch {
            history_prefixes: Vec::new(),
            batch_id: "archive-batch".into(),
            thread_id: thread_id.clone(),
            expected_sequence: 2,
            events: vec![StoredEvent {
                time_context: None,
                schema_version: CURRENT_STORED_EVENT_SCHEMA_VERSION,
                event_id: EventId("archive-event".into()),
                sequence: 3,
                thread_id: thread_id.clone(),
                recorded_at: Timestamp(2),
                command: None,
                event: ThreadEvent::ThreadArchived {
                    thread_id,
                    reason: Default::default(),
                },
            }],
            catalog: archived,
        })
        .unwrap();

    assert_eq!(
        store.list_sessions().unwrap()[0].status,
        ash_protocol::SessionStatus::Archived
    );
    assert_eq!(
        connection
            .query_row("SELECT count FROM session_write_count", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    drop(connection);
    drop(store);
    fs::remove_file(path).unwrap();
}

#[test]
fn sqlite_session_cache_migration_retains_outer_branch_management_without_history_replay() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("branch-management.sqlite3");
    let session_id = SessionId::new("branch-management").unwrap();
    let thread_id = ThreadId::new(session_id.as_str()).unwrap();
    let store = SqliteThreadStore::open(&path).unwrap();
    append_created_thread(&store, &session_id, &thread_id, 1);
    let mut record = catalog(&session_id, &thread_id, 1);
    record.manager = SessionManagerInfo {
        status: ash_protocol::SessionManagerStatus::NeedsInput,
        status_changed_at_unix_ms: 23,
        activity: Some(ash_protocol::SessionManagerActivity::Question {
            text: "Choose a path".into(),
        }),
        summary: None,
    };
    store.backfill_catalog(&record).unwrap();
    let mut cached =
        serde_json::to_value(store.read_session(&session_id).unwrap().unwrap()).unwrap();
    cached["threads"][0]
        .as_object_mut()
        .unwrap()
        .remove("manager");
    let cached = serde_json::to_string(&cached).unwrap();
    drop(store);
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute(
            "UPDATE session_catalog SET record_json = ?1, record_version = 2, record_digest = ?2",
            rusqlite::params![
                cached,
                ash_protocol::ContentDigest::sha256(cached.as_bytes()).as_str()
            ],
        )
        .unwrap();
    connection.execute_batch("DELETE FROM thread_events; UPDATE ash_schema_migrations SET version = 12 WHERE component = 'event-store';").unwrap();
    let before: (String, i64, String) = connection
        .query_row(
            "SELECT record_json, record_version, record_digest FROM thread_catalog",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    drop(connection);

    let reopened = SqliteThreadStore::open(&path).unwrap();
    assert!(
        matches!(reopened.load(&thread_id), Err(ThreadStoreError::Storage(message)) if message.contains("durable event tail"))
    );
    let restored = reopened.read_session(&session_id).unwrap().unwrap();
    let wire = serde_json::to_value(&restored).unwrap();
    assert_eq!(
        wire["threads"][0]["manager"],
        serde_json::to_value(&record.manager).unwrap()
    );
    assert_eq!(restored.manager, record.manager);
    let connection = rusqlite::Connection::open(&path).unwrap();
    let after = connection
        .query_row(
            "SELECT record_json, record_version, record_digest FROM thread_catalog",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(after, before);
    assert_eq!(
        connection
            .query_row("SELECT record_version FROM session_catalog", [], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
        3
    );
}

#[test]
fn sqlite_session_catalog_tracks_model_only_updates() {
    assert_session_catalog_fact_updates(
        Some(ModelRef::new(
            ProviderId::new("test").unwrap(),
            ModelId::new("selected-model").unwrap(),
        )),
        None,
    );
}

#[test]
fn sqlite_session_catalog_tracks_target_only_updates() {
    assert_session_catalog_fact_updates(
        None,
        Some(ash_protocol::SessionExecutionTarget::Local {
            root: std::env::temp_dir().join("catalog-project"),
        }),
    );
}

fn assert_session_catalog_fact_updates(
    model: Option<ModelRef>,
    execution_target: Option<ash_protocol::SessionExecutionTarget>,
) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("catalog-facts.sqlite3");
    let session_id = SessionId::new("catalog-facts").unwrap();
    let thread_id = ThreadId::new(session_id.as_str()).unwrap();
    let store = SqliteThreadStore::open(&path).unwrap();
    append_created_thread(&store, &session_id, &thread_id, 1);
    // The store accepts the caller's complete catalog, independently from event reduction.
    // Isolate exported facts that can change without changing Thread display metadata.
    for (index, (model, execution_target)) in [(model, execution_target), (None, None)]
        .into_iter()
        .enumerate()
    {
        let sequence = index as u64 + 2;
        let mut record = catalog(&session_id, &thread_id, sequence);
        record.model = model;
        record.execution_target = execution_target;
        store
            .append_batch(&ThreadEventBatch {
                history_prefixes: Vec::new(),
                batch_id: format!("catalog-facts-{sequence}"),
                thread_id: thread_id.clone(),
                expected_sequence: sequence - 1,
                events: vec![StoredEvent {
                    time_context: None,
                    schema_version: CURRENT_STORED_EVENT_SCHEMA_VERSION,
                    event_id: EventId(format!("catalog-facts-{sequence}")),
                    sequence,
                    thread_id: thread_id.clone(),
                    recorded_at: Timestamp(u128::from(sequence)),
                    command: None,
                    event: ThreadEvent::AdvisorConfigured {
                        thread_id: thread_id.clone(),
                        selection: Default::default(),
                    },
                }],
                catalog: record.clone(),
            })
            .unwrap();
        let expected = session_from_catalog(vec![record.clone()]).unwrap();
        assert_eq!(store.session_catalog(&session_id).unwrap(), vec![record]);
        assert_eq!(
            store.read_session(&session_id).unwrap(),
            Some(expected.clone())
        );
        assert_eq!(store.list_sessions().unwrap(), vec![expected.clone()]);
        let reopened = SqliteThreadStore::open(&path).unwrap();
        assert_eq!(
            reopened.read_session(&session_id).unwrap(),
            Some(expected.clone())
        );
        assert_eq!(reopened.list_sessions().unwrap(), vec![expected]);
    }
    let expected = store.list_sessions().unwrap();
    drop(store);
    let reopened = SqliteThreadStore::open(&path).unwrap();
    assert_eq!(reopened.list_sessions().unwrap(), expected);
}

fn start_catalog_model_turn(
    threads: &ThreadController,
    thread_id: &ThreadId,
    command: &str,
    model: ModelRef,
) -> TurnId {
    threads
        .start_turn(
            thread_id,
            StartTurnRequest {
                context_policy: Default::default(),
                mode: Default::default(),
                advisor: None,
                command_id: ash_protocol::CommandId::new(command).unwrap(),
                expected_sequence: core_api::SequenceExpectation::Any,
                model: Some(model),
                reasoning_effort: None,
                kind: Default::default(),
                instructions: ash_protocol::TurnInstructions::new(
                    "test",
                    "catalog-model",
                    "1",
                    "Test catalog model persistence",
                )
                .unwrap(),
                policy_revision: "catalog-policy".into(),
                approval_mode: ash_protocol::ApprovalMode::Manual,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![ash_protocol::UserInput::Text {
                    text: "Continue the task".into(),
                }],
            },
        )
        .unwrap()
        .turn_id
}

#[test]
fn sqlite_session_catalog_follows_waiting_turn_model_migration_and_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("catalog-model-migration.sqlite3");
    let session_id = SessionId::new("catalog-model-migration").unwrap();
    let thread_id = ThreadId::new(session_id.as_str()).unwrap();
    let store = Arc::new(SqliteThreadStore::open(&path).unwrap());
    let threads = ThreadController::with_store(store.clone());
    threads
        .create_thread(CreateThreadRequest {
            execution_target: None,
            agent_id: ash_protocol::AgentId::new("catalog-model-agent").unwrap(),
            origin: Default::default(),
            agent: None,
            session_id: session_id.clone(),
            thread_id: thread_id.clone(),
            title: "Model migration".into(),
        })
        .unwrap();
    let old = ModelRef::new(
        ProviderId::new("legacy-provider").unwrap(),
        ModelId::new("selected-model").unwrap(),
    );
    let new = ModelRef::new(
        ProviderId::new("current-provider").unwrap(),
        old.model.clone(),
    );
    let completed = start_catalog_model_turn(&threads, &thread_id, "completed", old.clone());
    threads
        .complete_turn(&thread_id, &completed, "Historical answer".into())
        .unwrap();
    let waiting = start_catalog_model_turn(&threads, &thread_id, "waiting", old.clone());
    threads
        .request_turn_interaction(
            &thread_id,
            &waiting,
            RequestTurnInteraction {
                request_id: ash_protocol::RequestId::new("catalog-question").unwrap(),
                item_id: None,
                request: ash_protocol::AgentRequest::UserInput {
                    request: ash_protocol::RequestUserInput {
                        questions: vec![ash_protocol::UserInputQuestion {
                            id: "continue".into(),
                            header: "Continue".into(),
                            question: "Continue the task?".into(),
                            options: Vec::new(),
                            allow_free_form: true,
                        }],
                    },
                },
                deadline: None,
            },
        )
        .unwrap();
    let before = threads.read_thread(&thread_id).unwrap();
    let before_catalog = store.session_catalog(&session_id).unwrap();
    assert_eq!(
        before.turns[1].status,
        ash_protocol::TurnStatus::WaitingForUserInput
    );
    assert_eq!(store.list_sessions().unwrap()[0].model, Some(old.clone()));
    drop(threads);
    drop(store);
    let store = Arc::new(SqliteThreadStore::open(&path).unwrap());
    let threads = ThreadController::with_store(store.clone());
    assert_eq!(threads.recover_thread(&thread_id).unwrap(), before);
    let mapping = [(old.provider, new.provider.clone())].into_iter().collect();
    threads.migrate_model_providers(&mapping).unwrap();
    let after = threads.read_thread(&thread_id).unwrap();
    let after_catalog = store.session_catalog(&session_id).unwrap();
    assert_eq!(after_catalog[0].thread, before_catalog[0].thread);
    assert_eq!(after_catalog[0].manager, before_catalog[0].manager);
    assert_eq!(after.sequence, before.sequence + 1);
    assert_eq!(after.turns[0], before.turns[0]);
    assert_eq!(after.items, before.items);
    assert_eq!(
        after.turns[1].pending_interaction,
        before.turns[1].pending_interaction
    );
    assert_eq!(after.turns[1].status, before.turns[1].status);
    assert_eq!(after.turns[1].model, Some(new.clone()));
    let expected = session_from_catalog(after_catalog).unwrap();
    assert_eq!(expected.model, Some(new.clone()));
    assert_eq!(
        store.read_session(&session_id).unwrap(),
        Some(expected.clone())
    );
    assert_eq!(store.list_sessions().unwrap(), vec![expected.clone()]);
    threads.migrate_model_providers(&mapping).unwrap();
    assert_eq!(
        threads.read_thread(&thread_id).unwrap().sequence,
        after.sequence
    );
    drop(threads);
    drop(store);
    let reopened = Arc::new(SqliteThreadStore::open(&path).unwrap());
    let recovered = ThreadController::with_store(reopened.clone());
    assert_eq!(recovered.read_thread(&thread_id).unwrap(), after);
    assert_eq!(
        recovered.read_session_catalog(&session_id).unwrap(),
        Some(expected.clone())
    );
    assert_eq!(reopened.list_sessions().unwrap(), vec![expected]);
}

#[test]
#[ignore = "manual warm-list performance comparison"]
fn benchmark_session_list_against_thread_catalog_assembly() {
    for threads_per_session in [1, 5] {
        let path = database_path("session-list-benchmark");
        let store = SqliteThreadStore::open(&path).unwrap();
        let mut ordinal = 1;
        for index in 0..300 {
            let session_id = SessionId::new(format!("session-{index}")).unwrap();
            for branch in 0..threads_per_session {
                let thread_id = ThreadId::new(format!("thread-{index}-{branch}")).unwrap();
                append_created_thread(&store, &session_id, &thread_id, ordinal);
                ordinal += 1;
            }
        }
        let old = || {
            let mut grouped = BTreeMap::<SessionId, Vec<ThreadCatalogRecord>>::new();
            for record in store.list_catalog().unwrap() {
                grouped
                    .entry(record.session_id.clone())
                    .or_default()
                    .push(record);
            }
            grouped
                .into_values()
                .map(session_from_catalog)
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(old(), store.list_sessions().unwrap());
        let mut old_ns = 0;
        let mut new_ns = 0;
        for _ in 0..10 {
            let start = Instant::now();
            std::hint::black_box(old());
            old_ns += start.elapsed().as_nanos();
            let start = Instant::now();
            std::hint::black_box(store.list_sessions().unwrap());
            new_ns += start.elapsed().as_nanos();
        }
        eprintln!(
            "300 sessions x {threads_per_session} threads: old {:.3} ms, new {:.3} ms per warm list",
            old_ns as f64 / 10_000_000.0,
            new_ns as f64 / 10_000_000.0
        );
        drop(store);
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "DROP TABLE turn_commits;
             DROP TABLE session_catalog;
                 UPDATE ash_schema_migrations SET version = 8 WHERE component = 'event-store';",
            )
            .unwrap();
        drop(connection);
        let start = Instant::now();
        let migrated = SqliteThreadStore::open(&path).unwrap();
        eprintln!(
            "300 sessions x {threads_per_session} threads: one-time migration {:.3} ms",
            start.elapsed().as_secs_f64() * 1000.0
        );
        assert_eq!(migrated.list_sessions().unwrap().len(), 300);
        drop(migrated);
        fs::remove_file(path).unwrap();
    }
}

#[test]
fn sqlite_catalog_startup_queries_read_only_missing_and_resumable_threads() {
    let path = database_path("catalog-startup");
    let session_id = SessionId::new("session-startup").unwrap();
    let healthy = ThreadId::new("thread-healthy").unwrap();
    let missing = ThreadId::new("thread-missing").unwrap();
    let resumable = ThreadId::new("thread-resumable").unwrap();
    let store = SqliteThreadStore::open(&path).unwrap();
    append_created_thread(&store, &session_id, &healthy, 1);
    append_created_thread(&store, &session_id, &missing, 2);
    append_created_thread(&store, &session_id, &resumable, 3);
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute(
            "DELETE FROM thread_catalog WHERE thread_id = ?1",
            [missing.as_str()],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE thread_catalog SET requires_startup_recovery = 1 WHERE thread_id = ?1",
            [resumable.as_str()],
        )
        .unwrap();

    assert_eq!(store.missing_catalog_thread_ids().unwrap(), vec![missing]);
    assert_eq!(
        store.startup_recovery_thread_ids().unwrap(),
        vec![resumable]
    );
    drop(connection);
    drop(store);
    fs::remove_file(path).unwrap();
}

#[test]
fn sqlite_thread_store_opens_current_catalog_while_another_connection_writes() {
    let path = database_path("catalog-open-read");
    let store = SqliteThreadStore::open(&path).unwrap();
    let writer = rusqlite::Connection::open(&path).unwrap();
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();

    let reader = SqliteThreadStore::open(&path).unwrap();
    assert!(reader.list_catalog().unwrap().is_empty());

    writer.execute_batch("ROLLBACK").unwrap();
    drop(reader);
    drop(writer);
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
    let capture = open_change_set(first.clone());
    change_store.insert(&capture).unwrap();
    let commit = git_turn_changes::TurnCommitRecord {
        commit_id: "deletion-preview".into(),
        session_id: deleted_session.clone(),
        thread_id: first.clone(),
        repository_id: capture.repository_id.clone(),
        target_branch: "main".into(),
        sources: Vec::new(),
        message: "preview retained with source records".into(),
        warnings: Vec::new(),
        publication: git_turn_changes::TurnPublication::MigratedDelta {
            before_tree: "before".into(),
            after_tree: "after".into(),
        },
        state: git_turn_changes::TurnCommitState::Preview,
        revision: 1,
    };
    change_store
        .save_preview(&commit, "deletion-preview", "preview", "{}")
        .unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    let mut pending = commit.clone();
    pending.state = git_turn_changes::TurnCommitState::Publishing;
    connection
        .execute(
            "UPDATE turn_commits SET record_json = ?1 WHERE commit_id = ?2",
            rusqlite::params![serde_json::to_string(&pending).unwrap(), pending.commit_id],
        )
        .unwrap();
    assert!(store.delete_session(&deleted_session).is_err());
    assert!(!store.load(&first).unwrap().is_empty());
    assert!(change_store.load(&capture.change_set_id).is_ok());
    connection
        .execute(
            "UPDATE turn_commits SET record_json = ?1 WHERE commit_id = ?2",
            rusqlite::params![serde_json::to_string(&commit).unwrap(), commit.commit_id],
        )
        .unwrap();
    drop(connection);

    assert_eq!(
        store.delete_session(&deleted_session).unwrap(),
        vec![first.clone(), second.clone()]
    );

    assert!(store.load(&first).unwrap().is_empty());
    assert!(store.load(&second).unwrap().is_empty());
    assert_eq!(store.load(&kept).unwrap().len(), 1);
    assert_eq!(store.list_sessions().unwrap().len(), 1);
    assert_eq!(store.list_sessions().unwrap()[0].session_id, kept_session);
    assert_eq!(
        store.list_catalog().unwrap(),
        vec![catalog(&kept_session, &kept, 1)]
    );
    assert!(change_store.list_for_thread(&first).unwrap().is_empty());
    assert!(change_store.list_commits(&first).unwrap().is_empty());
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
                    execution_target: None,
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
        Err(ThreadStoreError::CatalogDamaged(damaged)) if damaged == thread_id
    ));
    fs::remove_file(path).unwrap();
}

#[test]
fn sqlite_thread_catalog_rejects_changed_record_content() {
    let path = database_path("catalog-digest");
    let session_id = SessionId::new("session-digest").unwrap();
    let thread_id = ThreadId::new("thread-digest").unwrap();
    let store = SqliteThreadStore::open(&path).unwrap();
    append_created_thread(&store, &session_id, &thread_id, 1);
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute(
            "UPDATE thread_catalog SET record_json = REPLACE(record_json, 'Primary', 'Altered')
             WHERE thread_id = ?1",
            [thread_id.as_str()],
        )
        .unwrap();

    assert!(matches!(
        store.session_catalog(&session_id),
        Err(ThreadStoreError::CatalogDamaged(damaged)) if damaged == thread_id
    ));
    drop(store);
    fs::remove_file(path).unwrap();
}

#[test]
fn sqlite_thread_catalog_migrates_old_rows_and_marks_invalid_rows_for_rebuild() {
    let path = database_path("catalog-migration");
    let session_id = SessionId::new("session-migration").unwrap();
    let healthy = ThreadId::new("thread-healthy").unwrap();
    let invalid = ThreadId::new("thread-invalid").unwrap();
    let store = SqliteThreadStore::open(&path).unwrap();
    append_created_thread(&store, &session_id, &healthy, 1);
    append_created_thread(&store, &session_id, &invalid, 2);
    drop(store);
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "PRAGMA foreign_keys = OFF;
             BEGIN;
             CREATE TABLE old_catalog (
                 thread_id TEXT PRIMARY KEY,
                 session_id TEXT NOT NULL,
                 requires_startup_recovery INTEGER NOT NULL,
                 record_json TEXT NOT NULL,
                 FOREIGN KEY (thread_id) REFERENCES thread_streams(thread_id)
             );
             INSERT INTO old_catalog
             SELECT thread_id, session_id, requires_startup_recovery, record_json FROM thread_catalog;
             DROP TABLE thread_catalog;
             ALTER TABLE old_catalog RENAME TO thread_catalog;
             UPDATE thread_catalog SET record_json = 'invalid' WHERE thread_id = 'thread-invalid';
             DROP TABLE turn_commits;
             UPDATE ash_schema_migrations SET version = 7 WHERE component = 'event-store';
             COMMIT;",
        )
        .unwrap();
    drop(connection);

    let reopened = SqliteThreadStore::open(&path).unwrap();
    // Migrated rows predate the authoritative model field, even when their JSON is valid.
    assert_eq!(
        reopened.missing_catalog_thread_ids().unwrap(),
        vec![healthy.clone(), invalid.clone()]
    );
    reopened
        .backfill_catalog(&catalog(&session_id, &healthy, 1))
        .unwrap();
    assert_eq!(
        reopened.missing_catalog_thread_ids().unwrap(),
        vec![invalid.clone()]
    );
    reopened
        .backfill_catalog(&catalog(&session_id, &invalid, 1))
        .unwrap();
    assert_eq!(
        reopened.session_catalog(&session_id).unwrap(),
        vec![
            catalog(&session_id, &healthy, 1),
            catalog(&session_id, &invalid, 1)
        ]
    );
    drop(reopened);
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
            execution_target: None,
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
            execution_target: None,
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

#[test]
fn sqlite_catalog_model_upgrade_requires_history_rebuild_and_preserves_root_model() {
    let path = database_path("catalog-model-upgrade");
    let session_id = SessionId::new("model-root").unwrap();
    let thread_id = ThreadId::new(session_id.as_str()).unwrap();
    let store = SqliteThreadStore::open(&path).unwrap();
    append_created_thread(&store, &session_id, &thread_id, 1);
    let mut record = catalog(&session_id, &thread_id, 1);
    record.model = Some(ash_protocol::ModelRef::new(
        ash_protocol::ProviderId::new("test").unwrap(),
        ash_protocol::ModelId::new("root-model").unwrap(),
    ));
    store.backfill_catalog(&record).unwrap();
    assert_eq!(store.list_sessions().unwrap()[0].model, record.model);
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute("UPDATE thread_catalog SET record_version = 1", [])
        .unwrap();
    connection
        .execute("UPDATE session_catalog SET record_version = 1", [])
        .unwrap();
    assert!(matches!(
        store.list_sessions(),
        Err(ThreadStoreError::SessionCatalogDamaged(_))
    ));
    assert!(matches!(
        store.session_catalog(&session_id),
        Err(ThreadStoreError::CatalogDamaged(_))
    ));
    store.backfill_catalog(&record).unwrap();
    drop(store);
    let reopened = SqliteThreadStore::open(&path).unwrap();
    assert_eq!(reopened.list_sessions().unwrap()[0].model, record.model);
    drop(reopened);
    drop(connection);
    fs::remove_file(path).unwrap();
}

#[test]
fn event_ranges_read_only_the_requested_committed_index_and_reject_gaps() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("range.sqlite");
    let store = SqliteThreadStore::open(&path).unwrap();
    append_recent_activity(&store, "range", "/project", 1, 4);
    let thread = ThreadId::new("range").unwrap();
    let expected = store.load(&thread).unwrap();
    let page = store.load_range(&thread, 2, 3).unwrap();
    assert_eq!(page.current_sequence, expected.len() as u64);
    assert_eq!(page.events, expected[2..5]);
    assert!(
        store
            .load_range(&thread, expected.len() as u64 + 1, 1)
            .is_err()
    );
    assert!(store.load_range(&thread, 0, 0).is_err());
    assert!(store.load_range(&thread, 0, 501).is_err());
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute(
            "DELETE FROM thread_events WHERE thread_id = 'range' AND sequence = 1",
            [],
        )
        .unwrap();
    // An unrelated earlier damaged record must not be read again for a later page.
    assert_eq!(
        store.load_range(&thread, 2, 3).unwrap().events,
        expected[2..5]
    );
    assert!(store.load_range(&thread, 0, 2).is_err());
    connection
        .execute(
            "DELETE FROM thread_events WHERE thread_id = 'range' AND sequence = 4",
            [],
        )
        .unwrap();
    assert!(store.load_range(&thread, 2, 3).is_err());
}
