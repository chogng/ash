use super::*;
use ash_protocol::VoiceHistoryCoverage;
use ash_protocol::VoiceHistoryFilter;
use ash_protocol::VoiceHistoryQuery;

fn query(session: &SessionId, thread: &ThreadId) -> VoiceHistoryQuery {
    VoiceHistoryQuery {
        session_id: session.clone(),
        thread_id: thread.clone(),
        filter: Default::default(),
        after_sequence: 0,
        snapshot_sequence: None,
        required_sequence: None,
        cursor: None,
        limit: 1,
    }
}
fn record(
    threads: &ThreadController,
    thread: &ThreadId,
    text: &str,
    call: &str,
) -> ash_core::RecordVoiceTranscriptResult {
    threads
        .record_voice_transcript(
            thread,
            ash_core::RecordVoiceTranscriptRequest {
                voice_session_id: call.into(),
                media_epoch: 1,
                speaker: ash_protocol::VoiceTranscriptSpeaker::User,
                text: text.into(),
                start_ms: 0,
                end_ms: 100,
            },
        )
        .unwrap()
}

#[test]
fn voice_history_pins_pages_and_catches_up_after_reopen_without_turns() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("state.sqlite3");
    let store = Arc::new(SqliteThreadStore::open(&path).unwrap());
    let session = SessionId::new("voice").unwrap();
    let thread = ThreadId::new("voice").unwrap();
    append_created_thread(&store, &session, &thread, 1);
    let threads = ThreadController::with_store(store.clone());
    let first = record(&threads, &thread, "first", "call-1");
    let second = record(&threads, &thread, "second", "call-2");
    let request = query(&session, &thread);
    let page = threads.read_voice_history(&request).unwrap();
    assert_eq!(page.coverage, VoiceHistoryCoverage::Ready);
    assert_eq!(page.entries[0].sequence, first.sequence);
    let cursor = page.next_cursor.unwrap();
    let late = record(&threads, &thread, "late", "call-3");
    drop(threads);
    drop(store);
    let store = Arc::new(SqliteThreadStore::open(&path).unwrap());
    let threads = ThreadController::with_store(store.clone());
    let next = threads
        .read_voice_history(&VoiceHistoryQuery {
            cursor: Some(cursor.clone()),
            ..request.clone()
        })
        .unwrap();
    assert_eq!(next.entries.len(), 1);
    assert_eq!(next.entries[0].sequence, second.sequence);
    assert_eq!(next.snapshot_sequence, second.sequence);
    assert_eq!(next.committed_sequence, late.sequence);
    assert!(next.next_cursor.is_none());
    let catchup = threads
        .read_voice_history(&VoiceHistoryQuery {
            after_sequence: next.snapshot_sequence,
            ..request.clone()
        })
        .unwrap();
    assert_eq!(catchup.entries[0].transcript.text, "late");
    assert_eq!(catchup.coverage, VoiceHistoryCoverage::Ready);
    assert!(threads.read_thread(&thread).unwrap().turns.is_empty());
    let changed = VoiceHistoryQuery {
        cursor: Some(cursor),
        filter: VoiceHistoryFilter {
            voice_session_id: Some("call-2".into()),
            ..Default::default()
        },
        ..request.clone()
    };
    assert!(threads.read_voice_history(&changed).is_err());
    assert!(
        threads
            .read_voice_history(&VoiceHistoryQuery {
                limit: 0,
                ..request.clone()
            })
            .is_err()
    );
    assert!(
        threads
            .read_voice_history(&VoiceHistoryQuery {
                limit: 501,
                ..request.clone()
            })
            .is_err()
    );
    let pending = threads
        .read_voice_history(&VoiceHistoryQuery {
            required_sequence: Some(late.sequence + 1),
            ..request.clone()
        })
        .unwrap();
    assert_eq!(pending.coverage, VoiceHistoryCoverage::Pending);
    assert!(pending.entries.is_empty());
    let event_id = catchup.entries[0].event_id.clone();
    let exact = threads
        .read_voice_history(&VoiceHistoryQuery {
            filter: VoiceHistoryFilter {
                event_id: Some(event_id.clone()),
                ..Default::default()
            },
            ..request.clone()
        })
        .unwrap();
    assert_eq!(exact.entries[0].sequence, late.sequence);
    let excluded = threads
        .read_voice_history(&VoiceHistoryQuery {
            filter: VoiceHistoryFilter {
                event_id: Some(event_id),
                voice_session_id: Some("other-call".into()),
                ..Default::default()
            },
            ..request.clone()
        })
        .unwrap();
    assert_eq!(excluded.coverage, VoiceHistoryCoverage::Ready);
    assert!(excluded.entries.is_empty());
    let unknown = threads
        .read_voice_history(&VoiceHistoryQuery {
            filter: VoiceHistoryFilter {
                event_id: Some("unknown".into()),
                ..Default::default()
            },
            ..request
        })
        .unwrap();
    assert_eq!(unknown.coverage, VoiceHistoryCoverage::Pending);
    // Acknowledged records survive shutdown and the index follows the canonical deletion.
    store.delete_session(&session).unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM thread_voice_events", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn voice_index_backfills_existing_records_and_filters_half_open_time_ranges() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("state.sqlite3");
    let store = Arc::new(SqliteThreadStore::open(&path).unwrap());
    let session = SessionId::new("voice").unwrap();
    let thread = ThreadId::new("voice").unwrap();
    append_created_thread(&store, &session, &thread, 1);
    let threads = ThreadController::with_store(store.clone());
    record(&threads, &thread, "hello", "call");
    let before = threads
        .read_voice_history(&query(&session, &thread))
        .unwrap();
    let at = before.entries[0].recorded_at_unix_ms;
    drop(threads);
    drop(store);
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.execute_batch("DROP TRIGGER thread_voice_events_append; DROP TABLE thread_voice_events; DELETE FROM ash_schema_migrations WHERE component = 'thread-voice-index';").unwrap();
    drop(connection);
    let threads = ThreadController::with_store(Arc::new(SqliteThreadStore::open(&path).unwrap()));
    let page = threads
        .read_voice_history(&query(&session, &thread))
        .unwrap();
    assert_eq!(page.entries, before.entries);
    let page = threads
        .read_voice_history(&VoiceHistoryQuery {
            filter: VoiceHistoryFilter {
                from_recorded_at_ms: Some(at),
                to_recorded_at_ms: Some(at + 1),
                ..Default::default()
            },
            ..query(&session, &thread)
        })
        .unwrap();
    assert_eq!(page.entries.len(), 1);
    let page = threads
        .read_voice_history(&VoiceHistoryQuery {
            filter: VoiceHistoryFilter {
                to_recorded_at_ms: Some(at),
                ..Default::default()
            },
            ..query(&session, &thread)
        })
        .unwrap();
    assert!(page.entries.is_empty());
}

