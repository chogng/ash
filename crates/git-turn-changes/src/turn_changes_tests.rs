use crate::CaptureState;
use crate::ChangeFile;
use crate::ChangeFileKind;
use crate::ChangeSetId;
use crate::CommitState;
use crate::MessageState;
use crate::TerminalTurnState;
use crate::TurnChangeError;
use crate::TurnChangeSet;
use crate::TurnChangeSetDraft;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use pretty_assertions::assert_eq;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

#[derive(Default)]
struct MemoryStore {
    records: Mutex<BTreeMap<ChangeSetId, TurnChangeSet>>,
}

impl crate::TurnChangeStore for MemoryStore {
    fn insert(&self, change_set: &TurnChangeSet) -> Result<(), crate::TurnChangeStoreError> {
        let mut records = self.records.lock().unwrap();
        if records.contains_key(&change_set.change_set_id) {
            return Err(crate::TurnChangeStoreError::AlreadyExists(
                change_set.change_set_id.to_string(),
            ));
        }
        records.insert(change_set.change_set_id.clone(), change_set.clone());
        Ok(())
    }

    fn load(
        &self,
        change_set_id: &ChangeSetId,
    ) -> Result<TurnChangeSet, crate::TurnChangeStoreError> {
        self.records
            .lock()
            .unwrap()
            .get(change_set_id)
            .cloned()
            .ok_or_else(|| crate::TurnChangeStoreError::NotFound(change_set_id.to_string()))
    }

    fn list_for_thread(
        &self,
        thread_id: &ThreadId,
    ) -> Result<Vec<TurnChangeSet>, crate::TurnChangeStoreError> {
        Ok(self
            .records
            .lock()
            .unwrap()
            .values()
            .filter(|record| &record.thread_id == thread_id)
            .cloned()
            .collect())
    }

    fn compare_and_swap(
        &self,
        expected_revision: u64,
        change_set: &TurnChangeSet,
    ) -> Result<(), crate::TurnChangeStoreError> {
        let mut records = self.records.lock().unwrap();
        let current = records.get(&change_set.change_set_id).ok_or_else(|| {
            crate::TurnChangeStoreError::NotFound(change_set.change_set_id.to_string())
        })?;
        if current.revision != expected_revision {
            return Err(crate::TurnChangeStoreError::RevisionConflict {
                expected: expected_revision,
                actual: current.revision,
            });
        }
        records.insert(change_set.change_set_id.clone(), change_set.clone());
        Ok(())
    }
}

fn open_change_set() -> TurnChangeSet {
    TurnChangeSet::open(TurnChangeSetDraft {
        change_set_id: ChangeSetId::new("changes-1").unwrap(),
        session_id: SessionId::new("session-1").unwrap(),
        thread_id: ThreadId::new("thread-1").unwrap(),
        turn_id: TurnId::new("turn-1").unwrap(),
        repository_id: "repository-1".into(),
        worktree_root: PathBuf::from("/dir/repository-1"),
        git_common_dir: std::path::PathBuf::from("/dir/repository-1/.git"),
        target_branch: Some("main".into()),
        base_object_id: Some("head".into()),
        before_tree: "before".into(),
        baseline_dependency_paths: BTreeSet::new(),
        message_state: MessageState::Unconfigured,
    })
    .unwrap()
}

fn file() -> ChangeFile {
    ChangeFile {
        path: PathBuf::from("src/lib.rs"),
        previous_path: None,
        kind: ChangeFileKind::Modified,
        before_object_id: Some("old".into()),
        after_object_id: Some("new".into()),
        before_mode: Some("100644".into()),
        after_mode: Some("100644".into()),
        binary: false,
        additions: 3,
        deletions: 1,
    }
}

#[test]
fn sealed_change_set_preserves_manual_draft_when_generation_finishes() {
    let mut change_set = open_change_set();
    change_set
        .seal(
            "after".into(),
            TerminalTurnState::Completed,
            vec![file()],
            BTreeSet::new(),
        )
        .unwrap();
    change_set.queue_message().unwrap();
    change_set.begin_message_generation().unwrap();
    change_set
        .update_draft("fix(core): keep the manual wording".into())
        .unwrap();
    change_set
        .finish_message_generation("fix(core): generated wording".into())
        .unwrap();

    assert_eq!(
        (
            change_set.capture_state,
            change_set.message_state,
            change_set.generated_message.as_deref(),
            change_set.draft_message.as_deref(),
        ),
        (
            CaptureState::Sealed,
            MessageState::Ready,
            Some("fix(core): generated wording"),
            Some("fix(core): keep the manual wording"),
        )
    );
}

