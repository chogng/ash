use super::SqliteTurnChangeStore;
use ash_git::GitClient;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use git_turn_changes::CaptureState;
use git_turn_changes::ChangeSetId;
use git_turn_changes::CommitState;
use git_turn_changes::MessageState;
use git_turn_changes::TerminalTurnState;
use git_turn_changes::TurnChangeSet;
use git_turn_changes::TurnChangeSetDraft;
use git_turn_changes::TurnChangeStore;
use git_turn_changes::TurnCommitSelection;
use git_turn_changes::TurnCommitState;
use git_turn_changes::TurnCommitStore;
use git_turn_changes::TurnPublication;
use std::collections::BTreeSet;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;

struct Scenario {
    directory: tempfile::TempDir,
    source: PathBuf,
    store: SqliteTurnChangeStore,
    git: GitClient,
}

impl Scenario {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("repository");
        std::fs::create_dir(&source).unwrap();
        git(&source, &["init", "--initial-branch=main"]);
        git(&source, &["config", "user.name", "Turn Test"]);
        git(&source, &["config", "user.email", "turn@example.invalid"]);
        std::fs::write(
            source.join("a.txt"),
            "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
        )
        .unwrap();
        std::fs::write(source.join("b.txt"), "baseline\n").unwrap();
        git(&source, &["add", "."]);
        git(&source, &["commit", "-m", "baseline"]);
        let store = SqliteTurnChangeStore::open(directory.path().join("state.sqlite")).unwrap();
        Self {
            directory,
            source,
            store,
            git: GitClient::system(),
        }
    }
    fn checkout(&self, name: &str) -> PathBuf {
        let checkout = self.directory.path().join(name);
        git(
            &self.source,
            &[
                "worktree",
                "add",
                "--detach",
                checkout.to_str().unwrap(),
                "HEAD",
            ],
        );
        checkout
    }
    async fn capture(
        &self,
        checkout: &Path,
        session: &str,
        turn: &str,
        before: &ash_git::GitTreeId,
    ) -> TurnChangeSet {
        let repository = self.git.open_repository(checkout).await.unwrap();
        let after = self.git.capture_worktree_tree(&repository).await.unwrap();
        let mut record = TurnChangeSet::open(TurnChangeSetDraft {
            change_set_id: ChangeSetId::new(format!("{session}-{turn}")).unwrap(),
            session_id: SessionId::new(session).unwrap(),
            thread_id: ThreadId::new(format!("{session}-thread")).unwrap(),
            turn_id: TurnId::new(turn).unwrap(),
            repository_id: "repository".into(),
            worktree_root: checkout.to_path_buf(),
            git_common_dir: repository.common_dir().to_path_buf(),
            target_branch: Some("main".into()),
            base_object_id: Some(git(&self.source, &["rev-parse", "HEAD"])),
            before_tree: before.as_str().into(),
            baseline_dependency_paths: BTreeSet::new(),
            message_state: MessageState::Unconfigured,
        })
        .unwrap();
        record
            .seal(
                after.as_str().into(),
                TerminalTurnState::Completed,
                self.git
                    .diff_trees(&repository, before, &after)
                    .await
                    .unwrap()
                    .into_iter()
                    .map(git_turn_changes::change_file)
                    .collect(),
                BTreeSet::new(),
            )
            .unwrap();
        self.store.insert(&record).unwrap();
        record
    }
    async fn prepare(
        &self,
        records: &[TurnChangeSet],
        selections: &[TurnCommitSelection],
        id: &str,
    ) -> git_turn_changes::TurnCommitRecord {
        let repository = self.git.open_repository(&self.source).await.unwrap();
        let record = git_turn_changes::prepare_selection(
            &self.git,
            &repository,
            id.into(),
            &records[0].session_id,
            &records[0].thread_id,
            records,
            selections,
            format!("commit {id}"),
        )
        .await
        .unwrap();
        self.store
            .save_preview(&record, &format!("preview-{id}"), id, "preview-response")
            .unwrap();
        record
    }
    async fn publish(&self, id: &str) -> Vec<TurnChangeSet> {
        self.store
            .queue_publication(id, &format!("publish-{id}"), id, "queued-response")
            .unwrap();
        let repository = self.git.open_repository(&self.source).await.unwrap();
        git_turn_changes::publish_selection(&self.store, &self.git, &repository, id)
            .await
            .unwrap()
    }
}