#[test]
fn saved_session_id_queries_use_only_indexed_rows_and_preserve_catalog_order() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("state.sqlite3");
    let store = SqliteThreadStore::open(&path).unwrap();
    for (ordinal, id) in ["a", "b", "c"].into_iter().enumerate() {
        append_created_thread(
            &store,
            &SessionId::new(id).unwrap(),
            &ThreadId::new(id).unwrap(),
            ordinal as u64 + 1,
        );
    }
    let ids = ["c", "a", "c", "missing"].map(|id| SessionId::new(id).unwrap());
    assert_eq!(
        store
            .list_sessions_by_ids(&ids)
            .unwrap()
            .into_iter()
            .map(|session| session.session_id.to_string())
            .collect::<Vec<_>>(),
        ["a", "c"]
    );
    assert!(store.list_sessions_by_ids(&[]).unwrap().is_empty());
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute("DELETE FROM session_catalog WHERE session_id = 'a'", [])
        .unwrap();
    assert_eq!(store.list_sessions_by_ids(&ids).unwrap().len(), 1);
    assert_eq!(
        connection
            .query_row(
                "SELECT count(*) FROM session_catalog WHERE session_id = 'a'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    let plan: String = connection
        .query_row(
            "EXPLAIN QUERY PLAN SELECT * FROM session_catalog WHERE session_id IN ('a', 'c')",
            [],
            |row| row.get(3),
        )
        .unwrap();
    assert!(
        plan.contains("SEARCH") && plan.contains("session_id=?"),
        "{plan}"
    );
}

#[test]
fn fork_voice_history_excludes_inherited_parent_observations() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(SqliteThreadStore::open(directory.path().join("state.sqlite3")).unwrap());
    let session = SessionId::new("root").unwrap();
    let root = ThreadId::new("root").unwrap();
    append_created_thread(&store, &session, &root, 1);
    let threads = ThreadController::with_store(store);
    let parent = record(&threads, &root, "parent observation", "parent-call");
    let child = ThreadId::new("child").unwrap();
    let snapshot = threads
        .create_forked_thread(ash_core::CreateForkedThreadRequest {
            session_id: session.clone(),
            thread_id: child.clone(),
            title: "child".into(),
            source_thread_id: root.clone(),
            source_sequence: parent.sequence,
        })
        .unwrap();
    assert_eq!(
        snapshot.voice_transcripts.len(),
        1,
        "the transcript retains inherited context"
    );
    assert!(
        threads
            .read_voice_history(&query(&session, &child))
            .unwrap()
            .entries
            .is_empty()
    );
    record(&threads, &child, "child observation", "child-call");
    let page = threads
        .read_voice_history(&query(&session, &child))
        .unwrap();
    assert_eq!(page.entries.len(), 1);
    assert_eq!(page.entries[0].transcript.text, "child observation");
    assert_eq!(
        threads
            .read_voice_history(&query(&session, &root))
            .unwrap()
            .entries[0]
            .transcript
            .text,
        "parent observation"
    );
}
