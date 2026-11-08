use crate::NotesStore;
use async_utils::CancellationSource;
use protocol::SessionId;
use protocol::ThreadId;
#[test]
fn concurrent_open_adopts_legacy_notes() {
    let directory = tempfile::tempdir().unwrap();
    for legacy in [false, true] {
        let path = directory.path().join(format!("state-{legacy}.sqlite3"));
        let session = SessionId::new("session").unwrap();
        let thread = ThreadId::new("thread").unwrap();
        if legacy {
            NotesStore::open(&path)
                .unwrap()
                .write(
                    &session,
                    &thread,
                    "progress",
                    "verified",
                    0,
                    &CancellationSource::new().token(),
                )
                .unwrap();
            rusqlite::Connection::open(&path)
                .unwrap()
                .execute(
                    "DELETE FROM ash_schema_migrations WHERE component = 'history-notes'",
                    [],
                )
                .unwrap();
        }
        let barrier = std::sync::Barrier::new(4);
        std::thread::scope(|scope| {
            for _ in 0..4 {
                scope.spawn(|| {
                    barrier.wait();
                    let notes = NotesStore::open(&path)
                        .unwrap()
                        .list(&session, &thread)
                        .unwrap();
                    assert_eq!(notes.len(), usize::from(legacy));
                    if let Some(note) = notes.first() {
                        assert_eq!(
                            (note.path.as_str(), note.body.as_str(), note.revision),
                            ("progress", "verified", 1)
                        );
                    }
                });
            }
        });
    }
}

#[test]
fn notes_survive_restart_and_enforce_revision_and_scope() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.sqlite3");
    let session = SessionId::new("session").unwrap();
    let thread = ThreadId::new("thread").unwrap();
    let cancel = CancellationSource::new();
    let first = NotesStore::open(&path).unwrap();
    let second = NotesStore::open(&path).unwrap();
    first
        .write(
            &session,
            &thread,
            "progress/main",
            "verified result",
            0,
            &cancel.token(),
        )
        .unwrap();
    assert!(
        second
            .write(
                &session,
                &thread,
                "progress/main",
                "stale writer",
                0,
                &cancel.token()
            )
            .is_err()
    );
    second
        .write(
            &session,
            &thread,
            "progress/main",
            "updated result",
            1,
            &cancel.token(),
        )
        .unwrap();
    drop(first);
    drop(second);
    let store = NotesStore::open(&path).unwrap();
    let notes = store.list(&session, &thread).unwrap();
    assert_eq!(
        (&notes[0].body, notes[0].revision),
        (&"updated result".to_string(), 2)
    );
    assert!(
        store
            .list(&SessionId::new("other").unwrap(), &thread)
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .list(&session, &ThreadId::new("other").unwrap())
            .unwrap()
            .is_empty()
    );
    store.delete_session(&session).unwrap();
    assert!(store.list(&session, &thread).unwrap().is_empty());
}
#[test]
fn cancelled_or_invalid_writes_preserve_the_previous_note() {
    let store = NotesStore::in_memory().unwrap();
    let session = SessionId::new("s").unwrap();
    let thread = ThreadId::new("t").unwrap();
    let source = CancellationSource::new();
    store
        .write(
            &session,
            &thread,
            "progress",
            "original",
            0,
            &source.token(),
        )
        .unwrap();
    source.cancel();
    assert!(
        store
            .write(
                &session,
                &thread,
                "progress",
                "cancelled",
                1,
                &source.token()
            )
            .is_err()
    );
    let active = CancellationSource::new();
    assert!(
        store
            .write(&session, &thread, "../secret", "bad", 0, &active.token())
            .is_err()
    );
    let notes = store.list(&session, &thread).unwrap();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].body, "original");
}
