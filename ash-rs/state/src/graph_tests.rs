use crate::SqliteThreadStore;
use agent_graph_store::AgentGraphStore;
use ash_core::CreateThreadRequest;
use ash_core::NoThreadWorktreeBinder;
use ash_core::ThreadController;
use ash_protocol::AgentId;
use ash_protocol::CommandId;
use ash_protocol::ThreadId;
use ash_protocol::ThreadOrigin;
use ash_thread_store::ThreadStore;
use core_api::ForkThreadRequest;
use core_api::ReplaceThreadRequest;
use core_api::StartThreadRequest;
use std::sync::Arc;

fn start(
    threads: &ThreadController,
    command: &str,
    agent_id: Option<AgentId>,
) -> ash_core::ThreadSnapshot {
    threads
        .start_thread(
            &NoThreadWorktreeBinder,
            StartThreadRequest {
                branch_name: None,
                agent_id,
                agent: None,
                command_id: CommandId::new(command).unwrap(),
                title: command.into(),
            },
        )
        .unwrap()
}

#[test]
fn one_agent_retains_independent_branches_and_tasks_after_restart_and_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.sqlite");
    let store = Arc::new(SqliteThreadStore::open(&path).unwrap());
    let threads = ThreadController::with_store(store.clone());
    let root = start(&threads, "first", None);
    let other_task = start(&threads, "second", Some(root.agent_id.clone()));
    let fork = threads
        .fork_thread(
            &NoThreadWorktreeBinder,
            ForkThreadRequest {
                command_id: CommandId::new("fork").unwrap(),
                source_thread_id: root.thread_id.clone(),
                title: "fork".into(),
            },
        )
        .unwrap();
    assert_ne!(root.session_id, other_task.session_id);
    assert_eq!(root.agent_id, fork.agent_id);
    assert!(
        store
            .list_spawn_descendants(&root.thread_id)
            .unwrap()
            .is_empty()
    );
    threads.archive_thread(&root.thread_id).unwrap();
    let replacement = threads
        .replace_thread(
            &NoThreadWorktreeBinder,
            ReplaceThreadRequest {
                command_id: CommandId::new("replacement").unwrap(),
                source_thread_id: root.thread_id.clone(),
                title: "replacement".into(),
            },
        )
        .unwrap();
    assert_eq!(replacement.agent_id, root.agent_id);
    assert!(replacement.turns.is_empty());
    assert!(matches!(
        replacement.origin,
        ThreadOrigin::Replacement { .. }
    ));
    let expected = store.list_agent_threads(&root.agent_id).unwrap();
    assert_eq!(expected.len(), 4);
    drop(threads);
    drop(store);
    let store = Arc::new(SqliteThreadStore::open(&path).unwrap());
    let recovered = ThreadController::with_store(store.clone());
    assert_eq!(store.list_agent_threads(&root.agent_id).unwrap(), expected);
    assert_eq!(
        recovered.read_thread(&replacement.thread_id).unwrap(),
        replacement
    );
    assert_eq!(
        recovered
            .list_session_threads(&other_task.session_id)
            .unwrap()
            .len(),
        1
    );
    store.delete_session(&root.session_id).unwrap();
    assert_eq!(store.list_agent_threads(&root.agent_id).unwrap().len(), 1);
    store.delete_session(&other_task.session_id).unwrap();
    assert!(store.list_agent_threads(&root.agent_id).unwrap().is_empty());
    assert!(store.read_agent(&root.agent_id).unwrap().is_some());
    let next = start(&recovered, "third", Some(root.agent_id.clone()));
    assert_eq!(next.agent_id, root.agent_id);
}

#[test]
fn invalid_binding_rolls_back_thread_events_catalog_and_agent_creation() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(SqliteThreadStore::open(dir.path().join("state.sqlite")).unwrap());
    let threads = ThreadController::with_store(store.clone());
    let root = start(&threads, "root", None);
    let wrong_agent = AgentId::new("wrong-agent").unwrap();
    let child = ThreadId::new("invalid-child").unwrap();
    let result = threads.create_thread(CreateThreadRequest {
        agent_id: wrong_agent.clone(),
        origin: ThreadOrigin::Fork {
            parent_thread_id: root.thread_id.clone(),
            parent_sequence: root.sequence,
        },
        agent: None,
        session_id: root.session_id.clone(),
        thread_id: child.clone(),
        title: "invalid".into(),
    });
    assert!(result.is_err());
    assert!(store.load(&child).unwrap().is_empty());
    assert!(store.read_thread_binding(&child).unwrap().is_none());
    assert!(store.read_agent(&wrong_agent).unwrap().is_none());
    assert_eq!(store.list_thread_ids().unwrap(), vec![root.thread_id]);
}

