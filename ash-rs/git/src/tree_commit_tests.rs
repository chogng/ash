use super::{CheckoutJournal, CommitJournal, journal_path, write_journal};
use crate::GitClient;
use crate::GitDetachedWorktreeRequest;
use crate::GitPrepareTreeCommitResult;
use crate::GitPreparedTreeCommitRequest;
use crate::GitTreeCommitConflict;
use crate::GitTreeCommitRecovery;
use crate::GitTreeCommitRequest;
use crate::GitTreeCommitResult;
use crate::GitTreeId;
use crate::GitWorktreeRemovalMode;
use crate::test_support::TestRepository;

fn tree(repository: &TestRepository, revision: &str) -> GitTreeId {
    GitTreeId::new(repository.git(&["rev-parse", &format!("{revision}^{{tree}}")]))
        .expect("valid tree")
}

#[tokio::test]
async fn tree_commit_preserves_staged_unstaged_and_untracked_layers() {
    let fixture = TestRepository::init();
    fixture.write("change.txt", "base\n");
    fixture.write("staged.txt", "base\n");
    fixture.write("unstaged.txt", "base\n");
    fixture.commit_all("base");
    let base_head = fixture.git(&["rev-parse", "HEAD"]);
    let before = tree(&fixture, "HEAD");

    fixture.write("change.txt", "from turn A\n");
    fixture.git(&["add", "change.txt"]);
    let after = GitTreeId::new(fixture.git(&["write-tree"])).expect("Turn tree");
    fixture.git(&["reset", "--hard", "HEAD"]);

    fixture.write("staged.txt", "staged local\n");
    fixture.git(&["add", "staged.txt"]);
    fixture.write("unstaged.txt", "unstaged local\n");
    fixture.write("untracked.txt", "untracked local\n");
    let client = GitClient::system();
    let repository = client
        .open_repository(fixture.root())
        .await
        .expect("open repository");

    let result = client
        .commit_tree_delta(
            &repository,
            &GitTreeCommitRequest::new(
                "preserve-layers".into(),
                "main".into(),
                base_head,
                before,
                after,
                "feat: commit sealed Turn A".into(),
            )
            .expect("request"),
        )
        .await
        .expect("commit immutable tree");
    assert!(matches!(result, GitTreeCommitResult::Committed { .. }));
    assert_eq!(fixture.read("change.txt"), "from turn A\n");
    assert_eq!(fixture.read("staged.txt"), "staged local\n");
    assert_eq!(fixture.read("unstaged.txt"), "unstaged local\n");
    assert_eq!(fixture.read("untracked.txt"), "untracked local\n");
    assert_eq!(
        fixture.git_raw(&["status", "--short"]),
        "M  staged.txt\n M unstaged.txt\n?? untracked.txt\n"
    );
    assert_eq!(fixture.git(&["show", "HEAD:change.txt"]), "from turn A");
}

#[tokio::test]
async fn tree_commit_reports_replay_conflict_without_moving_target() {
    let fixture = TestRepository::init();
    fixture.write("same.txt", "base\n");
    fixture.commit_all("base");
    let before = tree(&fixture, "HEAD");

    fixture.write("same.txt", "from turn A\n");
    fixture.git(&["add", "same.txt"]);
    let after = GitTreeId::new(fixture.git(&["write-tree"])).expect("Turn tree");
    fixture.git(&["reset", "--hard", "HEAD"]);
    fixture.write("same.txt", "branch advanced\n");
    fixture.commit_all("advance target");
    let expected_head = fixture.git(&["rev-parse", "HEAD"]);

    let client = GitClient::system();
    let repository = client
        .open_repository(fixture.root())
        .await
        .expect("open repository");
    let result = client
        .commit_tree_delta(
            &repository,
            &GitTreeCommitRequest::new(
                "replay-conflict".into(),
                "main".into(),
                expected_head.clone(),
                before,
                after,
                "fix: replay sealed change".into(),
            )
            .expect("request"),
        )
        .await
        .expect("conflict outcome");
    assert_eq!(
        result,
        GitTreeCommitResult::Conflict(GitTreeCommitConflict::ChangeSet {
            paths: vec!["same.txt".into()]
        })
    );
    assert_eq!(fixture.git(&["rev-parse", "HEAD"]), expected_head);
    assert_eq!(fixture.read("same.txt"), "branch advanced\n");
}

