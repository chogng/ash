use crate::GitClient;
use crate::GitTreeChangeKind;
use crate::GitTreeId;
use crate::GitTreeReplayResult;
use crate::test_support::TestRepository;

#[tokio::test]
async fn selection_preserves_rename_delete_binary_and_mode_without_reading_later_edits() {
    let fixture = TestRepository::init();
    fixture.write("old.txt", "rename this file\n");
    fixture.write("delete.txt", "delete me\n");
    fixture.write("keep.txt", "baseline\n");
    fixture.write("exec.sh", "echo unchanged\n");
    std::fs::write(fixture.path("binary.bin"), [0, 1, 2]).unwrap();
    fixture.commit_all("baseline");
    let git = GitClient::system();
    let repository = git.open_repository(fixture.root()).await.unwrap();
    let before = git
        .resolve_tree(&repository, &fixture.git(&["rev-parse", "HEAD"]))
        .await
        .unwrap();
    std::fs::rename(fixture.path("old.txt"), fixture.path("new-name.txt")).unwrap();
    std::fs::remove_file(fixture.path("delete.txt")).unwrap();
    fixture.write("new.txt", "sealed new contents\n");
    fixture.write("keep.txt", "not selected\n");
    std::fs::write(fixture.path("binary.bin"), [0, 4, 5]).unwrap();
    fixture.git(&["add", "--all"]);
    fixture.git(&["update-index", "--chmod=+x", "exec.sh"]);
    let after = GitTreeId::new(fixture.git(&["write-tree"])).unwrap();
    fixture.write("new.txt", "later edits must stay out\n");
    let status = fixture.git_raw(&["status", "--porcelain"]);
    let selected = git
        .select_tree_changes(
            &repository,
            &before,
            &after,
            &[
                "new-name.txt".into(),
                "delete.txt".into(),
                "binary.bin".into(),
                "exec.sh".into(),
                "new.txt".into(),
            ],
        )
        .await
        .unwrap();
    assert_eq!(fixture.git_raw(&["status", "--porcelain"]), status);
    assert_eq!(
        fixture.git(&["show", &format!("{}:new.txt", selected.as_str())]),
        "sealed new contents"
    );
    assert_eq!(
        fixture.git(&["show", &format!("{}:keep.txt", selected.as_str())]),
        "baseline"
    );
    let changes = git
        .diff_trees(&repository, &before, &selected)
        .await
        .unwrap();
    assert_eq!(changes.len(), 5);
    let renamed = changes
        .iter()
        .find(|change| change.path() == std::path::Path::new("new-name.txt"))
        .unwrap();
    assert_eq!(renamed.kind(), GitTreeChangeKind::Renamed);
    assert_eq!(
        renamed.previous_path(),
        Some(std::path::Path::new("old.txt"))
    );
    assert!(
        changes
            .iter()
            .any(|change| change.kind() == GitTreeChangeKind::Deleted)
    );
    let binary = changes.iter().find(|change| change.binary()).unwrap();
    assert_eq!(
        git.read_blob(&repository, binary.after_object_id().unwrap(), 10)
            .await
            .unwrap(),
        (vec![0, 4, 5], false)
    );
    let executable = changes
        .iter()
        .find(|change| change.path() == std::path::Path::new("exec.sh"))
        .unwrap();
    assert_eq!(executable.before_mode(), Some("100644"));
    assert_eq!(executable.after_mode(), Some("100755"));
    assert!(
        git.select_tree_changes(&repository, &before, &after, &[])
            .await
            .is_err()
    );
    assert!(
        git.select_tree_changes(
            &repository,
            &before,
            &after,
            &["new.txt".into(), "new.txt".into()]
        )
        .await
        .is_err()
    );
    assert!(
        git.select_tree_changes(&repository, &before, &after, &["../outside".into()])
            .await
            .is_err()
    );
}

#[tokio::test]
async fn replay_merges_separate_text_edits_and_returns_paths_for_overlapping_edits() {
    let fixture = TestRepository::init();
    fixture.write(
        "same.txt",
        "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
    );
    fixture.commit_all("baseline");
    let git = GitClient::system();
    let repository = git.open_repository(fixture.root()).await.unwrap();
    let before = git.capture_worktree_tree(&repository).await.unwrap();
    fixture.write(
        "same.txt",
        "A\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
    );
    let a = git.capture_worktree_tree(&repository).await.unwrap();
    fixture.write(
        "same.txt",
        "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nB\n",
    );
    let b = git.capture_worktree_tree(&repository).await.unwrap();
    let GitTreeReplayResult::Clean(merged) = git
        .replay_tree_delta(&repository, &before, &a, &b)
        .await
        .unwrap()
    else {
        panic!("separate edits should merge");
    };
    assert_eq!(
        fixture.git(&["show", &format!("{}:same.txt", merged.as_str())]),
        "A\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nB"
    );
    fixture.write(
        "same.txt",
        "C\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
    );
    let c = git.capture_worktree_tree(&repository).await.unwrap();
    assert_eq!(
        git.replay_tree_delta(&repository, &before, &a, &c)
            .await
            .unwrap(),
        GitTreeReplayResult::Conflict {
            paths: vec!["same.txt".into()]
        }
    );
}

#[tokio::test]
async fn retained_object_reads_survive_linked_checkout_removal_and_gc() {
    let fixture = TestRepository::init();
    fixture.write("file.txt", "base\n");
    fixture.commit_all("base");
    let directory = tempfile::tempdir().unwrap();
    let checkout = directory.path().join("checkout");
    fixture.git(&[
        "worktree",
        "add",
        "--detach",
        checkout.to_str().unwrap(),
        "HEAD",
    ]);
    let client = GitClient::system();
    let repository = client.open_repository(&checkout).await.unwrap();
    let before = client.capture_worktree_tree(&repository).await.unwrap();
    std::fs::write(checkout.join("file.txt"), "retained\n").unwrap();
    let after = client.capture_worktree_tree(&repository).await.unwrap();
    client
        .pin_private_ref(
            &repository,
            &crate::GitPrivateRef::new("refs/ash/changes/retained/after".into()).unwrap(),
            &after,
        )
        .await
        .unwrap();
    fixture.git(&["worktree", "remove", "--force", checkout.to_str().unwrap()]);
    fixture.git(&["gc", "--prune=now"]);
    let files = client
        .diff_trees_at_git_dir(repository.common_dir(), &before, &after)
        .await
        .unwrap();
    assert_eq!(files.len(), 1);
    let (bytes, truncated) = client
        .read_blob_at_git_dir(
            repository.common_dir(),
            files[0].after_object_id().unwrap(),
            512,
        )
        .await
        .unwrap();
    assert_eq!(bytes, b"retained\n");
    assert!(!truncated);
    let patch = client
        .diff_tree_text_at_git_dir(repository.common_dir(), &before, &after, 512)
        .await
        .unwrap();
    assert!(patch.text().contains("+retained"));
    assert!(!patch.truncated());
    assert!(
        client
            .read_blob_at_git_dir(repository.common_dir(), &"0".repeat(40), 512)
            .await
            .is_err()
    );
}
