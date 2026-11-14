use super::*;
use crate::SqliteThreadStore;
use serde_json::json;

fn completed_turn() -> Turn {
    serde_json::from_value(json!({
        "turnId":"turn", "status":"completed", "items":[
            {"type":"agentMessage", "turnId":"turn", "itemId":"reply", "text":"Immutable completion"}
        ]
    })).unwrap()
}

#[test]
fn completion_delivery_is_transactional_persistent_and_acknowledged_independently() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("state.sqlite");
    let store = SqliteThreadStore::open(&path).unwrap();
    let mut connection = Connection::open(&path).unwrap();
    let session = SessionId::new("session").unwrap();
    let thread = ThreadId::new("thread").unwrap();
    let turn = completed_turn();
    {
        let transaction = connection.transaction().unwrap();
        stage(&transaction, &session, &thread, 10, &turn).unwrap();
        transaction.rollback().unwrap();
    }
    assert!(store.pending_turn_completions(0).unwrap().is_empty());
    {
        let transaction = connection.transaction().unwrap();
        stage(&transaction, &session, &thread, 10, &turn).unwrap();
        stage(&transaction, &session, &thread, 10, &turn).unwrap();
        transaction.commit().unwrap();
    }
    let reopened = SqliteThreadStore::open(&path).unwrap();
    let pending = reopened.pending_turn_completions(0).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].turn, turn);
    assert_eq!(pending[0].session_id, session);
    assert_eq!(pending[0].thread_id, thread);
    reopened.acknowledge_turn_completion(pending[0].id).unwrap();
    store.acknowledge_turn_completion(pending[0].id).unwrap();
    assert!(store.pending_turn_completions(0).unwrap().is_empty());
    let product_tables: u32 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name LIKE 'generated_file%'", [], |row| row.get(0),
    ).unwrap();
    assert_eq!(
        product_tables, 0,
        "Opening Thread storage does not install document business schemas"
    );
}

#[test]
fn completion_pages_advance_past_unacknowledged_work_and_reject_corrupt_payloads() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("state.sqlite");
    let store = SqliteThreadStore::open(&path).unwrap();
    let connection = Connection::open(&path).unwrap();
    for sequence in 1..=70 {
        stage(
            &connection,
            &SessionId::new("session").unwrap(),
            &ThreadId::new("thread").unwrap(),
            sequence,
            &completed_turn(),
        )
        .unwrap();
    }
    let first = store.pending_turn_completions(0).unwrap();
    assert_eq!(first.len(), 64);
    let last = store
        .pending_turn_completions(first.last().unwrap().id)
        .unwrap();
    assert_eq!(last.len(), 6);
    for completion in last {
        store.acknowledge_turn_completion(completion.id).unwrap();
    }
    assert_eq!(store.pending_turn_completions(0).unwrap().len(), 64);
    connection
        .execute(
            "UPDATE pending_thread_completions SET turn_json = '{}' WHERE id = ?1",
            [first[0].id],
        )
        .unwrap();
    assert!(
        store
            .pending_turn_completions(0)
            .unwrap_err()
            .to_string()
            .contains("digest mismatch")
    );
}