#[tokio::test]
async fn immutable_deltas_reconstruct_only_committed_turns_for_managed_discard() {
    let fixture = TestRepository::init();
    fixture.write(".gitignore", "ignored.log\n");
    fixture.write("base.txt", "base\n");
    fixture.commit_all("base");
    let baseline = tree(&fixture, "HEAD");
    let client = GitClient::system();
    let repository = client
        .open_repository(fixture.root())
        .await
        .expect("open repository");

    fixture.write("a.txt", "committed A\n");
    let after_a = client
        .capture_worktree_tree(&repository)
        .await
        .expect("capture A");
    fixture.write("b.txt", "discard B\n");
    let before_c = client
        .capture_worktree_tree(&repository)
        .await
        .expect("capture B");
    fixture.write("c.txt", "committed C\n");
    let after_c = client
        .capture_worktree_tree(&repository)
        .await
        .expect("capture C");

    let desired = client
        .compose_tree_delta(&repository, &baseline, &baseline, &after_a)
        .await
        .expect("compose A");
    let desired = client
        .compose_tree_delta(&repository, &before_c, &desired, &after_c)
        .await
        .expect("compose C");
    fixture.write("untracked.txt", "discard me\n");
    fixture.write("ignored.log", "keep me\n");
    client
        .replace_managed_worktree_tree(&repository, &desired)
        .await
        .expect("replace managed checkout");

    assert_eq!(fixture.read("a.txt"), "committed A\n");
    assert_eq!(fixture.read("c.txt"), "committed C\n");
    assert!(!fixture.path("b.txt").exists());
    assert!(!fixture.path("untracked.txt").exists());
    assert_eq!(fixture.read("ignored.log"), "keep me\n");
}