#[test]
fn evidence_digest_tracks_effects_but_not_commit_message_state() {
    let mut change_set = open_change_set();
    assert_eq!(
        change_set.evidence_digest(),
        Err(TurnChangeError::InvalidTransition)
    );
    change_set
        .seal(
            "after".into(),
            TerminalTurnState::Completed,
            vec![file()],
            BTreeSet::new(),
        )
        .unwrap();
    let sealed = change_set.evidence_digest().unwrap();
    change_set
        .update_draft("fix(core): describe the sealed result".into())
        .unwrap();
    assert_eq!(change_set.evidence_digest().unwrap(), sealed);

    let mut changed_effect = change_set.clone();
    changed_effect.files[0].additions += 1;
    assert_ne!(changed_effect.evidence_digest().unwrap(), sealed);
}

#[test]
fn selection_keeps_dependency_evidence_without_forcing_whole_turn_commits() {
    let mut record = open_change_set();
    record
        .seal(
            "after".into(),
            TerminalTurnState::Interrupted,
            vec![file()],
            BTreeSet::from([ChangeSetId::new("dependency").unwrap()]),
        )
        .unwrap();
    record
        .external_dependency_paths
        .insert("src/config.rs".into());
    let selection = crate::TurnCommitSelection {
        change_set_id: record.change_set_id.clone(),
        expected_revision: record.revision,
        paths: vec![file().path],
    };
    assert!(
        crate::validate_selection(
            &[record.clone()],
            &record.session_id,
            &record.thread_id,
            &[selection]
        )
        .is_ok()
    );
    assert_eq!(record.commit_state, CommitState::Idle);
    assert_eq!(
        record.dependencies,
        BTreeSet::from([ChangeSetId::new("dependency").unwrap()])
    );
}

#[test]
fn open_or_incomplete_change_set_cannot_be_selected_for_commit() {
    let mut record = open_change_set();
    for state in [crate::CaptureState::Open, crate::CaptureState::Incomplete] {
        record.capture_state = state;
        let selection = crate::TurnCommitSelection {
            change_set_id: record.change_set_id.clone(),
            expected_revision: record.revision,
            paths: vec![file().path],
        };
        assert!(
            crate::validate_selection(
                &[record.clone()],
                &record.session_id,
                &record.thread_id,
                &[selection]
            )
            .is_err()
        );
    }
}