#[test]
fn session_queries_do_not_replay_unrelated_corrupt_history() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.sqlite");
    let store = Arc::new(SqliteThreadStore::open(&path).unwrap());
    let threads = ThreadController::with_store(store.clone());
    let wanted = start(&threads, "wanted", None);
    let unrelated = start(&threads, "unrelated", None);
    drop(threads);
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute(
            "UPDATE history_records SET record_json = 'invalid' WHERE digest IN (SELECT record_digest FROM thread_events WHERE thread_id = ?1)",
            [unrelated.thread_id.as_str()],
        )
        .unwrap();
    let recovered = ThreadController::with_store(store);
    assert_eq!(
        recovered.list_session_threads(&wanted.session_id).unwrap(),
        vec![wanted]
    );
    assert!(recovered.read_thread(&unrelated.thread_id).is_err());
}

#[test]
fn concurrent_replacements_commit_only_one_successor() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.sqlite");
    let store = Arc::new(SqliteThreadStore::open(&path).unwrap());
    let threads = ThreadController::with_store(store.clone());
    let root = start(&threads, "root", None);
    threads.archive_thread(&root.thread_id).unwrap();
    let barrier = std::sync::Barrier::new(2);
    let successes = std::thread::scope(|scope| {
        let handles = (0..2)
            .map(|i| {
                let barrier = &barrier;
                let path = &path;
                let root = &root;
                scope.spawn(move || {
                    let threads = ThreadController::with_store(Arc::new(
                        SqliteThreadStore::open(path).unwrap(),
                    ));
                    barrier.wait();
                    threads
                        .replace_thread(
                            &NoThreadWorktreeBinder,
                            ReplaceThreadRequest {
                                command_id: CommandId::new(format!("replace-{i}")).unwrap(),
                                source_thread_id: root.thread_id.clone(),
                                title: "replacement".into(),
                            },
                        )
                        .is_ok()
                })
            })
            .collect::<Vec<_>>();
        handles
            .into_iter()
            .map(|handle| usize::from(handle.join().unwrap()))
            .sum::<usize>()
    });
    assert_eq!(successes, 1);
    assert_eq!(store.list_agent_threads(&root.agent_id).unwrap().len(), 2);
}