#[tokio::test]
async fn interrupted_ref_update_resumes_checkout_installation_from_journal() {
    let fixture = TestRepository::init();
    fixture.write("change.txt", "base\n");
    fixture.commit_all("base");
    let old_head = fixture.git(&["rev-parse", "HEAD"]);
    let before = tree(&fixture, "HEAD");
    fixture.write("change.txt", "sealed Turn\n");
    fixture.git(&["add", "change.txt"]);
    let after = GitTreeId::new(fixture.git(&["write-tree"])).expect("after tree");
    fixture.git(&["reset", "--hard", &old_head]);
    let client = GitClient::system();
    let repository = client.open_repository(fixture.root()).await.unwrap();
    let result = client
        .commit_tree_delta(
            &repository,
            &GitTreeCommitRequest::new(
                "journal-source".into(),
                "main".into(),
                old_head.clone(),
                before.clone(),
                after.clone(),
                "feat: sealed Turn".into(),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let GitTreeCommitResult::Committed { object_id } = result else {
        panic!("commit did not complete");
    };
    fixture.git(&["reset", "--hard", &old_head]);
    write_journal(
        &journal_path(&repository, "interrupted-install").unwrap(),
        &CommitJournal {
            version: 2,
            target_ref: "refs/heads/main".into(),
            old_head: Some(old_head.clone()),
            new_head: object_id.clone(),
            checkout: Some(CheckoutJournal {
                root: fixture.root().to_path_buf(),
                original_index: before.as_str().into(),
                original_worktree: before.as_str().into(),
                desired_index: after.as_str().into(),
                desired_worktree: after.as_str().into(),
            }),
            retain_until_acknowledged: false,
        },
    )
    .unwrap();
    fixture.git(&["update-ref", "refs/heads/main", &object_id, &old_head]);

    assert_eq!(
        client
            .recover_tree_commit(&repository, "interrupted-install")
            .await
            .unwrap(),
        GitTreeCommitRecovery::Committed {
            object_id: object_id.clone()
        }
    );
    assert_eq!(fixture.read("change.txt"), "sealed Turn\n");
    assert_eq!(fixture.git(&["rev-parse", "HEAD"]), object_id);
    assert!(
        !journal_path(&repository, "interrupted-install")
            .unwrap()
            .exists()
    );
}

#[tokio::test]
async fn tree_commit_creates_the_first_commit_on_an_unborn_branch() {
    let fixture = TestRepository::init();
    let client = GitClient::system();
    let repository = client.open_repository(fixture.root()).await.unwrap();
    let before = client.empty_tree(&repository).await.unwrap();
    fixture.write("first.txt", "first Turn\n");
    let after = client.capture_worktree_tree(&repository).await.unwrap();
    std::fs::remove_file(fixture.path("first.txt")).unwrap();

    let result = client
        .commit_tree_delta(
            &repository,
            &GitTreeCommitRequest::new_unborn(
                "unborn-first-commit".into(),
                "main".into(),
                before,
                after,
                "feat: create first commit".into(),
            )
            .unwrap(),
        )
        .await
        .unwrap();

    assert!(matches!(result, GitTreeCommitResult::Committed { .. }));
    assert_eq!(fixture.git(&["rev-list", "--count", "main"]), "1");
    assert_eq!(fixture.read("first.txt"), "first Turn\n");
    assert_eq!(fixture.git(&["show", "main:first.txt"]), "first Turn");
}

#[tokio::test]
async fn prepared_commit_is_deterministic_and_does_not_move_or_rewrite_the_checkout() {
    let fixture = TestRepository::init();
    fixture.write("change.txt", "base\n");
    fixture.write("staged.txt", "base\n");
    fixture.write("unstaged.txt", "base\n");
    fixture.commit_all("base");
    let base_head = fixture.git(&["rev-parse", "HEAD"]);
    let target_tree = tree(&fixture, "HEAD");

    fixture.write("change.txt", "verified\n");
    fixture.git(&["add", "change.txt"]);
    let final_tree = GitTreeId::new(fixture.git(&["write-tree"])).unwrap();
    fixture.git(&["reset", "--hard", &base_head]);
    fixture.write("staged.txt", "staged local\n");
    fixture.git(&["add", "staged.txt"]);
    fixture.write("unstaged.txt", "unstaged local\n");
    fixture.write("untracked.txt", "untracked local\n");

    let client = GitClient::system();
    let repository = client.open_repository(fixture.root()).await.unwrap();
    let request = GitPreparedTreeCommitRequest::new(
        "deterministic-prepare".into(),
        "main".into(),
        base_head.clone(),
        target_tree,
        final_tree,
        "feat: integrate verified result".into(),
    )
    .unwrap();
    let first = client
        .prepare_tree_commit(&repository, &request)
        .await
        .unwrap();
    let second = client
        .prepare_tree_commit(&repository, &request)
        .await
        .unwrap();
    let GitPrepareTreeCommitResult::Prepared(first) = first else {
        panic!("first preparation conflicted");
    };
    let GitPrepareTreeCommitResult::Prepared(second) = second else {
        panic!("second preparation conflicted");
    };

    assert_eq!(first.object_id(), second.object_id());
    assert_eq!(fixture.git(&["rev-parse", "HEAD"]), base_head);
    assert_eq!(fixture.read("change.txt"), "base\n");
    assert_eq!(fixture.read("staged.txt"), "staged local\n");
    assert_eq!(fixture.read("unstaged.txt"), "unstaged local\n");
    assert_eq!(fixture.read("untracked.txt"), "untracked local\n");
    assert_eq!(
        fixture.git_raw(&["status", "--short"]),
        "M  staged.txt\n M unstaged.txt\n?? untracked.txt\n"
    );

    let result = client
        .publish_prepared_tree_commit(&repository, &first)
        .await
        .unwrap();
    assert_eq!(
        result,
        GitTreeCommitResult::Committed {
            object_id: first.object_id().to_string()
        }
    );
    assert_eq!(
        client
            .recover_tree_commit(&repository, "deterministic-prepare")
            .await
            .unwrap(),
        GitTreeCommitRecovery::Committed {
            object_id: first.object_id().to_string()
        }
    );
    assert!(
        journal_path(&repository, "deterministic-prepare")
            .unwrap()
            .exists()
    );
    client
        .acknowledge_published_tree_commit(&repository, "deterministic-prepare", first.object_id())
        .await
        .unwrap();
    assert!(
        !journal_path(&repository, "deterministic-prepare")
            .unwrap()
            .exists()
    );
    assert_eq!(fixture.read("change.txt"), "verified\n");
    assert_eq!(fixture.read("staged.txt"), "staged local\n");
    assert_eq!(fixture.read("unstaged.txt"), "unstaged local\n");
    assert_eq!(fixture.read("untracked.txt"), "untracked local\n");
    assert_eq!(
        fixture.git_raw(&["status", "--short"]),
        "M  staged.txt\n M unstaged.txt\n?? untracked.txt\n"
    );
}

#[tokio::test]
async fn every_repository_can_prepare_before_any_target_is_published() {
    let first = TestRepository::init();
    let second = TestRepository::init();
    first.write("first.txt", "base\n");
    second.write("second.txt", "base\n");
    first.commit_all("base");
    second.commit_all("base");
    let first_head = first.git(&["rev-parse", "HEAD"]);
    let second_head = second.git(&["rev-parse", "HEAD"]);
    let first_target = tree(&first, "HEAD");
    let second_target = tree(&second, "HEAD");

    first.write("first.txt", "verified first\n");
    second.write("second.txt", "verified second\n");
    let client = GitClient::system();
    let first_repository = client.open_repository(first.root()).await.unwrap();
    let second_repository = client.open_repository(second.root()).await.unwrap();
    let first_final = client
        .capture_worktree_tree(&first_repository)
        .await
        .unwrap();
    let second_final = client
        .capture_worktree_tree(&second_repository)
        .await
        .unwrap();
    first.git(&["reset", "--hard", &first_head]);
    second.git(&["reset", "--hard", &second_head]);

    let first_prepared = client
        .prepare_tree_commit(
            &first_repository,
            &GitPreparedTreeCommitRequest::new(
                "prepare-first-root".into(),
                "main".into(),
                first_head.clone(),
                first_target,
                first_final,
                "feat: integrate first root".into(),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let second_prepared = client
        .prepare_tree_commit(
            &second_repository,
            &GitPreparedTreeCommitRequest::new(
                "prepare-second-root".into(),
                "main".into(),
                second_head.clone(),
                second_target,
                second_final,
                "feat: integrate second root".into(),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let GitPrepareTreeCommitResult::Prepared(first_prepared) = first_prepared else {
        panic!("first root preparation conflicted");
    };
    let GitPrepareTreeCommitResult::Prepared(second_prepared) = second_prepared else {
        panic!("second root preparation conflicted");
    };

    assert_eq!(first.git(&["rev-parse", "main"]), first_head);
    assert_eq!(second.git(&["rev-parse", "main"]), second_head);

    assert!(matches!(
        client
            .publish_prepared_tree_commit(&first_repository, &first_prepared)
            .await
            .unwrap(),
        GitTreeCommitResult::Committed { .. }
    ));
    assert!(matches!(
        client
            .publish_prepared_tree_commit(&second_repository, &second_prepared)
            .await
            .unwrap(),
        GitTreeCommitResult::Committed { .. }
    ));
    assert_eq!(first.read("first.txt"), "verified first\n");
    assert_eq!(second.read("second.txt"), "verified second\n");
}

#[tokio::test]
async fn prepared_commit_refuses_publication_after_the_target_moves() {
    let fixture = TestRepository::init();
    fixture.write("change.txt", "base\n");
    fixture.commit_all("base");
    let base_head = fixture.git(&["rev-parse", "HEAD"]);
    let target_tree = tree(&fixture, "HEAD");
    fixture.write("change.txt", "verified\n");
    fixture.git(&["add", "change.txt"]);
    let final_tree = GitTreeId::new(fixture.git(&["write-tree"])).unwrap();
    fixture.git(&["reset", "--hard", &base_head]);

    let client = GitClient::system();
    let repository = client.open_repository(fixture.root()).await.unwrap();
    let prepared = client
        .prepare_tree_commit(
            &repository,
            &GitPreparedTreeCommitRequest::new(
                "target-moved-after-prepare".into(),
                "main".into(),
                base_head,
                target_tree,
                final_tree,
                "feat: integrate verified result".into(),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let GitPrepareTreeCommitResult::Prepared(prepared) = prepared else {
        panic!("preparation conflicted");
    };
    fixture.write("other.txt", "concurrent change\n");
    fixture.commit_all("advance target");
    let advanced_head = fixture.git(&["rev-parse", "HEAD"]);

    assert_eq!(
        client
            .publish_prepared_tree_commit(&repository, &prepared)
            .await
            .unwrap(),
        GitTreeCommitResult::Conflict(GitTreeCommitConflict::TargetMoved)
    );
    assert_eq!(fixture.git(&["rev-parse", "HEAD"]), advanced_head);
    assert_eq!(fixture.read("change.txt"), "base\n");
    assert_eq!(fixture.read("other.txt"), "concurrent change\n");
}

#[tokio::test]
async fn tree_commit_rejects_a_detached_source_checkout() {
    let fixture = TestRepository::init();
    fixture.write("same.txt", "base\n");
    fixture.commit_all("base");
    let base_head = fixture.git(&["rev-parse", "HEAD"]);
    let before = tree(&fixture, "HEAD");
    fixture.write("same.txt", "sealed Turn\n");
    fixture.git(&["add", "same.txt"]);
    let after = GitTreeId::new(fixture.git(&["write-tree"])).unwrap();
    fixture.git(&["reset", "--hard", &base_head]);
    fixture.git(&["checkout", "--detach", &base_head]);

    let client = GitClient::system();
    let repository = client.open_repository(fixture.root()).await.unwrap();
    let result = client
        .commit_tree_delta(
            &repository,
            &GitTreeCommitRequest::new(
                "detached-source".into(),
                "main".into(),
                base_head.clone(),
                before,
                after,
                "feat: sealed Turn".into(),
            )
            .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(
        result,
        GitTreeCommitResult::Conflict(GitTreeCommitConflict::TargetDetached)
    );
    assert_eq!(fixture.git(&["rev-parse", "main"]), base_head);
    assert_eq!(fixture.read("same.txt"), "base\n");
}

#[tokio::test]
async fn committing_sealed_turn_a_does_not_touch_running_turn_b_on_the_same_file() {
    let fixture = TestRepository::init();
    fixture.write("same.txt", "base\n");
    fixture.commit_all("base");
    let base_head = fixture.git(&["rev-parse", "HEAD"]);
    let before_a = tree(&fixture, "HEAD");
    fixture.write("same.txt", "sealed A\n");
    fixture.git(&["add", "same.txt"]);
    let after_a = GitTreeId::new(fixture.git(&["write-tree"])).unwrap();
    fixture.git(&["reset", "--hard", &base_head]);

    let client = GitClient::system();
    let source = client.open_repository(fixture.root()).await.unwrap();
    let managed_parent = tempfile::tempdir().unwrap();
    let managed_root = managed_parent.path().join("thread-b");
    let thread = client
        .create_detached_worktree(
            &source,
            &GitDetachedWorktreeRequest::new(managed_root.clone(), base_head.clone()).unwrap(),
        )
        .await
        .unwrap();
    client
        .install_worktree_tree(&thread, &after_a)
        .await
        .unwrap();
    std::fs::write(managed_root.join("same.txt"), "running B\n").unwrap();
    let running_b = client.capture_worktree_tree(&thread).await.unwrap();

    let result = client
        .commit_tree_delta(
            &source,
            &GitTreeCommitRequest::new(
                "same-file-isolation".into(),
                "main".into(),
                base_head,
                before_a,
                after_a,
                "feat: commit A".into(),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    assert!(matches!(result, GitTreeCommitResult::Committed { .. }));
    assert_eq!(fixture.read("same.txt"), "sealed A\n");
    assert_eq!(
        std::fs::read_to_string(managed_root.join("same.txt")).unwrap(),
        "running B\n"
    );
    assert_eq!(
        client.capture_worktree_tree(&thread).await.unwrap(),
        running_b
    );
    client
        .remove_linked_worktree(
            &source,
            &managed_root,
            GitWorktreeRemovalMode::DiscardVerifiedContents,
        )
        .await
        .unwrap();
}