#[test]
fn ledger_seals_rename_mode_and_line_statistics_from_immutable_trees() {
    let directory = tempfile::tempdir().unwrap();
    run_git(
        directory.path(),
        &["init", "--quiet", "--initial-branch=main"],
    );
    std::fs::write(directory.path().join("before.txt"), "one\ntwo\n").unwrap();
    run_git(directory.path(), &["add", "."]);
    run_git(directory.path(), &["commit", "--quiet", "-m", "initial"]);
    let head = run_git(directory.path(), &["rev-parse", "HEAD"]);
    let store = std::sync::Arc::new(MemoryStore::default());
    let ledger = crate::TurnChangeLedger::start(store).unwrap();
    let session_id = SessionId::new("session-1").unwrap();
    let thread_id = ThreadId::new("thread-1").unwrap();
    let turn_id = TurnId::new("turn-1").unwrap();
    ledger
        .begin_turn(crate::TurnChangeBeginRequest {
            session_id: session_id.clone(),
            thread_id: thread_id.clone(),
            turn_id: turn_id.clone(),
            repositories: vec![crate::RepositoryCaptureTarget {
                repository_id: "repository-1".into(),
                worktree_root: directory.path().to_path_buf(),
                target_branch: Some("main".into()),
                base_object_id: Some(head),
                baseline_dependency_paths: BTreeSet::new(),
            }],
            commit_message_configured: true,
            opaque_dependencies: false,
        })
        .unwrap();

    std::fs::rename(
        directory.path().join("before.txt"),
        directory.path().join("after.txt"),
    )
    .unwrap();
    std::fs::write(directory.path().join("after.txt"), "one\ntwo\nthree\n").unwrap();
    ledger
        .record_tool_scope(crate::ToolChangeScope {
            session_id: session_id.clone(),
            thread_id: thread_id.clone(),
            turn_id: turn_id.clone(),
            read_paths: BTreeSet::from([PathBuf::from("before.txt")]),
            write_paths: BTreeSet::from([PathBuf::from("before.txt"), PathBuf::from("after.txt")]),
            repository_paths: BTreeMap::from([("repository-1".into(), PathBuf::from("."))]),
            opaque_dependencies: false,
        })
        .unwrap();
    let open = ledger
        .refresh_turn(session_id.clone(), thread_id.clone(), turn_id.clone())
        .unwrap();
    assert_eq!(open[0].capture_state, CaptureState::Open);
    assert_eq!(open[0].files.len(), 1);
    assert_eq!(open[0].files[0].kind, ChangeFileKind::Renamed);
    let sealed = ledger
        .seal_turn(crate::TurnChangeSealRequest {
            session_id: session_id.clone(),
            thread_id: thread_id.clone(),
            turn_id: turn_id.clone(),
            terminal_state: TerminalTurnState::Completed,
        })
        .unwrap();

    assert_eq!(sealed.len(), 1);
    assert_eq!(sealed[0].capture_state, CaptureState::Sealed);
    assert_eq!(sealed[0].files.len(), 1);
    assert_eq!(sealed[0].files[0].kind, ChangeFileKind::Renamed);
    assert_eq!(sealed[0].files[0].path, PathBuf::from("after.txt"));
    assert_eq!(
        sealed[0].files[0].previous_path,
        Some(PathBuf::from("before.txt"))
    );
    assert_eq!(sealed[0].files[0].additions, 1);
    assert_eq!(sealed[0].files[0].deletions, 0);
    assert_eq!(sealed[0].files[0].before_mode.as_deref(), Some("100644"));
    assert_eq!(sealed[0].files[0].after_mode.as_deref(), Some("100644"));
    assert_eq!(
        ledger.refresh_turn(session_id, thread_id, turn_id).unwrap(),
        sealed
    );
}

#[test]
fn opaque_reads_do_not_claim_writes_outside_a_recorded_execution_window() {
    let directory = tempfile::tempdir().unwrap();
    run_git(
        directory.path(),
        &["init", "--quiet", "--initial-branch=main"],
    );
    std::fs::write(directory.path().join("tracked.txt"), "before\n").unwrap();
    run_git(directory.path(), &["add", "."]);
    run_git(directory.path(), &["commit", "--quiet", "-m", "initial"]);
    let head = run_git(directory.path(), &["rev-parse", "HEAD"]);
    let store = std::sync::Arc::new(MemoryStore::default());
    let ledger = crate::TurnChangeLedger::start(store).unwrap();
    let session_id = SessionId::new("session-opaque").unwrap();
    let thread_id = ThreadId::new("thread-opaque").unwrap();
    let turn_id = TurnId::new("turn-opaque").unwrap();
    ledger
        .begin_turn(crate::TurnChangeBeginRequest {
            session_id: session_id.clone(),
            thread_id: thread_id.clone(),
            turn_id: turn_id.clone(),
            repositories: vec![crate::RepositoryCaptureTarget {
                repository_id: "repository-opaque".into(),
                worktree_root: directory.path().to_path_buf(),
                target_branch: Some("main".into()),
                base_object_id: Some(head),
                baseline_dependency_paths: BTreeSet::new(),
            }],
            commit_message_configured: false,
            opaque_dependencies: true,
        })
        .unwrap();

    std::fs::write(directory.path().join("tracked.txt"), "outside lifecycle\n").unwrap();
    let sealed = ledger
        .seal_turn(crate::TurnChangeSealRequest {
            session_id,
            thread_id,
            turn_id,
            terminal_state: TerminalTurnState::Completed,
        })
        .unwrap();

    assert_eq!(sealed[0].capture_state, CaptureState::Incomplete);
    assert!(
        sealed[0].warnings[0].contains("writes outside a known Tool lifecycle"),
        "warning was {:?}",
        sealed[0].warnings
    );
}

