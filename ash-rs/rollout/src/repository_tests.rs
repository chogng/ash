use super::*;
use ash_core::CreateThreadRequest;
use ash_protocol::{SessionId, ThreadId};
use ash_state::StateRuntime;
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

fn temporary_root() -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "ash-rollout-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

#[test]
fn repository_keeps_idle_history_lazy_and_loads_it_on_access() {
    let root = temporary_root();
    let state = StateRuntime::open(&root).unwrap();
    let repository = LocalStateRepository::open(&state).unwrap();
    let threads = repository.recover_threads().unwrap();
    let session_id = SessionId::new("session-1").expect("test ID is non-empty");
    let thread_id = ThreadId::new("thread-1").expect("test ID is non-empty");
    let created = threads
        .create_thread(CreateThreadRequest {
            agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
            origin: Default::default(),
            agent: None,
            session_id: session_id.clone(),
            thread_id: thread_id.clone(),
            title: "Primary branch".into(),
        })
        .unwrap();

    let recovered = LocalStateRepository::open(&state)
        .unwrap()
        .recover_threads()
        .unwrap();
    assert!(recovered.list_loaded_threads().unwrap().is_empty());
    assert_eq!(recovered.list_thread_catalog().unwrap().len(), 1);

    let restored = recovered.read_thread(&thread_id).unwrap();

    assert_eq!(restored.session_id, session_id);
    assert_eq!(restored.thread_id, thread_id);
    assert_eq!(restored.title, "Primary branch");
    assert_eq!(restored.sequence, created.sequence);
    assert_eq!(recovered.list_loaded_threads().unwrap().len(), 1);
    drop(recovered);
    drop(threads);
    drop(repository);
    drop(state);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn repository_rebuilds_an_outdated_catalog_row_from_thread_history() {
    let root = temporary_root();
    let state = StateRuntime::open(&root).unwrap();
    let repository = LocalStateRepository::open(&state).unwrap();
    let threads = repository.recover_threads().unwrap();
    let session_id = SessionId::new("session-rebuild").unwrap();
    let thread_id = ThreadId::new("thread-rebuild").unwrap();
    threads
        .create_thread(CreateThreadRequest {
            agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
            origin: Default::default(),
            agent: None,
            session_id: session_id.clone(),
            thread_id: thread_id.clone(),
            title: "Recovered title".into(),
        })
        .unwrap();
    drop(threads);
    drop(repository);
    ash_state::open_sqlite_database(state.database_path(), ash_state::SqliteDurability::Durable)
        .unwrap()
        .execute(
            "UPDATE thread_catalog SET record_version = 0, record_json = 'invalid'
             WHERE thread_id = ?1",
            [thread_id.as_str()],
        )
        .unwrap();

    let recovered = LocalStateRepository::open(&state)
        .unwrap()
        .recover_threads()
        .unwrap();
    let catalog = recovered.session_thread_catalog(&session_id).unwrap();
    assert_eq!(catalog.len(), 1);
    assert_eq!(catalog[0].thread.title, "Recovered title");
    ash_state::open_sqlite_database(state.database_path(), ash_state::SqliteDurability::Durable)
        .unwrap()
        .execute(
            "UPDATE thread_catalog SET record_json = 'invalid' WHERE thread_id = ?1",
            [thread_id.as_str()],
        )
        .unwrap();
    let repaired = recovered.list_thread_catalog().unwrap();
    assert_eq!(repaired.len(), 1);
    assert_eq!(repaired[0].thread.title, "Recovered title");
    drop(recovered);
    drop(state);
    fs::remove_dir_all(root).unwrap();
}
