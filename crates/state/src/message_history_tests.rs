use super::SqliteMessageHistory;
use message_history::MAX_PAGE_BYTES;
use message_history::MessageHistoryKind as InputKind;
use message_history::MessageHistoryQuery as Query;
use message_history::MessageHistoryRetention as Retention;
use message_history::MessageHistoryStore;
use message_history::MessageHistorySubmission as Submission;
use std::sync::Arc;
use std::sync::Barrier;

fn input(text: &str) -> Submission {
    Submission {
        text: text.into(),
        kind: InputKind::Agent,
        thread_id: Some("remote-thread".into()),
    }
}

#[test]
fn reopening_a_profile_recalls_inputs_across_threads_and_searches_literal_unicode() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.sqlite3");
    let store = SqliteMessageHistory::open(&path, Retention::default()).unwrap();
    let first = store.append(input("Ältere 提问_%")).unwrap();
    let second = store
        .append(Submission {
            thread_id: Some("another-thread".into()),
            ..input("new input")
        })
        .unwrap();
    drop(store);
    let store = SqliteMessageHistory::open(&path, Retention::default()).unwrap();
    assert_eq!(
        store.read(&Query::default()).unwrap().entries,
        [second, first.clone()]
    );
    assert_eq!(
        store
            .read(&Query {
                text: "äLTERE 提问_%".into(),
                ..Query::default()
            })
            .unwrap()
            .entries,
        [first]
    );
    assert!(
        store
            .read(&Query {
                text: "%_".into(),
                ..Query::default()
            })
            .unwrap()
            .entries
            .is_empty()
    );
}

#[test]
fn pagination_survives_other_writers_trimming_and_clearing_without_reusing_ids() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.sqlite3");
    let retention = Retention {
        max_entries: 3,
        ..Retention::default()
    };
    let store = SqliteMessageHistory::open(&path, retention).unwrap();
    for text in ["first", "second", "third"] {
        store.append(input(text)).unwrap();
    }
    let page = store
        .read(&Query {
            limit: 1,
            ..Query::default()
        })
        .unwrap();
    let other = SqliteMessageHistory::open(&path, retention).unwrap();
    let newest = other.append(input("fourth")).unwrap();
    let older = store
        .read(&Query {
            before: page.next_before,
            ..Query::default()
        })
        .unwrap();
    assert_eq!(
        older
            .entries
            .iter()
            .map(|entry| entry.submission.text.as_str())
            .collect::<Vec<_>>(),
        ["second"]
    );
    other.clear().unwrap();
    let after_clear = other.append(input("after clear")).unwrap();
    assert!(after_clear.id > newest.id);
    assert!(
        store
            .read(&Query {
                before: page.next_before,
                ..Query::default()
            })
            .unwrap()
            .entries
            .is_empty()
    );
}

#[test]
fn pages_bound_bytes_and_large_entries_still_advance() {
    let root = tempfile::tempdir().unwrap();
    let store =
        SqliteMessageHistory::open(&root.path().join("state.sqlite3"), Retention::default())
            .unwrap();
    let oldest = store.append(input("oldest")).unwrap();
    let large = store
        .append(input(&"x".repeat(MAX_PAGE_BYTES + 1)))
        .unwrap();
    let newest = store.append(input("newest")).unwrap();
    let page = store.read(&Query::default()).unwrap();
    assert_eq!(page.entries, [newest]);
    let page = store
        .read(&Query {
            before: page.next_before,
            ..Query::default()
        })
        .unwrap();
    assert_eq!(page.entries, [large]);
    let page = store
        .read(&Query {
            before: page.next_before,
            ..Query::default()
        })
        .unwrap();
    assert_eq!(page.entries, [oldest]);
    assert_eq!(page.next_before, None);
}

#[test]
fn retention_is_atomic_and_keeps_an_oversized_newest_entry() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteMessageHistory::open(
        &root.path().join("state.sqlite3"),
        Retention {
            max_entries: 10,
            max_bytes: 5,
        },
    )
    .unwrap();
    for text in ["one", "two", "larger than the limit"] {
        store.append(input(text)).unwrap();
    }
    assert_eq!(store.read(&Query::default()).unwrap().entries.len(), 1);
    store.append(input("new")).unwrap();
    assert_eq!(
        store.read(&Query::default()).unwrap().entries[0]
            .submission
            .text,
        "new"
    );
}

#[test]
fn independent_connections_append_concurrently_without_losing_inputs() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.sqlite3");
    let barrier = Arc::new(Barrier::new(3));
    let workers = (0..3)
        .map(|worker| {
            let path = path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let store = SqliteMessageHistory::open(&path, Retention::default()).unwrap();
                barrier.wait();
                for index in 0..10 {
                    store.append(input(&format!("{worker}/{index}"))).unwrap();
                }
            })
        })
        .collect::<Vec<_>>();
    for worker in workers {
        worker.join().unwrap();
    }
    let store = SqliteMessageHistory::open(&path, Retention::default()).unwrap();
    let entries = store.read(&Query::default()).unwrap().entries;
    assert_eq!(entries.len(), 30);
    assert!(entries.windows(2).all(|pair| pair[0].id > pair[1].id));
}

#[test]
fn clear_does_not_touch_conversation_storage_and_profiles_are_isolated() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.sqlite3");
    let store = SqliteMessageHistory::open(&path, Retention::default()).unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.execute_batch("CREATE TABLE conversation_test(value TEXT); INSERT INTO conversation_test VALUES ('keep');").unwrap();
    store.append(input("private input")).unwrap();
    let other = SqliteMessageHistory::open(
        &root.path().join("other/state.sqlite3"),
        Retention::default(),
    )
    .unwrap();
    assert!(other.read(&Query::default()).unwrap().entries.is_empty());
    store.clear().unwrap();
    assert_eq!(
        connection
            .query_row("SELECT value FROM conversation_test", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "keep"
    );
    assert!(store.append(input(" ")).is_err());
    assert!(
        store
            .read(&Query {
                limit: 0,
                ..Query::default()
            })
            .is_err()
    );
}
