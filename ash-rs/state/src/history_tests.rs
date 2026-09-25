use crate::SqliteThreadStore;
use ash_core::NoThreadWorktreeBinder;
use ash_core::ThreadController;
use ash_protocol::CommandId;
use ash_protocol::ThreadEvent;
use ash_protocol::WorkspaceCheckpoint;
use ash_thread_store::ThreadStore;
use core_api::CheckpointCapture;
use core_api::CoreError;
use core_api::MessageCheckpointSource;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

#[derive(Default)]
struct CaptureStats {
    committed: AtomicUsize,
    released: AtomicUsize,
}
struct Source(Arc<CaptureStats>);
struct Capture {
    stats: Arc<CaptureStats>,
    workspace: WorkspaceCheckpoint,
    committed: AtomicBool,
}
impl CheckpointCapture for Capture {
    fn workspace(&self) -> &WorkspaceCheckpoint {
        &self.workspace
    }
    fn commit(&self) {
        self.committed.store(true, Ordering::Release);
        self.stats.committed.fetch_add(1, Ordering::Relaxed);
    }
}
impl Drop for Capture {
    fn drop(&mut self) {
        if !self.committed.load(Ordering::Acquire) {
            self.stats.released.fetch_add(1, Ordering::Relaxed);
        }
    }
}
impl MessageCheckpointSource for Source {
    fn capture(
        &self,
        _: &ash_protocol::ThreadId,
        _: &ash_protocol::TurnId,
        _: &ash_protocol::ItemId,
        event_id: &str,
    ) -> Result<Box<dyn CheckpointCapture>, CoreError> {
        Ok(Box::new(Capture {
            stats: self.0.clone(),
            committed: AtomicBool::new(false),
            workspace: WorkspaceCheckpoint::Git {
                source_dir_id: "dir".into(),
                repositories: vec![ash_protocol::RepositoryCheckpoint {
                    repository_id: "repository".into(),
                    relative_path: ".".into(),
                    target_branch: None,
                    target_head: "b".repeat(40),
                    target_unborn: false,
                    target_reference: format!("refs/ash/messages/{event_id}-target"),
                    tree_id: "a".repeat(40),
                    reference: format!("refs/ash/messages/{event_id}"),
                    git_directory: "/test/repository/.git".into(),
                }],
            },
        }))
    }
    fn release(&self, _: &ash_protocol::RepositoryCheckpoint) -> Result<(), CoreError> {
        self.0.released.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
}

fn root(threads: &ThreadController) -> ash_core::ThreadSnapshot {
    threads
        .start_thread(
            &NoThreadWorktreeBinder,
            core_api::StartThreadRequest {
                branch_name: None,
                agent: None,
                agent_id: None,
                command_id: CommandId::new("root").unwrap(),
                title: "root".into(),
            },
        )
        .unwrap()
}
fn start(
    threads: &ThreadController,
    thread: &ash_protocol::ThreadId,
) -> Result<ash_core::StartTurnResult, CoreError> {
    threads.start_turn(
        thread,
        ash_core::StartTurnRequest {
            advisor: None,
            command_id: CommandId::new("turn").unwrap(),
            expected_sequence: core_api::SequenceExpectation::Any,
            model: None,
            kind: Default::default(),
            instructions: ash_protocol::TurnInstructions::new(
                "test",
                "test",
                "1",
                "test instructions",
            )
            .unwrap(),
            policy_revision: "policy".into(),
            approval_mode: ash_protocol::ApprovalMode::AskPermissions,
            tool_mode: ash_protocol::ToolMode::Direct,
            tool_profile: None,
            activated_skills: vec![],
            input: vec![ash_protocol::UserInput::Text {
                text: "question".into(),
            }],
        },
    )
}

#[test]
fn retained_prefixes_share_original_records_and_survive_source_removal() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.sqlite");
    let store = Arc::new(SqliteThreadStore::open(&path).unwrap());
    let threads = ThreadController::with_store(store.clone());
    let stats = Arc::new(CaptureStats::default());
    let capture: Arc<dyn MessageCheckpointSource> = Arc::new(Source(stats.clone()));
    let root = root(&threads);
    threads
        .install_message_checkpoint_source(root.thread_id.clone(), capture.clone())
        .unwrap();
    let turn = start(&threads, &root.thread_id).unwrap();
    threads
        .complete_turn(&root.thread_id, &turn.turn_id, "answer".into())
        .unwrap();
    let point = threads
        .message_checkpoints(&root.thread_id)
        .unwrap()
        .last()
        .unwrap()
        .clone();
    let before = store.load(&root.thread_id).unwrap().len();
    let mut branches = Vec::new();
    for id in ["first", "second"] {
        branches.push(
            threads
                .fork_thread(
                    &NoThreadWorktreeBinder,
                    core_api::ForkThreadRequest {
                        command_id: CommandId::new(id).unwrap(),
                        source_thread_id: root.thread_id.clone(),
                        title: id.into(),
                    },
                )
                .unwrap(),
        );
    }
    let sql = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        sql.query_row::<i64, _, _>("SELECT COUNT(*) FROM history_prefixes", [], |row| row
            .get(0))
            .unwrap(),
        1
    );
    assert_eq!(
        sql.query_row::<i64, _, _>("SELECT COUNT(*) FROM history_records", [], |row| row.get(0))
            .unwrap(),
        before as i64 + 4
    );
    // Simulate pruning the archived source index. Retained prefixes must not read live source rows.
    for table in [
        "agent_threads",
        "thread_catalog",
        "thread_events",
        "thread_batches",
        "thread_streams",
    ] {
        sql.execute(
            &format!("DELETE FROM {table} WHERE thread_id = ?1"),
            [root.thread_id.as_str()],
        )
        .unwrap();
    }
    drop(threads);
    let reopened = ThreadController::with_store(Arc::new(SqliteThreadStore::open(&path).unwrap()));
    let restored = reopened
        .restore_message(
            &NoThreadWorktreeBinder,
            core_api::RestoreMessageRequest {
                command_id: CommandId::new("restore").unwrap(),
                source_thread_id: branches[0].thread_id.clone(),
                item_id: point.item_id,
                boundary: ash_protocol::MessageBoundary::After,
                title: "restored".into(),
            },
        )
        .unwrap();
    assert_eq!(restored.items, branches[0].items);
    assert!(store.pending_checkpoint_cleanup().unwrap().is_empty());
    store.delete_session(&root.session_id).unwrap();
    assert_eq!(
        sql.query_row::<i64, _, _>("SELECT COUNT(*) FROM history_records", [], |row| row.get(0))
            .unwrap(),
        0
    );
    assert_eq!(store.pending_checkpoint_cleanup().unwrap().len(), 2);
    reopened
        .collect_message_checkpoints(capture.as_ref())
        .unwrap();
    assert!(store.pending_checkpoint_cleanup().unwrap().is_empty());
    assert_eq!(stats.released.load(Ordering::Relaxed), 2);
}