fn run_git(root: &std::path::Path, arguments: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(root)
        .args([
            "-c",
            "user.name=Ash Test",
            "-c",
            "user.email=ash@example.invalid",
            "-c",
            "commit.gpgSign=false",
            "-c",
            if cfg!(windows) {
                "core.hooksPath=NUL"
            } else {
                "core.hooksPath=/dev/null"
            },
        ])
        .args(arguments)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {arguments:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}

#[test]
fn checkpoint_leases_exclude_writes_only_in_their_own_thread() {
    let tracker = crate::WriteLifecycleTracker::default();
    let first = ThreadId::new("first").unwrap();
    let second = ThreadId::new("second").unwrap();
    let turn = TurnId::new("turn").unwrap();
    tracker.begin(&first, &turn).unwrap();
    assert!(tracker.try_checkpoint(&first).unwrap().is_none());
    let lease = tracker.try_checkpoint(&second).unwrap().unwrap();
    tracker.end(&first, &turn);
    assert!(tracker.try_checkpoint(&first).unwrap().is_some());
    let writer = tracker.clone();
    let (started, waiting) = std::sync::mpsc::channel();
    let (finished, complete) = std::sync::mpsc::channel();
    let second_thread = second.clone();
    let worker = std::thread::spawn(move || {
        started.send(()).unwrap();
        writer.begin(&second_thread, &turn).unwrap();
        finished.send(()).unwrap();
        writer.end(&second_thread, &turn);
    });
    waiting.recv().unwrap();
    assert!(matches!(
        complete.recv_timeout(std::time::Duration::from_millis(30)),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout)
    ));
    drop(lease);
    complete
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap();
    worker.join().unwrap();
    assert!(tracker.try_checkpoint(&second).unwrap().is_some());
}

#[test]
fn selection_rejects_stale_repeated_unknown_and_wrong_owner_changes() {
    let mut record = open_change_set();
    record
        .seal(
            "after".into(),
            TerminalTurnState::Completed,
            vec![file()],
            BTreeSet::new(),
        )
        .unwrap();
    let valid = crate::TurnCommitSelection {
        change_set_id: record.change_set_id.clone(),
        expected_revision: record.revision,
        paths: vec![file().path],
    };
    for selection in [
        crate::TurnCommitSelection {
            expected_revision: valid.expected_revision - 1,
            ..valid.clone()
        },
        crate::TurnCommitSelection {
            paths: Vec::new(),
            ..valid.clone()
        },
        crate::TurnCommitSelection {
            paths: vec![file().path, file().path],
            ..valid.clone()
        },
        crate::TurnCommitSelection {
            paths: vec!["unknown.rs".into()],
            ..valid.clone()
        },
    ] {
        assert!(
            crate::validate_selection(
                &[record.clone()],
                &record.session_id,
                &record.thread_id,
                &[selection]
            )
            .is_err()
        );
    }
    assert!(
        crate::validate_selection(
            &[record.clone()],
            &record.session_id,
            &record.thread_id,
            &[valid.clone(), valid.clone()]
        )
        .is_err()
    );
    assert!(
        crate::validate_selection(
            &[record.clone()],
            &SessionId::new("other").unwrap(),
            &record.thread_id,
            &[valid.clone()]
        )
        .is_err()
    );
    assert!(
        crate::validate_selection(
            &[record.clone()],
            &record.session_id,
            &ThreadId::new("other").unwrap(),
            &[valid]
        )
        .is_err()
    );
}

#[test]
fn relocated_object_store_does_not_change_sealed_evidence() {
    use crate::TurnChangeStore;
    let store = MemoryStore::default();
    let mut record = open_change_set();
    record
        .seal(
            "after".into(),
            TerminalTurnState::Completed,
            vec![file()],
            BTreeSet::new(),
        )
        .unwrap();
    let evidence = record.evidence_digest().unwrap();
    store.insert(&record).unwrap();
    crate::relocate_capture_objects(
        &store,
        &record.thread_id,
        &record.repository_id,
        std::path::Path::new("/other/.git"),
    )
    .unwrap();
    let relocated = store.load(&record.change_set_id).unwrap();
    assert_eq!(relocated.evidence_digest().unwrap(), evidence);
    assert_eq!(relocated.revision, record.revision + 1);
    assert_eq!(relocated.git_common_dir, PathBuf::from("/other/.git"));
    crate::relocate_capture_objects(
        &store,
        &record.thread_id,
        &record.repository_id,
        &relocated.git_common_dir,
    )
    .unwrap();
    assert_eq!(store.load(&record.change_set_id).unwrap(), relocated);
}