#[test]
fn migration_indexes_legacy_identity_without_rewriting_history() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.sqlite");
    let store = Arc::new(SqliteThreadStore::open(&path).unwrap());
    let threads = ThreadController::with_store(store.clone());
    let root = start(&threads, "legacy", None);
    drop(threads);
    drop(store);
    let connection = rusqlite::Connection::open(&path).unwrap();
    let raw: String = connection
        .query_row(
            "SELECT records.record_json FROM thread_events events JOIN history_records records ON records.digest = events.record_digest WHERE events.thread_id = ?1",
            [root.thread_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    let mut legacy: serde_json::Value = serde_json::from_str(&raw).unwrap();
    legacy["schemaVersion"] = serde_json::json!(15);
    legacy["event"].as_object_mut().unwrap().remove("agentId");
    legacy["event"].as_object_mut().unwrap().remove("origin");
    let legacy = serde_json::to_string(&legacy).unwrap();
    connection.execute_batch("CREATE TABLE legacy_thread_events (thread_id TEXT, sequence INTEGER, event_id TEXT, schema_version INTEGER, envelope_json TEXT);").unwrap();
    connection.execute("INSERT INTO legacy_thread_events SELECT thread_id, sequence, event_id, 15, ?1 FROM thread_events", [&legacy]).unwrap();
    connection.execute_batch("DROP TABLE thread_events; ALTER TABLE legacy_thread_events RENAME TO thread_events;
        DROP TABLE thread_history_prefixes; DROP TABLE history_prefix_links; DROP TABLE history_prefix_records; DROP TABLE history_prefixes;
        DROP TABLE history_workspace_refs; DROP TABLE history_checkpoint_cleanup; DROP TABLE history_records;
        DROP TABLE agent_threads; DROP TABLE agents;
        CREATE TABLE legacy_thread_catalog (thread_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, requires_startup_recovery INTEGER NOT NULL, record_json TEXT NOT NULL);
        INSERT INTO legacy_thread_catalog SELECT thread_id, session_id, requires_startup_recovery, record_json FROM thread_catalog;
        DROP TABLE thread_catalog; ALTER TABLE legacy_thread_catalog RENAME TO thread_catalog;
        UPDATE ash_schema_migrations SET version = 5 WHERE component = 'event-store';").unwrap();
    let store = Arc::new(SqliteThreadStore::open(&path).unwrap());
    let threads = ThreadController::with_store(store.clone());
    let recovered = threads.read_thread(&root.thread_id).unwrap();
    assert_eq!(
        recovered.agent_id.as_str(),
        format!("legacy-agent:{}", root.thread_id)
    );
    assert_eq!(
        store
            .read_thread_binding(&root.thread_id)
            .unwrap()
            .unwrap()
            .agent_id,
        recovered.agent_id
    );
    assert_eq!(
        store.list_catalog().unwrap()[0].binding.agent_id,
        recovered.agent_id
    );
    let after: String = connection
        .query_row(
            "SELECT records.record_json FROM thread_events events JOIN history_records records ON records.digest = events.record_digest WHERE events.thread_id = ?1",
            [root.thread_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(after, legacy);
    let fork = threads
        .fork_thread(
            &NoThreadWorktreeBinder,
            ForkThreadRequest {
                command_id: CommandId::new("after-migration").unwrap(),
                source_thread_id: root.thread_id.clone(),
                title: "fork".into(),
            },
        )
        .unwrap();
    assert_eq!(fork.agent_id, recovered.agent_id);
    assert_eq!(
        store.list_agent_threads(&recovered.agent_id).unwrap().len(),
        2
    );
}

#[test]
fn delegation_queries_keep_breadth_first_order_and_exclude_forks() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(SqliteThreadStore::open(dir.path().join("state.sqlite")).unwrap());
    let threads = Arc::new(ThreadController::with_store(store.clone()));
    let root = start(&threads, "root", None);
    let instructions =
        ash_protocol::TurnInstructions::new("tests", "agent-tests", "1", "Complete the task")
            .unwrap();
    let turn = threads
        .start_turn(
            &root.thread_id,
            ash_core::StartTurnRequest {
                advisor: None,
                command_id: CommandId::new("start").unwrap(),
                expected_sequence: core_api::SequenceExpectation::Any,
                model: None,
                kind: ash_protocol::TurnKind::Coding,
                instructions: instructions.clone(),
                policy_revision: "policy".into(),
                approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: vec![],
                input: vec![ash_protocol::UserInput::Text {
                    text: "Delegate".into(),
                }],
            },
        )
        .unwrap();
    let coordinator =
        ash_core::MultiAgentCoordinator::new(threads.clone(), ash_core::AgentTreeLimits::default());
    let spawn = |name: &str, parent: &ThreadId, turn: &ash_protocol::TurnId| {
        coordinator
            .spawn(ash_core::SpawnAgentRequest {
                delegation_id: ash_protocol::DelegationId::new(name).unwrap(),
                session_id: root.session_id.clone(),
                parent_thread_id: parent.clone(),
                parent_turn_id: turn.clone(),
                task: ash_protocol::DelegatedTask {
                    title: name.into(),
                    instructions: "Complete delegated work".into(),
                },
                role: None,
                base_instructions: instructions.clone(),
                inheritance: ash_protocol::AgentContextMode::Fresh,
                policy_ceiling: ash_protocol::DelegatedPolicyCeiling {
                    policy_revision: "policy".into(),
                },
                capability_scope: ash_protocol::AgentCapabilityScope {
                    tools: vec![],
                    delegation_tools: vec![],
                    skills: vec![],
                },
            })
            .unwrap()
    };
    let b = spawn("b", &root.thread_id, &turn.turn_id);
    let a = spawn("a", &root.thread_id, &turn.turn_id);
    let c = spawn("c", &a.child_thread_id, &a.child_turn_id);
    let fork = threads
        .fork_thread(
            &NoThreadWorktreeBinder,
            ForkThreadRequest {
                command_id: CommandId::new("fork").unwrap(),
                source_thread_id: root.thread_id.clone(),
                title: "fork".into(),
            },
        )
        .unwrap();
    assert_eq!(fork.agent_id, root.agent_id);
    assert_ne!(
        threads.read_thread(&a.child_thread_id).unwrap().agent_id,
        root.agent_id
    );
    assert_eq!(
        store.list_spawn_children(&root.thread_id).unwrap(),
        vec![a.child_thread_id.clone(), b.child_thread_id.clone()]
    );
    let expected = vec![a.child_thread_id, b.child_thread_id, c.child_thread_id];
    assert_eq!(
        store.list_spawn_descendants(&root.thread_id).unwrap(),
        expected
    );
    coordinator.cancel_descendants(&root.thread_id).unwrap();
    assert_eq!(
        store.list_spawn_descendants(&root.thread_id).unwrap(),
        expected
    );
}

#[test]
fn fork_creation_commits_its_history_and_retries_at_the_original_anchor() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.sqlite");
    let store = Arc::new(SqliteThreadStore::open(&path).unwrap());
    let threads = ThreadController::with_store(store.clone());
    let source = start(&threads, "source", None);
    let request = || ForkThreadRequest {
        command_id: CommandId::new("fork").unwrap(),
        source_thread_id: source.thread_id.clone(),
        title: "fork".into(),
    };
    let fork = threads
        .fork_thread(&NoThreadWorktreeBinder, request())
        .unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    let batches: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM thread_batches WHERE thread_id = ?1",
            [fork.thread_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(batches, 1);
    assert_eq!(fork.sequence, 2);
    threads.archive_thread(&source.thread_id).unwrap();
    assert_eq!(
        threads
            .fork_thread(&NoThreadWorktreeBinder, request())
            .unwrap(),
        fork
    );
    drop(threads);
    let recovered = ThreadController::with_store(store);
    assert_eq!(
        recovered
            .fork_thread(&NoThreadWorktreeBinder, request())
            .unwrap(),
        fork
    );
}