#[test]
fn rejected_message_commit_releases_its_file_snapshot_reservation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.sqlite");
    let store = Arc::new(SqliteThreadStore::open(&path).unwrap());
    let threads = ThreadController::with_store(store.clone());
    let root = root(&threads);
    let stats = Arc::new(CaptureStats::default());
    let source: Arc<dyn MessageCheckpointSource> = Arc::new(Source(stats.clone()));
    threads
        .install_message_checkpoint_source(root.thread_id.clone(), source.clone())
        .unwrap();
    let sql = rusqlite::Connection::open(&path).unwrap();
    sql.execute_batch("CREATE TRIGGER reject_messages BEFORE INSERT ON thread_events BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;").unwrap();
    assert!(start(&threads, &root.thread_id).is_err());
    assert_eq!(stats.committed.load(Ordering::Relaxed), 0);
    assert_eq!(stats.released.load(Ordering::Relaxed), 1);
    assert_eq!(store.load(&root.thread_id).unwrap().len(), 1);
}

#[test]
fn corrupted_shared_record_fails_recovery_instead_of_reading_the_live_parent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.sqlite");
    let store = Arc::new(SqliteThreadStore::open(&path).unwrap());
    let threads = ThreadController::with_store(store.clone());
    let root = root(&threads);
    let branch = threads
        .fork_thread(
            &NoThreadWorktreeBinder,
            core_api::ForkThreadRequest {
                command_id: CommandId::new("fork").unwrap(),
                source_thread_id: root.thread_id.clone(),
                title: "fork".into(),
            },
        )
        .unwrap();
    let records = store.load(&branch.thread_id).unwrap();
    let ThreadEvent::HistoryPrefixBound { prefix, .. } = &records[1].event else {
        panic!("missing prefix")
    };
    let sql = rusqlite::Connection::open(&path).unwrap();
    sql.execute("UPDATE history_records SET record_json = '{}' WHERE digest IN (SELECT record_digest FROM history_prefix_records WHERE prefix_digest = ?1)", [prefix.digest.as_str()]).unwrap();
    let reopened = ThreadController::with_store(store);
    assert!(
        reopened
            .read_thread(&branch.thread_id)
            .unwrap_err()
            .to_string()
            .contains("digest")
    );
}
