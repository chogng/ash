use super::*;
use ash_core::CreateThreadRequest;
use ash_protocol::{SessionId, ThreadId};
use ash_rollout::LocalStateRepository;
use ash_state::StateRuntime;
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

fn temporary_root() -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "ash-rollout-trace-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

#[test]
fn trace_groups_thread_streams_by_session_id() {
    let root = temporary_root();
    let state = StateRuntime::open(&root).unwrap();
    let repository = LocalStateRepository::open(&state).unwrap();
    let session_id = SessionId::new("session_1").expect("test ID is non-empty");
    let thread_id = ThreadId::new("thread_1").expect("test ID is non-empty");
    let thread_store = repository.thread_store();
    repository
        .recover_threads()
        .unwrap()
        .create_thread(CreateThreadRequest {
            agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
            origin: Default::default(),
            agent: None,
            session_id: session_id.clone(),
            thread_id: thread_id.clone(),
            title: "Primary branch".into(),
        })
        .unwrap();

    let trace = capture_session_trace(thread_store.as_ref(), &session_id).unwrap();

    assert_eq!(trace.format_version, ROLLOUT_TRACE_FORMAT_VERSION);
    assert_eq!(trace.threads[0].events[0].sequence, 1);
    assert_eq!(trace.threads[0].thread_id, thread_id);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn trace_contains_the_complete_nested_history_prefix_closure() {
    let root = temporary_root();
    let state = StateRuntime::open(&root).unwrap();
    let repository = LocalStateRepository::open(&state).unwrap();
    let threads = repository.recover_threads().unwrap();
    let first = threads
        .start_thread(
            &ash_core::NoThreadWorktreeBinder,
            core_api::StartThreadRequest {
                branch_name: None,
                agent_id: None,
                agent: None,
                command_id: ash_protocol::CommandId::new("root").unwrap(),
                title: "root".into(),
            },
        )
        .unwrap();
    let mut source = first.thread_id.clone();
    for id in ["first-fork", "second-fork"] {
        source = threads
            .fork_thread(
                &ash_core::NoThreadWorktreeBinder,
                core_api::ForkThreadRequest {
                    command_id: ash_protocol::CommandId::new(id).unwrap(),
                    source_thread_id: source,
                    title: id.into(),
                },
            )
            .unwrap()
            .thread_id;
    }
    let trace =
        capture_session_trace(repository.thread_store().as_ref(), &first.session_id).unwrap();
    assert_eq!(trace.history_prefixes.len(), 2);
    let retained = trace
        .history_prefixes
        .iter()
        .map(|prefix| prefix.reference().unwrap().digest.as_str().to_string())
        .collect::<std::collections::BTreeSet<_>>();
    for event in trace
        .threads
        .iter()
        .flat_map(|thread| &thread.events)
        .chain(
            trace
                .history_prefixes
                .iter()
                .flat_map(|prefix| &prefix.events),
        )
    {
        if let ash_protocol::ThreadEvent::HistoryPrefixBound { prefix, .. } = &event.event {
            assert!(retained.contains(prefix.digest.as_str()));
        }
    }
    fs::remove_dir_all(root).unwrap();
}
