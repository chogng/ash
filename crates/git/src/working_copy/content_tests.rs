use std::path::Path;

use super::GitChangeFileComparison;
use super::GitConflictChoice;
use super::GitFileRevision;
use crate::GitClient;
use crate::test_support::TestRepository;

#[tokio::test]
async fn reads_head_and_index_content_and_reports_missing_paths() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "head\n");
    repository.git(&["add", "tracked.txt"]);
    repository.git(&["commit", "-m", "initial"]);
    repository.write("tracked.txt", "index\n");
    repository.git(&["add", "tracked.txt"]);

    let client = GitClient::system();
    let opened = client.open_repository(repository.root()).await.unwrap();

    assert_eq!(
        client
            .read_file_at_revision(
                &opened,
                Path::new("tracked.txt"),
                GitFileRevision::Head,
                1024,
            )
            .await
            .unwrap(),
        Some(b"head\n".to_vec())
    );
    assert_eq!(
        client
            .read_file_at_revision(
                &opened,
                Path::new("tracked.txt"),
                GitFileRevision::Index,
                1024,
            )
            .await
            .unwrap(),
        Some(b"index\n".to_vec())
    );
    assert_eq!(
        client
            .read_file_at_revision(
                &opened,
                Path::new("missing.txt"),
                GitFileRevision::Head,
                1024,
            )
            .await
            .unwrap(),
        None
    );
    let head = repository.git(&["rev-parse", "HEAD"]);
    let tree = client.resolve_tree(&opened, &head).await.unwrap();
    repository.write("tracked.txt", "later worktree\n");
    assert_eq!(
        client
            .read_file_at_tree(&opened, &tree, Path::new("tracked.txt"), 1024)
            .await
            .unwrap(),
        Some(b"head\n".to_vec())
    );
}

#[tokio::test]
async fn reads_staged_and_unstaged_change_sides_without_collapsing_the_index() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "head\n");
    repository.commit_all("initial");
    repository.write("tracked.txt", "index\n");
    repository.git(&["add", "tracked.txt"]);
    repository.write("tracked.txt", "worktree\n");

    let client = GitClient::system();
    let opened = client.open_repository(repository.root()).await.unwrap();
    let snapshot = client.snapshot(&opened).await.unwrap();
    let change = &snapshot.changes()[0];

    let staged = client
        .change_file(&opened, change, GitChangeFileComparison::Staged, 1024)
        .await
        .unwrap();
    assert_eq!(staged.original(), Some(b"head\n".as_slice()));
    assert_eq!(staged.modified(), Some(b"index\n".as_slice()));

    let unstaged = client
        .change_file(&opened, change, GitChangeFileComparison::Unstaged, 1024)
        .await
        .unwrap();
    assert_eq!(unstaged.original(), Some(b"index\n".as_slice()));
    assert_eq!(unstaged.modified(), Some(b"worktree\n".as_slice()));
}

#[tokio::test]
async fn reads_three_unmerged_index_stages_and_worktree_result() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "base\n");
    repository.commit_all("base");
    repository.git(&["switch", "-c", "topic"]);
    repository.write("tracked.txt", "incoming\n");
    repository.commit_all("incoming");
    repository.git(&["switch", "main"]);
    repository.write("tracked.txt", "current\n");
    repository.commit_all("current");
    let output = std::process::Command::new("git")
        .args(["merge", "topic"])
        .current_dir(repository.root())
        .output()
        .unwrap();
    assert!(!output.status.success());

    let client = GitClient::system();
    let opened = client.open_repository(repository.root()).await.unwrap();
    let snapshot = client.snapshot(&opened).await.unwrap();
    let change = snapshot
        .changes()
        .iter()
        .find(|change| change.path() == Path::new("tracked.txt"))
        .unwrap();
    let file = client.conflict_file(&opened, change, 1024).await.unwrap();
    assert_eq!(file.base(), Some(b"base\n".as_slice()));
    assert_eq!(file.current(), Some(b"current\n".as_slice()));
    assert_eq!(file.incoming(), Some(b"incoming\n".as_slice()));
    assert!(file.stage_ids().iter().all(Option::is_some));
    assert!(file.result().unwrap().starts_with(b"<<<<<<<"));
}

#[tokio::test]
async fn reads_deleted_stage_and_can_choose_deletion() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "base\n");
    repository.commit_all("base");
    repository.git(&["switch", "-c", "topic"]);
    repository.git(&["rm", "tracked.txt"]);
    repository.commit_all("delete");
    repository.git(&["switch", "main"]);
    repository.write("tracked.txt", "current\n");
    repository.commit_all("current");
    let output = std::process::Command::new("git")
        .args(["merge", "topic"])
        .current_dir(repository.root())
        .output()
        .unwrap();
    assert!(!output.status.success());

    let client = GitClient::system();
    let opened = client.open_repository(repository.root()).await.unwrap();
    let snapshot = client.snapshot(&opened).await.unwrap();
    let change = snapshot
        .changes()
        .iter()
        .find(|change| change.path() == Path::new("tracked.txt"))
        .unwrap();
    let file = client.conflict_file(&opened, change, 1024).await.unwrap();
    assert_eq!(file.current(), Some(b"current\n".as_slice()));
    assert_eq!(file.incoming(), None);
    assert_eq!(file.stage_ids()[2], None);
    client
        .choose_conflict_side(&opened, Path::new("tracked.txt"), GitConflictChoice::Delete)
        .await
        .unwrap();
    assert!(!repository.root().join("tracked.txt").exists());
    assert!(
        !client
            .snapshot(&opened)
            .await
            .unwrap()
            .changes()
            .iter()
            .any(|change| change.is_conflicted())
    );
}
