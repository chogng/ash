use super::*;
use serde_json::json;
use std::sync::Arc;
use std::sync::Barrier;

#[test]
fn extension_state_reopens_preserves_null_deletes_and_migrates_previous_schema() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.sqlite3");
    let old = Connection::open(&path).unwrap();
    old.execute_batch("CREATE TABLE ash_schema_migrations (component TEXT PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO ash_schema_migrations VALUES ('extension_state',1); CREATE TABLE extension_state (namespace TEXT PRIMARY KEY, revision INTEGER NOT NULL, values_json TEXT NOT NULL); INSERT INTO extension_state VALUES ('first', 9, '{\"kept\":true}');").unwrap();
    drop(old);
    let store = SqliteExtensionStateStore::open(&path).unwrap();
    assert_eq!(store.get("first", "kept").unwrap(), Some(json!(true)));
    store
        .update("first", "nothing", Some(&Value::Null), || true)
        .unwrap();
    assert_eq!(store.get("first", "nothing").unwrap(), Some(Value::Null));
    assert_eq!(store.get("second", "nothing").unwrap(), None);
    store.update("first", "kept", None, || true).unwrap();
    drop(store);
    let reopened = SqliteExtensionStateStore::open(&path).unwrap();
    assert_eq!(reopened.get("first", "nothing").unwrap(), Some(Value::Null));
    assert_eq!(reopened.get("first", "kept").unwrap(), None);
    let other = SqliteExtensionStateStore::open(&root.path().join("other.sqlite3")).unwrap();
    assert_eq!(other.get("first", "nothing").unwrap(), None);
}

#[test]
fn extension_state_concurrent_connections_do_not_overwrite_other_keys() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.sqlite3");
    let first = Arc::new(SqliteExtensionStateStore::open(&path).unwrap());
    let second = Arc::new(SqliteExtensionStateStore::open(&path).unwrap());
    let barrier = Arc::new(Barrier::new(2));
    std::thread::scope(|scope| {
        for (store, key) in [(&first, "one"), (&second, "two")] {
            let barrier = barrier.clone();
            scope.spawn(move || {
                barrier.wait();
                store
                    .update("shared", key, Some(&json!(key)), || true)
                    .unwrap();
            });
        }
    });
    assert_eq!(first.get("shared", "one").unwrap(), Some(json!("one")));
    assert_eq!(second.get("shared", "two").unwrap(), Some(json!("two")));
    second
        .update("shared", "one", Some(&json!("new")), || true)
        .unwrap();
    assert_eq!(first.get("shared", "one").unwrap(), Some(json!("new")));
}

#[test]
fn extension_state_quota_and_retirement_keep_committed_values() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteExtensionStateStore::open(&root.path().join("state.sqlite3")).unwrap();
    store
        .update("extension", "kept", Some(&json!("value")), || true)
        .unwrap();
    let calls = std::cell::Cell::new(0);
    assert!(matches!(
        store.update("extension", "kept", None, || {
            calls.set(calls.get() + 1);
            calls.get() == 1
        }),
        Err(ExtensionStateError::Retired)
    ));
    assert_eq!(
        store.get("extension", "kept").unwrap(),
        Some(json!("value"))
    );
    assert!(matches!(
        store.update(
            "extension",
            "kept",
            Some(&json!("x".repeat(MAX_BYTES))),
            || true
        ),
        Err(ExtensionStateError::QuotaExceeded)
    ));
    assert!(matches!(
        store.update("extension", "bad\0key", None, || true),
        Err(ExtensionStateError::Invalid)
    ));
    assert!(matches!(
        store.update("extension", "kept", None, || false),
        Err(ExtensionStateError::Retired)
    ));
    let accepted = (0..64).fold(Value::Null, |value, _| json!({"value":value}));
    store
        .update("depth", "value", Some(&accepted), || true)
        .unwrap();
    assert!(matches!(
        store.update("depth", "value", Some(&json!({"value":accepted})), || true),
        Err(ExtensionStateError::Invalid)
    ));
    for i in 0..MAX_KEYS {
        store
            .update("keys", &i.to_string(), Some(&json!(i)), || true)
            .unwrap();
    }
    assert!(matches!(
        store.update("keys", "overflow", Some(&Value::Null), || true),
        Err(ExtensionStateError::QuotaExceeded)
    ));
}

#[test]
fn extension_state_rejects_invalid_persisted_values_before_read_or_update() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.sqlite3");
    let store = SqliteExtensionStateStore::open(&path).unwrap();
    let database = Connection::open(&path).unwrap();
    let too_deep = (0..65).fold(Value::Null, |value, _| json!({"value":value}));
    for invalid in [json!({"bad\u{0}key":true}), json!({"value":too_deep})] {
        database.execute("INSERT INTO extension_state VALUES ('extension', ?1) ON CONFLICT(namespace) DO UPDATE SET values_json=excluded.values_json", [invalid.to_string()]).unwrap();
        assert!(matches!(
            store.get("extension", "value"),
            Err(ExtensionStateError::Invalid)
        ));
        assert!(matches!(
            store.update("extension", "new", Some(&Value::Null), || true),
            Err(ExtensionStateError::Invalid)
        ));
    }
}
