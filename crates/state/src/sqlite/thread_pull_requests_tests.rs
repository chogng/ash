use super::*;
use ash_core::ThreadController;
use ash_thread_store::ThreadEventPrecondition;
use std::cell::RefCell;
use std::sync::Arc;
use std::sync::mpsc;
use std::time::Duration;

fn start(
    threads: &ThreadController,
    thread: &ThreadId,
    precondition: &ThreadEventPrecondition,
) -> Result<ash_core::StartTurnResult, core_api::CoreError> {
    threads.start_turn_with_admission(
        thread,
        ash_core::StartTurnRequest {
            context_policy: Default::default(),
            mode: Default::default(),
            advisor: None,
            command_id: ash_protocol::CommandId::new("repair").unwrap(),
            expected_sequence: core_api::SequenceExpectation::Any,
            model: None,
            reasoning_effort: None,
            kind: Default::default(),
            instructions: ash_protocol::TurnInstructions::new("test", "admission", "1", "Fix CI")
                .unwrap(),
            policy_revision: "test".into(),
            approval_mode: ash_protocol::ApprovalMode::Manual,
            tool_mode: ash_protocol::ToolMode::Direct,
            tool_profile: None,
            activated_skills: Vec::new(),
            input: vec![ash_protocol::UserInput::Text {
                text: "Fix CI".into(),
            }],
        },
        None,
        None,
        Some(precondition),
    )
}

// Busy callbacks are connection-local function pointers; keep synchronization on
// the calling thread so independent test cases never share a barrier.
thread_local! {
    static ON_BUSY: RefCell<Option<Box<dyn FnOnce() -> bool>>> = RefCell::new(None);
}

fn on_busy(_: i32) -> bool {
    ON_BUSY.with(|callback| {
        callback
            .borrow_mut()
            .take()
            .is_some_and(|callback| callback())
    })
}

#[test]
fn artifact_revocation_and_turn_acceptance_have_one_order_across_connections() {
    for deletion_first in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.sqlite3");
        let store = Arc::new(SqliteThreadStore::open(&path).unwrap());
        let deleting = Arc::new(SqliteThreadStore::open(&path).unwrap());
        let threads = ThreadController::with_store(store.clone());
        let source = threads
            .start_thread(
                &ash_core::NoThreadWorktreeBinder,
                core_api::StartThreadRequest {
                    kind: ash_protocol::SessionKind::Code,
                    execution_target: None,
                    branch_name: None,
                    worktree_start: None,
                    agent_id: None,
                    agent: None,
                    command_id: ash_protocol::CommandId::new("source").unwrap(),
                    title: "Artifact source".into(),
                },
            )
            .unwrap()
            .thread_id;
        let repository =
            Repository::new("github.com".into(), "team".into(), "repo".into()).unwrap();
        store.record_pull_request(&source, &repository, 7).unwrap();
        let precondition = ThreadEventPrecondition::PullRequestArtifact {
            source_thread_id: source.clone(),
            artifact_id: store
                .pull_request_artifact_id(&source, &repository, 7)
                .unwrap()
                .unwrap(),
        };
        let before = threads.read_thread(&source).unwrap().sequence;
        let (inside, reached) = mpsc::channel();
        let (release, resume) = mpsc::channel();
        let (contended, waiting) = mpsc::channel();
        let (retry, unlocked) = mpsc::channel();
        let first = if deletion_first { &deleting } else { &store };
        let mut resume = Some(resume);
        first
            .connection()
            .unwrap()
            .update_hook(Some(
                move |action: rusqlite::hooks::Action, _: &str, table: &str, _: i64| {
                    let boundary = if deletion_first {
                        table == "thread_pull_requests"
                            && action == rusqlite::hooks::Action::SQLITE_DELETE
                    } else {
                        table == "thread_events" && action == rusqlite::hooks::Action::SQLITE_INSERT
                    };
                    if boundary && let Some(resume) = resume.take() {
                        inside.send(()).unwrap();
                        resume.recv_timeout(Duration::from_secs(10)).unwrap();
                    }
                },
            ))
            .unwrap();
        std::thread::scope(|scope| {
            let store = &store;
            let deleting = &deleting;
            let admit = || start(&threads, &source, &precondition);
            let detach = || deleting.detach_pull_request(&source, &repository, 7);
            let (admission, deletion) = if deletion_first {
                let deletion = scope.spawn(detach);
                reached.recv_timeout(Duration::from_secs(10)).unwrap();
                let admission = scope.spawn(move || {
                    ON_BUSY.with(|callback| {
                        *callback.borrow_mut() = Some(Box::new(move || {
                            contended.send(()).unwrap();
                            unlocked.recv_timeout(Duration::from_secs(10)).is_ok()
                        }))
                    });
                    store
                        .connection()
                        .unwrap()
                        .busy_handler(Some(on_busy))
                        .unwrap();
                    admit()
                });
                waiting.recv_timeout(Duration::from_secs(10)).unwrap();
                release.send(()).unwrap();
                let deleted = deletion.join().unwrap();
                retry.send(()).unwrap();
                (admission.join().unwrap(), deleted)
            } else {
                let admission = scope.spawn(admit);
                reached.recv_timeout(Duration::from_secs(10)).unwrap();
                let deletion = scope.spawn(move || {
                    ON_BUSY.with(|callback| {
                        *callback.borrow_mut() = Some(Box::new(move || {
                            contended.send(()).unwrap();
                            unlocked.recv_timeout(Duration::from_secs(10)).is_ok()
                        }))
                    });
                    deleting
                        .connection()
                        .unwrap()
                        .busy_handler(Some(on_busy))
                        .unwrap();
                    detach()
                });
                waiting.recv_timeout(Duration::from_secs(10)).unwrap();
                release.send(()).unwrap();
                let accepted = admission.join().unwrap();
                retry.send(()).unwrap();
                (accepted, deletion.join().unwrap())
            };
            assert!(deletion.unwrap());
            if deletion_first {
                assert!(matches!(
                    admission,
                    Err(core_api::CoreError::ThreadStore(
                        ThreadStoreError::AuthorizationRevoked
                    ))
                ));
                let snapshot = threads.read_thread(&source).unwrap();
                assert_eq!(snapshot.sequence, before);
                assert!(snapshot.turns.is_empty());
            } else {
                let accepted = admission.unwrap();
                assert_eq!(threads.read_thread(&source).unwrap().turns.len(), 1);
                // A retry reconciles the existing receipt; it cannot add another Turn
                // or turn a committed admission into a post-revocation rejection.
                assert_eq!(
                    start(&threads, &source, &precondition).unwrap().turn_id,
                    accepted.turn_id
                );
                assert_eq!(threads.read_thread(&source).unwrap().turns.len(), 1);
            }
        });
        assert_eq!(
            store
                .pull_request_artifact_id(&source, &repository, 7)
                .unwrap(),
            None
        );
    }
}