fn git(root: &Path, arguments: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(root)
        .args([
            "-c",
            "commit.gpgsign=false",
            "-c",
            if cfg!(windows) {
                "core.hooksPath=NUL"
            } else {
                "core.hooksPath=/dev/null"
            },
            "-c",
            "core.autocrlf=false",
        ])
        .args(arguments)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {arguments:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}

fn selection(record: &TurnChangeSet, paths: &[&str]) -> TurnCommitSelection {
    TurnCommitSelection {
        change_set_id: record.change_set_id.clone(),
        expected_revision: record.revision,
        paths: paths.iter().map(PathBuf::from).collect(),
    }
}

#[tokio::test]
async fn selected_files_commit_independently_and_the_queued_message_is_frozen() {
    let scenario = Scenario::new();
    let checkout = scenario.checkout("session-a");
    let repository = scenario.git.open_repository(&checkout).await.unwrap();
    let before = scenario
        .git
        .capture_worktree_tree(&repository)
        .await
        .unwrap();
    std::fs::write(checkout.join("a.txt"), "agent A\n").unwrap();
    std::fs::write(checkout.join("b.txt"), "agent B\n").unwrap();
    let record = scenario
        .capture(&checkout, "session-a", "turn-a", &before)
        .await;
    let commit = scenario
        .prepare(
            &[record.clone()],
            &[selection(&record, &["a.txt"])],
            "first",
        )
        .await;
    let mut draft = scenario.store.load(&record.change_set_id).unwrap();
    let expected = draft.revision;
    draft
        .update_draft("changed after previewing".into())
        .unwrap();
    scenario.store.compare_and_swap(expected, &draft).unwrap();
    scenario
        .store
        .queue_publication("first", "publish-first", "first", "queued-response")
        .unwrap();
    let mut draft = scenario.store.load(&record.change_set_id).unwrap();
    let expected = draft.revision;
    draft.update_draft("changed after queueing".into()).unwrap();
    scenario.store.compare_and_swap(expected, &draft).unwrap();
    let target = scenario
        .git
        .open_repository(&scenario.source)
        .await
        .unwrap();
    git_turn_changes::publish_selection(&scenario.store, &scenario.git, &target, "first")
        .await
        .unwrap();
    let partial = scenario.store.load(&record.change_set_id).unwrap();
    assert!(matches!(
        partial.commit_state,
        CommitState::PartiallyCommitted { .. }
    ));
    assert_eq!(partial.committed_paths, BTreeSet::from(["a.txt".into()]));
    assert_eq!(git(&scenario.source, &["show", "HEAD:b.txt"]), "baseline");
    assert_eq!(
        git(&scenario.source, &["log", "-1", "--format=%s"]),
        commit.message
    );
    assert_eq!(
        git(&scenario.source, &["log", "-1", "--format=%an <%ae>"]),
        "Turn Test <turn@example.invalid>"
    );
    assert_eq!(
        std::fs::read_to_string(checkout.join("b.txt")).unwrap(),
        "agent B\n"
    );
    assert_eq!(
        scenario
            .store
            .replay_command("publish-first", "first")
            .unwrap(),
        Some("queued-response".into())
    );
    assert!(
        scenario
            .store
            .queue_publication("first", "different-command", "first", "response")
            .is_err()
    );
    assert!(
        git_turn_changes::validate_selection(
            &[partial.clone()],
            &partial.session_id,
            &partial.thread_id,
            &[selection(&partial, &["a.txt"])]
        )
        .is_err()
    );
    scenario
        .prepare(
            &[partial.clone()],
            &[selection(&partial, &["b.txt"])],
            "second",
        )
        .await;
    let complete = scenario.publish("second").await;
    assert!(matches!(
        complete[0].commit_state,
        CommitState::Committed { .. }
    ));
    assert_eq!(git(&scenario.source, &["show", "HEAD:b.txt"]), "agent B");
    assert_eq!(git(&scenario.source, &["rev-list", "--count", "HEAD"]), "3");
}

#[tokio::test]
async fn concurrent_sessions_keep_their_files_and_repreview_after_target_moves() {
    let scenario = Scenario::new();
    let a = scenario.checkout("session-a");
    let b = scenario.checkout("session-b");
    let repository = scenario.git.open_repository(&a).await.unwrap();
    let before = scenario
        .git
        .capture_worktree_tree(&repository)
        .await
        .unwrap();
    let original = std::fs::read_to_string(a.join("a.txt")).unwrap();
    std::fs::write(a.join("a.txt"), original.replace("one\n", "A\n")).unwrap();
    std::fs::write(b.join("a.txt"), original.replace("ten\n", "B\n")).unwrap();
    std::fs::write(b.join("b.txt"), "must stay in B\n").unwrap();
    let record_a = scenario.capture(&a, "session-a", "a", &before).await;
    let record_b = scenario.capture(&b, "session-b", "b", &before).await;
    scenario
        .prepare(
            &[record_a.clone()],
            &[selection(&record_a, &["a.txt"])],
            "a",
        )
        .await;
    scenario
        .prepare(
            &[record_b.clone()],
            &[selection(&record_b, &["a.txt"])],
            "b",
        )
        .await;
    scenario.publish("a").await;
    let conflicted = scenario.publish("b").await;
    assert!(matches!(
        conflicted[0].commit_state,
        CommitState::Conflict { .. }
    ));
    assert!(conflicted[0].committed_paths.is_empty());
    assert_eq!(
        std::fs::read_to_string(a.join("a.txt")).unwrap(),
        original.replace("one\n", "A\n")
    );
    assert_eq!(
        std::fs::read_to_string(b.join("a.txt")).unwrap(),
        original.replace("ten\n", "B\n")
    );
    let latest_b = scenario.store.load(&record_b.change_set_id).unwrap();
    scenario
        .prepare(
            &[latest_b.clone()],
            &[selection(&latest_b, &["a.txt"])],
            "b-repreview",
        )
        .await;
    scenario.publish("b-repreview").await;
    assert_eq!(
        git(&scenario.source, &["show", "HEAD:a.txt"]),
        original
            .replace("one\n", "A\n")
            .replace("ten\n", "B\n")
            .trim()
    );
    assert_eq!(git(&scenario.source, &["show", "HEAD:b.txt"]), "baseline");
    assert!(
        git_turn_changes::validate_selection(
            &[record_a.clone(), record_b.clone()],
            &record_a.session_id,
            &record_a.thread_id,
            &[
                selection(&record_a, &["a.txt"]),
                selection(&record_b, &["a.txt"])
            ]
        )
        .is_err()
    );
}

#[tokio::test]
async fn multiple_turns_replay_in_capture_order_without_copying_unselected_files() {
    let scenario = Scenario::new();
    let checkout = scenario.checkout("session");
    let repository = scenario.git.open_repository(&checkout).await.unwrap();
    let before = scenario
        .git
        .capture_worktree_tree(&repository)
        .await
        .unwrap();
    std::fs::write(checkout.join("a.txt"), "first\n").unwrap();
    let a = scenario
        .capture(&checkout, "session", "first", &before)
        .await;
    let middle = scenario
        .git
        .capture_worktree_tree(&repository)
        .await
        .unwrap();
    std::fs::write(checkout.join("a.txt"), "first\nsecond\n").unwrap();
    std::fs::write(checkout.join("b.txt"), "unselected\n").unwrap();
    let b = scenario
        .capture(&checkout, "session", "second", &middle)
        .await;
    let commit = scenario
        .prepare(
            &[a.clone(), b.clone()],
            &[selection(&b, &["a.txt"]), selection(&a, &["a.txt"])],
            "combined",
        )
        .await;
    assert_eq!(
        commit
            .sources
            .iter()
            .map(|source| source.change_set_id.clone())
            .collect::<Vec<_>>(),
        vec![a.change_set_id.clone(), b.change_set_id.clone()]
    );
    scenario.publish("combined").await;
    assert_eq!(
        git(&scenario.source, &["show", "HEAD:a.txt"]),
        "first\nsecond"
    );
    assert_eq!(git(&scenario.source, &["show", "HEAD:b.txt"]), "baseline");
    assert!(matches!(
        scenario.store.load(&b.change_set_id).unwrap().commit_state,
        CommitState::PartiallyCommitted { .. }
    ));
}

#[tokio::test]
async fn published_commit_without_a_database_receipt_recovers_once_after_reopening() {
    let scenario = Scenario::new();
    let checkout = scenario.checkout("session");
    let repository = scenario.git.open_repository(&checkout).await.unwrap();
    let before = scenario
        .git
        .capture_worktree_tree(&repository)
        .await
        .unwrap();
    std::fs::write(checkout.join("a.txt"), "sealed\n").unwrap();
    let record = scenario
        .capture(&checkout, "session", "turn", &before)
        .await;
    scenario
        .prepare(
            &[record.clone()],
            &[selection(&record, &["a.txt"])],
            "interrupted",
        )
        .await;
    scenario
        .store
        .queue_publication(
            "interrupted",
            "publish-interrupted",
            "interrupted",
            "response",
        )
        .unwrap();
    let mut commit = scenario.store.load_commit("interrupted").unwrap();
    let expected = commit.revision;
    commit.revision += 1;
    commit.state = TurnCommitState::Publishing;
    scenario
        .store
        .update_publication(expected, &commit)
        .unwrap();
    let target = scenario
        .git
        .open_repository(&scenario.source)
        .await
        .unwrap();
    let TurnPublication::Prepared { commit: prepared } = &commit.publication else {
        panic!("prepared request");
    };
    git_transaction::GitTransactions::new(&scenario.git)
        .publish_prepared_tree_commit(&target, prepared)
        .await
        .unwrap();
    // Git can collect unreachable objects and another commit can advance the branch before DB recovery.
    git(&scenario.source, &["gc", "--prune=now"]);
    std::fs::write(
        scenario.source.join("b.txt"),
        "external commit after publication\n",
    )
    .unwrap();
    git(&scenario.source, &["add", "b.txt"]);
    git(&scenario.source, &["commit", "-m", "external"]);
    let advanced = git(&scenario.source, &["rev-parse", "HEAD"]);
    let reopened = SqliteTurnChangeStore::open(scenario.store.path()).unwrap();
    git_turn_changes::publish_selection(&reopened, &scenario.git, &target, "interrupted")
        .await
        .unwrap();
    git_turn_changes::publish_selection(&reopened, &scenario.git, &target, "interrupted")
        .await
        .unwrap();
    assert_eq!(git(&scenario.source, &["rev-list", "--count", "HEAD"]), "3");
    assert_eq!(git(&scenario.source, &["rev-parse", "HEAD"]), advanced);
    assert!(
        git(
            &scenario.source,
            &["for-each-ref", "refs/ash/commit-transactions"]
        )
        .is_empty()
    );
    assert!(matches!(
        reopened.load(&record.change_set_id).unwrap().commit_state,
        CommitState::Committed { .. }
    ));
    assert!(
        !target
            .common_dir()
            .join("ash/commit-transactions/interrupted.json")
            .exists()
    );
}

#[tokio::test]
async fn legacy_queued_commits_migrate_the_full_selection_message_and_transaction_identity() {
    let scenario = Scenario::new();
    let checkout = scenario.checkout("session");
    let repository = scenario.git.open_repository(&checkout).await.unwrap();
    let before = scenario
        .git
        .capture_worktree_tree(&repository)
        .await
        .unwrap();
    std::fs::write(checkout.join("b.txt"), "legacy\n").unwrap();
    let mut record = scenario
        .capture(&checkout, "session", "turn", &before)
        .await;
    record.update_draft("frozen legacy message".into()).unwrap();
    let mut json = serde_json::to_value(&record).unwrap();
    json["commitState"] = serde_json::json!({"type":"queued"});
    let connection = rusqlite::Connection::open(scenario.store.path()).unwrap();
    connection.execute_batch("DROP TABLE turn_commits; UPDATE ash_schema_migrations SET version = 10 WHERE component = 'event-store';").unwrap();
    connection
        .execute(
            "UPDATE turn_change_sets SET revision = ?1, record_json = ?2",
            rusqlite::params![i64::try_from(record.revision).unwrap(), json.to_string()],
        )
        .unwrap();
    drop(connection);
    let migrated = SqliteTurnChangeStore::open(scenario.store.path()).unwrap();
    let commits = migrated.list_commits(&record.thread_id).unwrap();
    assert_eq!(commits.len(), 1);
    assert!(commits[0].commit_id.starts_with("changeset-"));
    assert_eq!(commits[0].message, "frozen legacy message");
    assert_eq!(commits[0].sources[0].paths, vec![PathBuf::from("b.txt")]);
    assert_eq!(commits[0].state, TurnCommitState::Queued);
    assert_eq!(
        migrated.load(&record.change_set_id).unwrap().capture_state,
        CaptureState::Sealed
    );
}

#[cfg(unix)]
fn git_with_install_failure(source: &Path, injection: &str) -> (tempfile::TempDir, GitClient) {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let executable = directory.path().join("git-failure");
    let quote = |path: &Path| format!("'{}'", path.display().to_string().replace('\'', "'\\''"));
    std::fs::write(&executable, format!(
        "#!/bin/sh\nset -eu\nreal_git={}\nroot={}\nmarker={}\n{injection}\nexec \"$real_git\" \"$@\"\n",
        quote(&GitClient::system().executable().unwrap()), quote(source), quote(&directory.path().join("injected")),
    )).unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let client =
        GitClient::with_executable(executable, ash_git::GitExecutionLimits::default()).unwrap();
    (directory, client)
}

#[cfg(unix)]
#[tokio::test]
async fn published_checkout_failure_remains_pending_and_resumes_after_sqlite_reopen() {
    for (injection, expected_paths) in [
        (
            r#"case " $* " in
  *" read-tree -m -u "*)
    if mkdir "$marker" 2>/dev/null; then "$real_git" "$@"; exit 73; fi ;;
esac"#,
            vec!["a.txt"],
        ),
        (
            r#"case " $* " in
  *" read-tree -m -u "*)
    if mkdir "$marker" 2>/dev/null; then exit 73; fi ;;
esac"#,
            vec![],
        ),
    ] {
        let scenario = Scenario::new();
        let checkout = scenario.checkout("session");
        let repository = scenario.git.open_repository(&checkout).await.unwrap();
        let before = scenario
            .git
            .capture_worktree_tree(&repository)
            .await
            .unwrap();
        std::fs::write(checkout.join("a.txt"), "sealed\n").unwrap();
        let record = scenario
            .capture(&checkout, "session", "turn", &before)
            .await;
        let preview = scenario
            .prepare(
                &[record.clone()],
                &[selection(&record, &["a.txt"])],
                "recover-install",
            )
            .await;
        let object_id = match &preview.publication {
            TurnPublication::Prepared { commit } => commit.object_id().to_owned(),
            _ => panic!("prepared request"),
        };
        scenario
            .store
            .queue_publication("recover-install", "queue", "queue", "{}")
            .unwrap();
        std::fs::write(scenario.source.join("b.txt"), "staged local\n").unwrap();
        git(&scenario.source, &["add", "b.txt"]);
        std::fs::write(scenario.source.join("b.txt"), "unstaged local\n").unwrap();
        let (wrapper, failing) = git_with_install_failure(&scenario.source, injection);
        let target = failing.open_repository(&scenario.source).await.unwrap();
        git_turn_changes::publish_selection(&scenario.store, &failing, &target, "recover-install")
            .await
            .unwrap();
        assert!(wrapper.path().join("injected").exists());
        assert_eq!(git(&scenario.source, &["rev-parse", "HEAD"]), object_id);
        assert_eq!(
            scenario
                .store
                .load(&record.change_set_id)
                .unwrap()
                .commit_state,
            CommitState::Committing
        );
        assert!(
            git_turn_changes::require_settled_publications(
                &scenario.store.list_commits(&record.thread_id).unwrap()
            )
            .is_err()
        );
        let TurnCommitState::Recovering { paths, error } =
            scenario.store.load_commit("recover-install").unwrap().state
        else {
            panic!("checkout must remain recoverable")
        };
        assert_eq!(
            paths,
            expected_paths.iter().map(PathBuf::from).collect::<Vec<_>>()
        );
        assert_eq!(error.is_some(), expected_paths.is_empty());
        let journal = target
            .common_dir()
            .join("ash/commit-transactions/recover-install.json");
        assert!(journal.exists());

        let path = scenario.store.path().to_owned();
        drop(scenario.store);
        let reopened = SqliteTurnChangeStore::open(path).unwrap();
        let (guard, recovery) = git_with_install_failure(
            &scenario.source,
            r#"case " $* " in
  *" update-ref refs/heads/main "*) printf 'ref republished\n' > "$marker"; exit 74 ;;
esac"#,
        );
        for _ in 0..2 {
            git_turn_changes::publish_selection(&reopened, &recovery, &target, "recover-install")
                .await
                .unwrap();
        }
        assert!(!guard.path().join("injected").exists());
        assert_eq!(git(&scenario.source, &["rev-list", "--count", "HEAD"]), "2");
        assert_eq!(git(&scenario.source, &["rev-parse", "HEAD"]), object_id);
        assert_eq!(git(&scenario.source, &["show", ":a.txt"]), "sealed");
        assert_eq!(git(&scenario.source, &["show", ":b.txt"]), "staged local");
        assert_eq!(
            std::fs::read_to_string(scenario.source.join("b.txt")).unwrap(),
            "unstaged local\n"
        );
        assert!(matches!(
            reopened.load_commit("recover-install").unwrap().state,
            TurnCommitState::Committed { .. }
        ));
        assert!(matches!(
            reopened.load(&record.change_set_id).unwrap().commit_state,
            CommitState::Committed { .. }
        ));
        assert!(!journal.exists());
        assert!(
            git(
                &scenario.source,
                &["for-each-ref", "refs/ash/commit-transactions"]
            )
            .is_empty()
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn pending_and_legacy_checkout_conflicts_preserve_edits_and_never_republish() {
    for legacy in [false, true] {
        let scenario = Scenario::new();
        let original = std::fs::read_to_string(scenario.source.join("a.txt")).unwrap();
        let base_head = git(&scenario.source, &["rev-parse", "HEAD"]);
        let checkout = scenario.checkout("session");
        let repository = scenario.git.open_repository(&checkout).await.unwrap();
        let before = scenario
            .git
            .capture_worktree_tree(&repository)
            .await
            .unwrap();
        std::fs::write(checkout.join("a.txt"), "sealed\n").unwrap();
        let capture = scenario
            .capture(&checkout, "session", "turn", &before)
            .await;
        let preview = scenario
            .prepare(
                &[capture.clone()],
                &[selection(&capture, &["a.txt"])],
                "pending-save",
            )
            .await;
        scenario
            .prepare(
                &[capture.clone()],
                &[selection(&capture, &["a.txt"])],
                "duplicate",
            )
            .await;
        let TurnPublication::Prepared { commit: prepared } = &preview.publication else {
            panic!("prepared request")
        };
        let published = prepared.object_id().to_owned();
        scenario
            .store
            .queue_publication("pending-save", "queue-first", "first", "{}")
            .unwrap();
        let (injected, client) = git_with_install_failure(
            &scenario.source,
            r#"case " $* " in
  *" update-ref refs/heads/main "*)
    if mkdir "$marker" 2>/dev/null; then
      "$real_git" "$@"
      printf 'external editor save\n' > "$root/a.txt"
      exit 0
    fi ;;
esac"#,
        );
        let target = client.open_repository(&scenario.source).await.unwrap();
        git_turn_changes::publish_selection(&scenario.store, &client, &target, "pending-save")
            .await
            .unwrap();
        assert!(injected.path().join("injected").exists());
        assert!(matches!(
            scenario.store.load_commit("pending-save").unwrap().state,
            TurnCommitState::Recovering { .. }
        ));
        if legacy {
            // Reproduce the JSON written by the previous release, keeping the real journal.
            let mut record = scenario.store.load_commit("pending-save").unwrap();
            record.state = TurnCommitState::Conflict {
                paths: vec!["a.txt".into()],
                message: "checkout conflict".into(),
            };
            scenario
                .store
                .connection()
                .unwrap()
                .execute(
                    "UPDATE turn_commits SET record_json = ?1 WHERE commit_id = ?2",
                    rusqlite::params![serde_json::to_string(&record).unwrap(), record.commit_id],
                )
                .unwrap();
        }
        let store_path = scenario.store.path().to_owned();
        drop(scenario.store);
        let reopened = SqliteTurnChangeStore::open(store_path).unwrap();
        let journal = target
            .common_dir()
            .join("ash/commit-transactions/pending-save.json");
        let (guard, recovery) = git_with_install_failure(
            &scenario.source,
            r#"case " $* " in
  *" update-ref refs/heads/main "*) printf 'ref republished\n' > "$marker"; exit 74 ;;
esac"#,
        );
        for _ in 0..2 {
            git_turn_changes::publish_selection(&reopened, &recovery, &target, "pending-save")
                .await
                .unwrap();
            assert_eq!(
                std::fs::read_to_string(scenario.source.join("a.txt")).unwrap(),
                "external editor save\n"
            );
            assert_eq!(git(&scenario.source, &["rev-parse", "HEAD"]), published);
            assert_eq!(
                reopened.load_commit("pending-save").unwrap().state,
                TurnCommitState::Recovering {
                    paths: vec!["a.txt".into()],
                    error: None
                }
            );
            assert!(journal.exists());
        }
        assert!(
            reopened
                .queue_publication("duplicate", "queue-duplicate", "duplicate", "{}")
                .is_err()
        );
        assert!(
            git_turn_changes::require_settled_publications(
                &reopened.list_commits(&capture.thread_id).unwrap()
            )
            .is_err()
        );
        // Even a missing journal or an external ref reset cannot authorize re-publication.
        let saved_journal = std::fs::read(&journal).unwrap();
        std::fs::remove_file(&journal).unwrap();
        assert!(
            git_turn_changes::publish_selection(&reopened, &recovery, &target, "pending-save")
                .await
                .unwrap_err()
                .contains("refusing to publish again")
        );
        std::fs::write(&journal, saved_journal).unwrap();
        git(
            &scenario.source,
            &["update-ref", "refs/heads/main", &base_head, &published],
        );
        git_turn_changes::publish_selection(&reopened, &recovery, &target, "pending-save")
            .await
            .unwrap();
        assert_eq!(git(&scenario.source, &["rev-parse", "HEAD"]), base_head);
        assert!(journal.exists());
        assert_eq!(
            std::fs::read_to_string(scenario.source.join("a.txt")).unwrap(),
            "external editor save\n"
        );
        git(
            &scenario.source,
            &["update-ref", "refs/heads/main", &published, &base_head],
        );
        // The editor's owner resolves the blocking save; recovery may now finish the same object.
        std::fs::write(scenario.source.join("a.txt"), original).unwrap();
        git_turn_changes::publish_selection(&reopened, &recovery, &target, "pending-save")
            .await
            .unwrap();
        assert!(!guard.path().join("injected").exists());
        assert_eq!(git(&scenario.source, &["rev-list", "--count", "HEAD"]), "2");
        assert_eq!(git(&scenario.source, &["rev-parse", "HEAD"]), published);
        assert_eq!(git(&scenario.source, &["show", ":a.txt"]), "sealed");
        assert!(matches!(
            reopened.load_commit("pending-save").unwrap().state,
            TurnCommitState::Committed { .. }
        ));
        assert!(!journal.exists());
        assert!(
            git(
                &scenario.source,
                &["for-each-ref", "refs/ash/commit-transactions"]
            )
            .is_empty()
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn prepublication_conflict_without_a_journal_stays_terminal_after_reopen() {
    let scenario = Scenario::new();
    let checkout = scenario.checkout("session");
    let repository = scenario.git.open_repository(&checkout).await.unwrap();
    let before = scenario
        .git
        .capture_worktree_tree(&repository)
        .await
        .unwrap();
    std::fs::write(checkout.join("a.txt"), "sealed\n").unwrap();
    let capture = scenario
        .capture(&checkout, "session", "turn", &before)
        .await;
    scenario
        .prepare(
            &[capture.clone()],
            &[selection(&capture, &["a.txt"])],
            "pre-conflict",
        )
        .await;
    std::fs::write(
        scenario.source.join("a.txt"),
        "incompatible external save\n",
    )
    .unwrap();
    scenario.publish("pre-conflict").await;
    let conflict = scenario.store.load_commit("pre-conflict").unwrap();
    assert!(matches!(conflict.state, TurnCommitState::Conflict { .. }));
    let head = git(&scenario.source, &["rev-parse", "HEAD"]);
    let path = scenario.store.path().to_owned();
    drop(scenario.store);
    let reopened = SqliteTurnChangeStore::open(path).unwrap();
    let (guard, client) = git_with_install_failure(
        &scenario.source,
        r#"case " $* " in
  *" update-ref refs/heads/main "*) printf 'ref republished\n' > "$marker"; exit 74 ;;
esac"#,
    );
    let target = client.open_repository(&scenario.source).await.unwrap();
    assert!(
        git_turn_changes::publish_selection(&reopened, &client, &target, "pre-conflict")
            .await
            .unwrap()
            .is_empty()
    );
    assert!(!guard.path().join("injected").exists());
    assert_eq!(reopened.load_commit("pre-conflict").unwrap(), conflict);
    assert_eq!(git(&scenario.source, &["rev-parse", "HEAD"]), head);
    assert_eq!(
        std::fs::read_to_string(scenario.source.join("a.txt")).unwrap(),
        "incompatible external save\n"
    );
    assert!(
        !target
            .common_dir()
            .join("ash/commit-transactions/pre-conflict.json")
            .exists()
    );
}
